// Efficienza: le regole PURE, senza AWS. Dicono quanto della capacità pagata si usa davvero e quali
// leve recuperano soldi; la raccolta (`ecs.js`, `rds.js`) porta i numeri, qui si decide.
//
// Ogni soglia è una scelta di prudenza dichiarata qui sotto, mai una riga per nome di risorsa: la
// stessa regola vale per qualunque flotta, e un servizio nuovo entra nei conti senza toccare niente.

// Margine sopra il picco: una taglia è giusta quando il p95 dell'uso resta sotto il 60% della taglia.
// Il 40% che avanza assorbe i picchi sopra il p95 e una crescita normale senza riscalare il giorno dopo.
export const MARGINE = 0.6
// Sotto il 5% di risparmio un cambio di taglia non vale il deploy e il rischio.
export const RISPARMIO_MINIMO = 0.05
// Ore in un mese medio: 365 * 24 / 12.
export const ORE_MESE = 730

// Le combinazioni CPU/memoria che Fargate accetta (unità CPU: 1024 = 1 vCPU; memoria in MiB). Sono un
// fatto di AWS, non una configurazione: una taglia fuori da questa tabella Fargate la rifiuta.
const passi = (da, a, passo) => Array.from({ length: (a - da) / passo + 1 }, (_, i) => da + i * passo)
export const TAGLIE_FARGATE = [
  ...[512, 1024, 2048].map((mem) => [256, mem]),
  ...passi(1024, 4096, 1024).map((mem) => [512, mem]),
  ...passi(2048, 8192, 1024).map((mem) => [1024, mem]),
  ...passi(4096, 16384, 1024).map((mem) => [2048, mem]),
  ...passi(8192, 30720, 1024).map((mem) => [4096, mem]),
  ...passi(16384, 61440, 4096).map((mem) => [8192, mem]),
  ...passi(32768, 122880, 8192).map((mem) => [16384, mem]),
]

// Costo orario di UN task: vCPU e GB al prezzo della regione, con la quota su Spot al suo prezzo.
// `prezzi` = { vcpu, gb, spotVcpu, spotGb } in USD all'ora; senza prezzi niente costo (null), non zero.
export function costoOraTask({ cpu, memMb, quotaSpot = 0 }, prezzi) {
  if (!prezzi?.vcpu || !prezzi?.gb || !cpu || !memMb) return null
  const vcpu = cpu / 1024
  const gb = memMb / 1024
  const pieno = vcpu * prezzi.vcpu + gb * prezzi.gb
  const spot = prezzi.spotVcpu && prezzi.spotGb ? vcpu * prezzi.spotVcpu + gb * prezzi.spotGb : pieno
  return pieno * (1 - quotaSpot) + spot * quotaSpot
}

// Quanti task finiscono su Fargate Spot con una capacity provider strategy: prima la `base` di ogni
// provider, poi il resto diviso per `weight`. Così fa ECS; una strategy assente vuol dire launch type
// semplice, quindi zero Spot. Ritorna la QUOTA (0..1) sul numero di task dato.
export function quotaSpot(strategia, task) {
  const n = Math.max(0, Math.round(task ?? 0))
  if (!Array.isArray(strategia) || !strategia.length || n === 0) return 0
  const isSpot = (p) => /SPOT/i.test(p?.capacityProvider ?? '')
  let restano = n
  let spot = 0
  for (const p of strategia) {
    const b = Math.min(restano, Math.max(0, p.base ?? 0))
    if (isSpot(p)) spot += b
    restano -= b
  }
  const pesi = strategia.reduce((s, p) => s + Math.max(0, p.weight ?? 0), 0)
  if (restano > 0 && pesi > 0) {
    const pesoSpot = strategia.filter(isSpot).reduce((s, p) => s + Math.max(0, p.weight ?? 0), 0)
    spot += (restano * pesoSpot) / pesi
  }
  return spot / n
}

// La taglia più economica che tiene il p95 di CPU e memoria sotto il MARGINE. `cpuP95` e `memP95` sono
// percentuali della taglia di adesso (come le dà AWS/ECS). Ritorna null quando la taglia è già giusta,
// quando i dati mancano o quando il risparmio è sotto RISPARMIO_MINIMO.
export function tagliaGiusta({ cpu, memMb, cpuP95, memP95 }, prezzi) {
  if (!cpu || !memMb || cpuP95 == null || memP95 == null || !prezzi?.vcpu || !prezzi?.gb) return null
  const serveCpu = (cpu * cpuP95) / 100 / MARGINE
  const serveMem = (memMb * memP95) / 100 / MARGINE
  const costo = ([c, m]) => (c / 1024) * prezzi.vcpu + (m / 1024) * prezzi.gb
  const adesso = costo([cpu, memMb])
  let meglio = null
  for (const t of TAGLIE_FARGATE) {
    if (t[0] < serveCpu || t[1] < serveMem) continue
    if (!meglio || costo(t) < costo(meglio)) meglio = t
  }
  if (!meglio || costo(meglio) > adesso * (1 - RISPARMIO_MINIMO)) return null
  return { cpu: meglio[0], memMb: meglio[1], risparmioOraTask: adesso - costo(meglio) }
}

// Percentile su una lista di numeri (interpolazione lineare). Vuoto → null.
export function percentile(valori, p) {
  const v = (valori ?? []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const i = (v.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return v[lo] + (v[hi] - v[lo]) * (i - lo)
}

// Settimana tipo: 168 celle (lunedì 00 UTC = 0) con la media dei valori orari che cadono in ognuna.
// `punti` = [[timestampMs, valore], …]. Una cella senza punti resta null: non si inventa uno zero.
export function settimanaTipo(punti) {
  const somme = new Array(168).fill(0)
  const conti = new Array(168).fill(0)
  for (const [t, v] of punti ?? []) {
    if (!Number.isFinite(v)) continue
    const d = new Date(t)
    const cella = ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours()
    somme[cella] += v
    conti[cella] += 1
  }
  return somme.map((s, i) => (conti[i] ? s / conti[i] : null))
}

// Ore ferme di un ambiente nella settimana tipo: quelle in cui il lavoro è sotto il 10% del suo picco.
// Il picco è il p95 delle celle, non il massimo, perché un'ora strana non sposti la soglia.
export const QUOTA_FERMO = 0.1
export function oreFerme(settimana) {
  const valide = (settimana ?? []).filter((v) => v != null)
  if (valide.length < 168 * 0.8) return { ore: 0, maschera: [] } // meno di una settimana vista: non si giudica
  const picco = percentile(valide, 0.95)
  if (!picco) return { ore: 0, maschera: [] }
  const maschera = settimana.map((v) => v != null && v < picco * QUOTA_FERMO)
  return { ore: maschera.filter(Boolean).length, maschera }
}
// Spegnere fuori orario ha senso da un minimo di ore ferme a settimana (un giorno intero).
export const ORE_FERME_MINIME = 24

// Task in più del minimo dell'autoscaling nelle ore in cui il carico ne chiede meno. Per ogni ora:
// servono ceil(vCPU usate / (vCPU per task * MARGINE)), mai meno di uno; se il servizio stava al minimo
// e ne servivano meno, la differenza è capacità pagata e ferma. Ritorna task-ora sprecate al mese.
export function eccessoMinimo({ minimo, vcpuTask, ore }) {
  if (!minimo || minimo <= 1 || !vcpuTask || !ore?.length) return 0
  let spreco = 0
  let viste = 0
  for (const { task, vcpuUsate } of ore) {
    if (!Number.isFinite(task) || !Number.isFinite(vcpuUsate)) continue
    viste++
    if (task > minimo + 0.01) continue // stava scalando: il minimo non c'entra
    const servono = Math.max(1, Math.ceil(vcpuUsate / (vcpuTask * MARGINE)))
    if (servono < minimo) spreco += minimo - servono
  }
  return viste ? (spreco * ORE_MESE) / viste : 0
}

// Ambiente di un account dalla sua chiave: la produzione non si spegne mai di notte. Stessa convenzione
// di `rilasci.js` per prod e staging, più i nomi usuali degli ambienti di prova.
export function nonProduzione(chiave = '') {
  const k = String(chiave).toLowerCase()
  if (/^prod/.test(k)) return false
  return /^(stag|stg|dev|test|qa|sandbox|preview)/.test(k)
}

// Taglie di un'istanza RDS nella sua famiglia, dalla più piccola. È il nome che AWS usa per tutte le
// famiglie (db.r6g.xlarge, db.m7g.2xlarge…): una taglia sotto dimezza vCPU e memoria.
const TAGLIE_RDS = ['micro', 'small', 'medium', 'large', 'xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge', '24xlarge', '32xlarge', '48xlarge']
export function classeSotto(classe) {
  const m = /^(db\.[a-z0-9-]+)\.([a-z0-9]+)$/.exec(String(classe ?? ''))
  if (!m) return null
  const i = TAGLIE_RDS.indexOf(m[2])
  if (i <= 0) return null
  return `${m[1]}.${TAGLIE_RDS[i - 1]}`
}

// Un database regge una taglia sotto se, dimezzati vCPU e memoria, il picco di CPU resta sotto il
// MARGINE e resta almeno il 10% di memoria libera. `memLiberaMin` è la percentuale minima osservata.
export function dbReggeTagliaSotto({ cpuP95, memLiberaMin }) {
  if (cpuP95 == null || memLiberaMin == null) return false
  const memUsata = 100 - memLiberaMin
  return cpuP95 * 2 < MARGINE * 100 && memUsata * 2 <= 90
}

// Le leve, la più redditizia prima. Ognuna dice cosa, quanto al mese, con che rischio e come si
// applica; i testi li compone la pagina, qui ci sono solo i dati.
export function ordinaLeve(leve) {
  return [...(leve ?? [])].filter((l) => l.usdMese > 0.5).sort((a, b) => b.usdMese - a.usdMese)
}
