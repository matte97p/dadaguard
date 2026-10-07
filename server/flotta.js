// La FLOTTA dei dev-env: una card per Mac, con il problema detto a parole e l'azione che lo risolve.
//
// Perche' una pagina sua (07/10/2026). La salute dei Mac stava nella pagina Accessi, in una colonna di
// una tabella larga: «nessun dato» su ogni riga, «Tool mancanti: 0» quasi ovunque, il comando `tsh ssh`
// ripetuto su ogni riga, e un Mac con tre processi uccisi per memoria alto quanto uno sano. Erano due
// mestieri in una pagina (chi entra dove, e come stanno i portatili), e il secondo perdeva.
//
// Qui si COMPONE, lato server, la risposta di `/api/flotta`: per ogni macchina i problemi in ordine di
// gravita', ciascuno con la sua azione. La pagina disegna e basta, e le regole si provano senza browser
// (`test/flotta.test.js`).
//
// ⚠️ La stessa verita' del canale. I problemi che parlano anche su Slack (OOM, VM sotto l'obiettivo,
// doctor KO, opt-out, comandi sul Mac, salute muta, motore, container non sani, dev-env fermo) NON si
// ricalcolano qui: si prendono da `segnali()` di server/accessi.js, con le stesse soglie della config.
// Una pagina che dice una cosa e un canale che ne dice un'altra insegnano a non credere a nessuno dei
// due. Qui si aggiunge solo quello che il canale non dice: immagine indietro (con la regola della
// pagina, che sa anche della versione attesa), tool mancanti, avvio non riuscito, app troppo pesante.
//
// Read-only come tutto il resto: le azioni sono FRASI e comandi da copiare, mai qualcosa che si esegue.
import { loadConfig } from './config.js'
import { resolveServices } from './status.js'
import { cached } from './util/ttlcache.js'
import { cleanAwsReason } from './runtime/awsClient.js'
import * as teleport from './teleport.js'
import { AVVII_IN_STORIA } from './teleport.js'
import { annotaIdentita, fondiIdentita, personaDi, raggruppaMacchine, NON_VISTA_MS } from './identitaMacchine.js'
import { conto, configSalute, leggiHeartbeat, segnali, soglieDevEnv, SOGLIE_DEV_ENV } from './accessi.js'
import {
  appPiuPesanti,
  avvioStorto,
  dataImmagine,
  dataRiferimento,
  digestCorto,
  immagineRiferimento,
  ritardo,
  tuttiIndietro,
  usoDellaMacchina,
  versioneNota,
} from '../shared/devEnv.js'

// Il livello di ogni problema sulla PAGINA. Non e' quello del canale, apposta: su Slack un OOM e'
// «attenzione» perche' il messaggio deve restare sotto la soglia del rumore, mentre qui un Mac che ha
// perso il lavoro per memoria finita e' la prima card da guardare.
//   · crit: il dev-env ha perso lavoro o non parte;
//   · warn: si guasta presto, o lavora male, e si sistema con un'azione;
//   · info: una scelta da rivedere, che oggi non rompe niente (motore, opt-out).
export const LIVELLO = Object.freeze({
  oom: 'crit',
  'dev-fermo': 'crit',
  container: 'warn',
  'vm-sotto-obiettivo': 'warn',
  'immagine-indietro': 'warn',
  'doctor-ko': 'warn',
  'lavoro-sul-mac': 'warn',
  'salute-muta': 'warn',
  'tool-mancanti': 'warn',
  'app-pesante': 'warn',
  'avvio-storto': 'warn',
  guasto: 'warn',
  'motore-non-supportato': 'info',
  'opt-out-attivi': 'info',
})

const RANGO = { crit: 0, warn: 1, info: 2, ok: 3 }
// Dentro lo stesso livello, l'ordine in cui si legge: la causa prima della conseguenza (la VM piccola
// spiega l'OOM, quindi viene subito dopo), e le cose che si sistemano da sole in fondo.
const ORDINE = Object.keys(LIVELLO)
const rango = (p) => RANGO[p.livello] * 100 + ORDINE.indexOf(p.tipo)

// Il comando che da' alla VM `gb` di memoria, per il motore che c'e'. Docker Desktop si cambia dalle
// impostazioni (nessun comando), e un motore che non si sa non ha un comando da indovinare.
export function comandoMemoria(motore, gb) {
  const m = String(motore ?? '').toLowerCase()
  if (!Number.isFinite(gb) || gb <= 0) return null
  if (m === 'colima') return `colima stop && colima start --memory ${gb}`
  if (m === 'orbstack') return `orb config set memory_mib ${gb * 1024}`
  return null
}

// I comandi che dipendono da come e' fatto il dev-env di chi installa (`teleport.devEnvComandi` in
// config): aggiornarlo, lanciare il doctor, rilanciare l'agent della salute. Senza config l'azione
// resta una frase, che e' meglio di un comando inventato.
export function comandiDevEnv(cfg = {}) {
  const c = cfg?.devEnvComandi ?? {}
  const testo = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  return { aggiorna: testo(c.aggiorna), doctor: testo(c.doctor), salute: testo(c.salute), dentro: testo(c.dentro) }
}

// Un nome di container che si puo' mettere in un comando senza virgolette.
const NOME_SEMPLICE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

// L'azione che risolve UN problema: una chiave (la frase la sceglie la pagina, nella sua lingua), i
// valori che la frase usa e, quando c'e', il comando da copiare.
export function azioneDi(p, ctx = {}) {
  const { motore = null, vm = {}, comandi = {}, app = null } = ctx
  const memoria = () => {
    const gb = Number.isFinite(vm.obiettivoGb) ? Math.ceil(vm.obiettivoGb) : null
    return { k: 'memoriaVm', gb, motore, comando: comandoMemoria(motore, gb) }
  }
  switch (p.tipo) {
    case 'oom':
      // La VM sotto l'obiettivo e' la causa piu' probabile e la piu' facile da togliere; senza un
      // obiettivo, l'app che pesa di piu' e' il posto da cui cominciare.
      if (ctx.vmSotto) return memoria()
      if (app) return { k: 'riavviaApp', app: app.nome, gb: app.gb, comando: null }
      return { k: 'liberaMemoria', comando: null }
    case 'vm-sotto-obiettivo':
      return memoria()
    case 'immagine-indietro':
    case 'tool-mancanti':
      return { k: 'aggiorna', comando: comandi.aggiorna ?? null }
    case 'doctor-ko':
    case 'dev-fermo':
    case 'avvio-storto':
    case 'guasto':
      return { k: 'doctor', comando: comandi.doctor ?? null }
    case 'lavoro-sul-mac':
      return { k: 'dentroContainer', comando: comandi.dentro ?? null }
    case 'salute-muta':
      return { k: 'riavviaSalute', comando: comandi.salute ?? null }
    case 'container': {
      const nomi = p.nomi ?? []
      const comando = nomi.length && nomi.every((n) => NOME_SEMPLICE.test(n)) ? `docker restart ${nomi.join(' ')}` : null
      return { k: 'riavviaContainer', comando }
    }
    case 'app-pesante':
      return { k: 'riavviaApp', app: p.app, gb: p.gb, comando: null }
    case 'motore-non-supportato':
      return { k: 'cambiaMotore', ammessi: p.ammessi ?? [], comando: null }
    case 'opt-out-attivi':
      return { k: 'togliOptOut', nomi: p.nomi ?? [], comando: null }
    default:
      return { k: 'guarda', comando: null }
  }
}

// I segnali del canale che riguardano UNA macchina, tradotti in problemi della pagina. `immagine-
// vecchia` e `versione` restano fuori: l'immagine qui la giudica `ritardo()`, che oltre alla data sa
// della versione attesa in config, e la versione che non ha nessuno e' una notizia di flotta.
function problemaDaSegnale(s) {
  switch (s.tipo) {
    case 'oom':
      return { tipo: 'oom', quante: s.quante, uccisi: s.uccisi ?? [], quando: s.quando ?? null }
    case 'dev-fermo':
      return { tipo: 'dev-fermo', classe: s.classe ?? null, dettaglio: s.dettaglio ?? null, quando: s.quando ?? null }
    case 'container':
      return { tipo: 'container', nomi: String(s.dettaglio ?? '').split(', ').filter(Boolean), giri: s.giri, quando: s.quando ?? null }
    case 'vm-sotto-obiettivo':
      return { tipo: 'vm-sotto-obiettivo', vmGb: s.vmGb, obiettivoGb: s.obiettivoGb, stimata: Boolean(s.stimata) }
    case 'doctor-ko':
      return { tipo: 'doctor-ko', quante: s.quante, falliti: s.falliti ?? [], quando: s.quando ?? null }
    case 'lavoro-sul-mac':
      return { tipo: 'lavoro-sul-mac', quante: s.quante, bloccati: s.bloccati, forzati: s.forzati }
    case 'salute-muta':
      return { tipo: 'salute-muta', oreZitta: s.oreZitta, quando: s.quando ?? null }
    case 'motore-non-supportato':
      return { tipo: 'motore-non-supportato', motore: s.motore ?? null, candidati: s.candidati ?? [], ammessi: s.ammessi ?? [] }
    case 'opt-out-attivi':
      return { tipo: 'opt-out-attivi', nomi: s.nomi ?? [] }
    case 'guasto':
      return { tipo: 'guasto', classe: s.classe, passo: s.passo ?? null, dettaglio: s.dettaglio ?? null, quando: s.quando ?? null }
    default:
      return null
  }
}

// La macchina a cui un segnale si riferisce: il `bersaglio`, tranne che per i guasti nuovi, dove il
// bersaglio e' il dev-env intero e la macchina sta a parte.
const macchinaDel = (s) => (s.tipo === 'guasto' ? s.macchina : s.bersaglio)

const num = (x) => (Number.isFinite(x) ? x : null)

// ── L'ANDAMENTO DELLA FLOTTA, per il cruscotto (dal 07/10/2026) ─────────────────────────────────
//
// La pagina apre con cinque numeri e un grafico di sette giorni: quanti Mac sono accesi, quanti
// processi la memoria ha ucciso, quanta memoria libera ha la VM peggiore, quanti Mac hanno l'immagine
// in pari. Sono conti sulla FLOTTA, e si fanno qui dalle serie per macchina gia' binnate per ora
// (`binnaSalute`), non nel browser: al browser servono sette numeri per tessera e 168 per il grafico,
// non sette serie da incrociare.
//
// ⚠️ «Non lo so» non e' zero, come nel resto della pagina. Un'ora in cui nessun Mac ha mandato righe
// ha la memoria `null` (non «finita») e gli OOM `null` (non «nessuno»); i Mac ACCESI invece si
// contano, e zero e' la risposta vera di una notte.
const GIORNO_MS = 86_400_000

// Sotto questa memoria libera la VM sta per uccidere un processo: e' la soglia che colora il numero
// della tessera. Un giga e' il punto in cui, sui dati veri, sono arrivati gli OOM.
export const MEM_LIBERA_BASSA_GB = 1

function mediana(valori) {
  if (!valori.length) return null
  const v = [...valori].sort((a, b) => a - b)
  const m = Math.floor(v.length / 2)
  const x = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
  return Math.round(x * 10) / 10
}

// Ogni ora della settimana, sulla flotta intera:
//   · memMin, memMinChi: la memoria libera della VM peggiore, e di chi e';
//   · memMediana: quella del Mac tipico, per dire se il minimo e' un Mac solo o tutti;
//   · oom: i processi uccisi in quell'ora su tutti i Mac (`null` se nessuno ha mandato il contatore);
//   · attivi: quanti Mac hanno mandato almeno una riga.
// Poi gli stessi conti per GIORNO (blocchi di 24 ore che finiscono adesso, non giorni di calendario:
// l'ultimo e' «le ultime 24 ore», lo stesso periodo dei numeri in cima) per le tessere, e l'immagine
// in pari giorno per giorno, rigiocando gli avvii con la stessa regola di `ritardo()`.
export function andamentoFlotta({ serie = null, storia = {}, riferimento = null, soglia = SOGLIE_DEV_ENV.giorniIndietro } = {}) {
  if (!serie?.punti || !serie.passoMs || !Number.isFinite(serie.inizio)) return null
  const { inizio, passoMs, punti } = serie
  const mac = Object.entries(serie.macchine ?? {})
  const ore = { memMin: [], memMinChi: [], memMediana: [], oom: [], attivi: [] }
  for (let i = 0; i < punti; i++) {
    const mem = []
    let min = null
    let chi = null
    let oom = null
    let attivi = 0
    for (const [nome, s] of mac) {
      const v = s.mem?.[i]
      if (v != null) {
        mem.push(v)
        if (min == null || v < min) {
          min = v
          chi = nome
        }
      }
      const k = s.oom?.[i]
      if (k != null) oom = (oom ?? 0) + k
      if (v != null || k != null || s.swap?.[i] != null || s.cpu?.[i] != null) attivi += 1
    }
    ore.memMin.push(min)
    ore.memMinChi.push(chi)
    ore.memMediana.push(mediana(mem))
    ore.oom.push(oom)
    ore.attivi.push(attivi)
  }

  const perGiorno = Math.round(GIORNO_MS / passoMs)
  const quantiGiorni = perGiorno > 0 ? Math.floor(punti / perGiorno) : 0
  const avvii = Object.entries(storia ?? {}).flatMap(([macchina, xs]) => (xs ?? []).map((a) => ({ ...a, macchina })))
  const giorni = { inizio: inizio + (punti - quantiGiorni * perGiorno) * passoMs, passoMs: perGiorno * passoMs, punti: quantiGiorni, attivi: [], oom: [], conOom: [], memMin: [], inPari: [], conImmagine: [] }
  for (let g = 0; g < quantiGiorni; g++) {
    const da = punti - (quantiGiorni - g) * perGiorno
    const a = da + perGiorno
    const t0 = inizio + da * passoMs
    const t1 = inizio + a * passoMs
    const accesi = new Set()
    let oom = null
    let conOom = 0
    let memMin = null
    for (const [nome, s] of mac) {
      let suoi = null
      for (let i = da; i < a; i++) {
        if (s.mem?.[i] != null || s.oom?.[i] != null || s.swap?.[i] != null || s.cpu?.[i] != null) accesi.add(nome)
        if (s.oom?.[i] != null) suoi = (suoi ?? 0) + s.oom[i]
        if (s.mem?.[i] != null) memMin = memMin == null ? s.mem[i] : Math.min(memMin, s.mem[i])
      }
      if (suoi != null) oom = (oom ?? 0) + suoi
      if (suoi > 0) conOom += 1
    }
    // Un Mac che ha avviato il dev-env quel giorno era acceso anche se la salute non l'ha mandata.
    for (const x of avvii) if (x.quando >= t0 && x.quando < t1) accesi.add(x.macchina)
    giorni.attivi.push(accesi.size)
    giorni.oom.push(oom)
    giorni.conOom.push(oom == null ? null : conOom)
    giorni.memMin.push(memMin)
    const pari = immagineInPari(avvii, t1, riferimento, soglia)
    giorni.inPari.push(pari.conImmagine ? pari.inPari : null)
    giorni.conImmagine.push(pari.conImmagine)
  }
  return { inizio, passoMs, punti, ...ore, giorni }
}

// Quanti Mac avevano l'immagine in pari all'istante `t`: per ogni Mac e per ogni LATO l'ultimo avvio
// fino a `t`, e la regola di `ritardo()` con la data piu' recente vista fino a quel momento (non
// quella di oggi: un'immagine di lunedi' non era indietro domenica). E' la regola della colonna
// Immagine della matrice: un Mac e' noto se almeno un lato porta la data (o la versione, con la
// versione attesa in config), ed e' indietro se lo e' almeno un lato.
export function immagineInPari(avvii = [], t = Date.now(), riferimento = null, soglia = SOGLIE_DEV_ENV.giorniIndietro) {
  const finoA = avvii.filter((a) => Number.isFinite(a?.quando) && a.quando < t)
  const dataRif = dataRiferimento(finoA)
  const ultimo = new Map()
  for (const a of finoA) {
    const k = `${a.macchina}\u0000${a.lato === 'container' ? 'container' : 'host'}`
    if (!ultimo.has(k) || a.quando > ultimo.get(k).quando) ultimo.set(k, a)
  }
  const perMac = new Map()
  for (const a of ultimo.values()) {
    const perVersione = riferimento?.fonte === 'config' && versioneNota(a.immagine)
    if (dataImmagine(a) == null && !perVersione) continue
    perMac.set(a.macchina, (perMac.get(a.macchina) ?? false) || ritardo(a, riferimento, dataRif, soglia).indietro)
  }
  const indietro = [...perMac.values()].filter(Boolean).length
  return { inPari: perMac.size - indietro, conImmagine: perMac.size }
}

// I numeri in cima alla pagina, adesso. Le stesse macchine della matrice, cosi' la tessera e la
// colonna dicono lo stesso numero.
export function riepilogoFlotta(macchine = [], andamento = null, { adesso = Date.now() } = {}) {
  const daUltime24 = adesso - GIORNO_MS
  const conOom = macchine.filter((m) => m.oom != null)
  // La memoria libera minima delle ultime 24 ore, e di chi: il caso peggiore, come nel grafico.
  let memMinima = null
  if (andamento) {
    const da = Math.max(0, andamento.punti - Math.round(GIORNO_MS / andamento.passoMs))
    for (let i = da; i < andamento.punti; i++) {
      const v = andamento.memMin[i]
      if (v != null && (memMinima == null || v <= memMinima.gb)) memMinima = { gb: v, macchina: andamento.memMinChi[i] }
    }
  }
  const conImmagine = macchine.filter((m) => m.immagine?.creata || m.problemi.some((p) => p.tipo === 'immagine-indietro'))
  return {
    attivi24h: macchine.filter((m) => (m.visto ?? 0) >= daUltime24).length,
    oom24h: conOom.length ? conOom.reduce((n, m) => n + (m.oom.nuovi ?? 0), 0) : null,
    conOom24h: conOom.length ? conOom.filter((m) => (m.oom.nuovi ?? 0) > 0).length : null,
    memMinima: memMinima ? { ...memMinima, bassa: memMinima.gb < MEM_LIBERA_BASSA_GB } : null,
    conImmagine: conImmagine.length,
    inPari: conImmagine.filter((m) => !m.problemi.some((p) => p.tipo === 'immagine-indietro')).length,
    urgenti: macchine.filter((m) => m.livello === 'crit').length,
  }
}

// Le serie di piu' nomi dello stesso Mac in una, ora per ora, con la regola di `binnaSalute`: il
// caso peggiore (memoria minima, swap e carico massimi) e gli OOM sommati. I nomi di un Mac parlano in
// ore diverse, quindi quasi sempre un'ora ha un valore solo.
const SERIE_VERSO = { mem: 'min', oom: 'somma', swap: 'max', cpu: 'max' }
export function fondiSerie(lista = []) {
  const ss = lista.filter(Boolean)
  if (ss.length <= 1) return ss[0] ?? null
  const fuori = {}
  for (const [k, verso] of Object.entries(SERIE_VERSO)) {
    const lunghezza = Math.max(...ss.map((s) => s[k]?.length ?? 0))
    fuori[k] = Array.from({ length: lunghezza }, (_, i) => {
      const v = ss.map((s) => s[k]?.[i]).filter((x) => x != null)
      if (!v.length) return null
      if (verso === 'somma') return v.reduce((a, b) => a + b, 0)
      return verso === 'min' ? Math.min(...v) : Math.max(...v)
    })
  }
  return fuori
}

// L'identita' per nome quando la fonte non la porta (la demo, o una risposta in cache di prima del
// rilascio): dalle righe per lato e dalla storia degli avvii dell'heartbeat, e dalle macchine e dalle
// ultime righe della salute. Meno precisa (la storia ha un tetto), ma della stessa forma.
function identitaDiRiserva(battito, sal) {
  const m = {}
  for (const r of battito.macchine ?? []) {
    if (!r?.macchina || !Number.isFinite(r.quando)) continue
    annotaIdentita(m, { macchina: r.macchina, macchina_id: r.macchinaId, utente: r.utente, utente_da: r.utenteDa }, r.quando)
    for (const u of r.utenti ?? []) if (u !== r.utente) annotaIdentita(m, { macchina: r.macchina, utente: u }, r.quando)
  }
  for (const [nome, avvii] of Object.entries(battito.storia ?? {})) {
    for (const a of avvii ?? []) if (Number.isFinite(a?.quando)) annotaIdentita(m, { macchina: nome, macchina_id: a.macchinaId }, a.quando)
  }
  const s = {}
  for (const x of sal?.macchine ?? []) if (x?.macchina && Number.isFinite(x.quando)) annotaIdentita(s, { macchina: x.macchina, utente: x.utente }, x.quando)
  for (const [nome, t] of Object.entries(sal?.ultime ?? {})) if (Number.isFinite(Number(t))) annotaIdentita(s, { macchina: nome }, Number(t))
  return [m, s]
}

// La risposta di `/api/flotta`, da heartbeat e salute gia' letti. Puro, per le prove.
//
// ⚠️ Ogni campo e' facoltativo: le macchine che non hanno ancora aggiornato il dev-env non mandano i
// campi nuovi, e un campo che manca e' «non lo so», mai zero. Una macchina senza righe di salute non
// e' sana ne' malata: ha `saluteAssente`, e la pagina lo dice in una riga sola.
//
// Dal 07/10/2026 una riga e' un MAC, non un nome: i nomi dello stesso Mac (stesso `macchina_id`, o
// l'euristica di server/identitaMacchine.js per le righe vecchie) diventano una riga sola, col nome
// piu' recente e gli altri in `alias`. E un Mac che non si vede da piu' di tre giorni esce dalla
// flotta (`macchine`, i numeri, «da sistemare») e va in `nonViste`.
export function componiFlotta({ heartbeat = {}, salute = null } = {}, { adesso = Date.now(), soglie = SOGLIE_DEV_ENV, comandi = {}, persone = null } = {}) {
  const sg = { ...SOGLIE_DEV_ENV, ...soglie }
  const battito = heartbeat && !heartbeat.errore ? heartbeat : {}
  const sal = salute && !salute.errore ? salute : null
  const righe = battito.macchine ?? []

  const lati = new Map()
  for (const r of righe) {
    if (!r?.macchina) continue
    const m = lati.get(r.macchina) ?? {}
    // `lato` assente (heartbeat vecchio) si legge come host: e' il lato che manda gli avvii dal Mac.
    m[r.lato === 'container' ? 'container' : 'host'] = r
    lati.set(r.macchina, m)
  }
  const salutePer = new Map((sal?.macchine ?? []).map((m) => [m.macchina, m]))
  const nomi = new Set([...lati.keys(), ...salutePer.keys(), ...Object.keys(sal?.ultime ?? {})])

  const perMacchina = new Map()
  for (const s of segnali({ configurato: true, audit: {}, heartbeat: battito, salute: sal ?? {} }, { adesso, soglie: sg })) {
    const nome = macchinaDel(s)
    const p = nome && problemaDaSegnale(s)
    if (!p) continue
    perMacchina.set(nome, [...(perMacchina.get(nome) ?? []), p])
  }

  const riferimento = immagineRiferimento(righe, battito.attesa ?? null)
  const dataRif = dataRiferimento(righe)

  // I nomi in Mac. Un nome senza nessun istante (non dovrebbe succedere) resta un Mac da solo.
  const [riservaBattito, riservaSalute] = identitaDiRiserva(battito, sal)
  const identita = fondiIdentita(battito.identita ?? riservaBattito, sal?.identita ?? riservaSalute)
  const gruppi = raggruppaMacchine(identita, { adesso, persone })
  const inGruppo = new Set(gruppi.flatMap((g) => g.nomi))
  for (const nome of nomi) if (!inGruppo.has(nome)) gruppi.push({ nomi: [nome], ids: [], utenti: [], come: null })

  const piuRecente = (xs) => xs.filter(Boolean).sort((a, b) => (b.quando ?? 0) - (a.quando ?? 0))[0] ?? null
  const tutte = gruppi.map((g) => {
    const nome = g.nomi[0]
    const suoi = g.nomi.map((n) => lati.get(n) ?? {})
    const host = piuRecente(suoi.map((x) => x.host))
    const container = piuRecente(suoi.map((x) => x.container))
    const sms = g.nomi.map((n) => salutePer.get(n)).filter(Boolean)
    const sm = piuRecente(sms)
    const ultimaSalute = Math.max(0, ...g.nomi.map((n) => Number(sal?.ultime?.[n]) || 0)) || null

    // I problemi dei segnali di tutti i nomi, uno per tipo (quello del nome piu' recente). Gli OOM si
    // sommano: quelli del nome vecchio nelle 24 ore sono successi sullo stesso Mac.
    const problemi = []
    for (const p of g.nomi.flatMap((n) => perMacchina.get(n) ?? [])) {
      const gia = problemi.find((q) => q.tipo === p.tipo)
      if (!gia) problemi.push({ ...p })
      else if (p.tipo === 'oom') {
        gia.quante = (gia.quante ?? 0) + (p.quante ?? 0)
        gia.uccisi = [...new Set([...(gia.uccisi ?? []), ...(p.uccisi ?? [])])]
      }
    }
    // Un guasto nuovo e un dev-env fermo sulla stessa macchina sono la stessa notizia: resta il piu' grave.
    if (problemi.some((p) => p.tipo === 'dev-fermo')) problemi.splice(0, problemi.length, ...problemi.filter((p) => p.tipo !== 'guasto'))

    // L'immagine: il lato messo peggio. Host e container possono avere immagini diverse (il container
    // si rifa' a ogni avvio), e il ritardo che conta e' il piu' grande.
    const ritardi = [host, container].filter(Boolean).map((r) => ({ r, ...ritardo(r, riferimento, dataRif, sg.giorniIndietro) }))
    const indietro = ritardi.filter((x) => x.indietro).sort((a, b) => (b.giorni ?? 0) - (a.giorni ?? 0))[0]
    if (indietro) {
      problemi.push({ tipo: 'immagine-indietro', giorni: indietro.giorni, creata: indietro.r.creata ?? null, perVersione: riferimento.fonte === 'config' })
    }

    if ((host?.toolMancanti ?? 0) > 0) {
      problemi.push({ tipo: 'tool-mancanti', quante: host.toolMancanti, nomi: host.toolMancantiNomi ?? [] })
    }

    // L'ULTIMO avvio, di qualsiasi lato, finito non `ok`. Se la macchina e' gia' «ferma» (due avvii
    // KO di fila) e' la stessa notizia detta peggio, e non si ripete.
    const ultimo = [host, container].filter(Boolean).sort((a, b) => (b.quando ?? 0) - (a.quando ?? 0))[0]
    if (ultimo && avvioStorto(ultimo) && !problemi.some((p) => p.tipo === 'dev-fermo')) {
      problemi.push({ tipo: 'avvio-storto', esito: ultimo.esito, lato: ultimo.lato ?? null, quando: ultimo.quando ?? null })
    }

    const pesanti = appPiuPesanti(sm?.appMb ?? {}, 3)
    const troppo = pesanti.find((a) => a.gb * 1024 >= sg.appPesanteMb)
    if (troppo) problemi.push({ tipo: 'app-pesante', app: troppo.nome, gb: troppo.gb, sogliaGb: Math.round(sg.appPesanteMb / 102.4) / 10 })

    const uso = usoDellaMacchina(sm)
    const vm = {
      gb: num(sm?.vmMemGb),
      impostataGb: num(sm?.vmMemImpostataGb),
      obiettivoGb: num(sm?.vmMemObiettivoGb),
      ramMacGb: num(sm?.ramMacGb),
      disponibileGb: num(sm?.memDisponibileGb),
      cpu: num(sm?.vmCpu),
    }
    const impostata = vm.impostataGb ?? vm.gb
    const ctx = {
      motore: uso.motore ?? null,
      vm,
      comandi,
      app: pesanti[0] ?? null,
      vmSotto: vm.obiettivoGb != null && impostata != null && impostata < vm.obiettivoGb - 0.5,
    }
    const completi = problemi
      .map((p) => ({ ...p, livello: LIVELLO[p.tipo] ?? 'warn' }))
      .sort((a, b) => rango(a) - rango(b))
      .map((p) => ({ ...p, azione: azioneDi(p, ctx) }))

    // La persona: Teleport prima, poi la mappa delle persone, poi l'utente grezzo (identitaMacchine.js).
    // Senza voci d'identita' (nome senza istanti) si ripiega sugli utenti delle righe, come prima.
    const voci = g.utenti.length
      ? g.utenti
      : [sm?.utente, host?.utente, container?.utente, ...(host?.utenti ?? []), ...(container?.utenti ?? [])].filter(Boolean).map((utente) => ({ utente, da: null, quando: 0 }))
    const persona = personaDi(voci, persone)
    const visto = Math.max(0, host?.quando ?? 0, container?.quando ?? 0, sm?.quando ?? 0, ultimaSalute ?? 0) || null
    const oom = sms.length
      ? {
          nuovi: sms.reduce((n, x) => n + (x.oomNuovi ?? 0), 0),
          uccisi: [...new Set(sms.flatMap((x) => x.uccisiPerMemoria ?? []))],
          quando: Math.max(0, ...sms.map((x) => x.oomQuando ?? 0)) || null,
        }
      : null
    const storia = g.nomi
      .flatMap((n) => battito.storia?.[n] ?? [])
      .sort((a, b) => (b.quando ?? 0) - (a.quando ?? 0))
      .slice(0, AVVII_IN_STORIA)
    return {
      macchina: nome,
      // La chiave stabile del Mac: l'id quando il dev-env lo manda, il nome altrimenti.
      chiave: g.ids[0] ?? nome,
      id: g.ids[0] ?? null,
      // Gli altri nomi con cui si e' presentato, dal piu' recente, e come li si e' riconosciuti.
      alias: g.nomi.slice(1),
      unitoPer: g.come ?? null,
      utente: persona.utente,
      utenteDa: persona.da,
      altriNomi: persona.altri,
      livello: completi[0]?.livello ?? 'ok',
      problemi: completi,
      visto,
      // Non visto da piu' di tre giorni: fuori dai numeri, nel gruppo chiuso della pagina.
      nonVisto: visto != null && adesso - visto > NON_VISTA_MS,
      host,
      container,
      immagine: {
        digest: digestCorto(host?.immagine ?? container?.immagine),
        creata: host?.creata ?? container?.creata ?? null,
        giorni: indietro?.giorni ?? ritardi[0]?.giorni ?? null,
      },
      vm,
      motore: uso.motore,
      motoreIncerto: uso.motoreIncerto,
      app: pesanti,
      contenitori: sm?.contenitori ?? [],
      oom,
      swapGb: sm?.swapMacMb != null ? Math.round(sm.swapMacMb / 102.4) / 10 : null,
      uso: { ...uso, ultimoUp: sm?.ultimoUp ?? null, ultimoUpdate: sm?.ultimoUpdate ?? null, doctor: sm?.doctor ?? null },
      // Nessuna riga di salute nelle 24 ore ne' nei sette giorni: dev-env che l'agent non ce l'ha
      // ancora, o Mac spento. Non e' un problema da card: e' un dato che manca, e si dice una volta.
      saluteAssente: !sm && !ultimaSalute,
      saluteUltima: ultimaSalute || sm?.quando || null,
      serie: fondiSerie(g.nomi.map((n) => sal?.serie?.macchine?.[n])),
      storia,
    }
  })

  const ordine = (a, b) =>
    RANGO[a.livello] - RANGO[b.livello] ||
    b.problemi.filter((p) => p.livello !== 'info').length - a.problemi.filter((p) => p.livello !== 'info').length ||
    a.macchina.localeCompare(b.macchina)
  const macchine = tutte.filter((m) => !m.nonVisto).sort(ordine)
  const nonViste = tutte.filter((m) => m.nonVisto).sort((a, b) => (b.visto ?? 0) - (a.visto ?? 0) || a.macchina.localeCompare(b.macchina))
  const daSistemare = macchine.filter((m) => m.livello === 'crit' || m.livello === 'warn').length
  // L'andamento e' quello dei Mac della flotta, come i numeri in cima: un nome vecchio non visto da tre
  // giorni contava due volte lo stesso Mac nei giorni in cui parlava.
  const serieVive = sal?.serie
    ? { ...sal.serie, macchine: Object.fromEntries(macchine.filter((m) => m.serie).map((m) => [m.macchina, m.serie])) }
    : null
  const storiaViva = Object.fromEntries(macchine.map((m) => [m.macchina, m.storia]))
  const andamento = andamentoFlotta({ serie: serieVive, storia: storiaViva, riferimento, soglia: sg.giorniIndietro })
  const nomiVivi = new Set(macchine.flatMap((m) => [m.macchina, ...m.alias]))
  return {
    configurato: true,
    saluteConfigurata: salute != null,
    macchine,
    nonViste,
    nonVistiDopoGiorni: NON_VISTA_MS / 86_400_000,
    totale: macchine.length,
    daSistemare,
    riferimento: { digest: digestCorto(riferimento.immagine), fonte: riferimento.fonte, data: dataRif },
    tuttiIndietro: tuttiIndietro(righe.filter((r) => nomiVivi.has(r.macchina)), riferimento),
    serie: sal?.serie ? { inizio: sal.serie.inizio, passoMs: sal.serie.passoMs, punti: sal.serie.punti } : null,
    // I conti sulla flotta per il cruscotto: per ora (il grafico) e per giorno (le tessere).
    andamento,
    riepilogo: riepilogoFlotta(macchine, andamento, { adesso }),
    soglie: sg,
    troncato: Boolean(sal?.troncato),
    errori: [heartbeat?.errore, salute?.errore].filter(Boolean),
  }
}

// La lettura vera: heartbeat (la stessa cache della pagina Accessi) e sette giorni di salute in una
// query sola, con la cache di due minuti delle altre letture.
export async function statoFlotta({ adesso = Date.now() } = {}) {
  const { accounts } = await resolveServices()
  const cfg = loadConfig().teleport
  if (!cfg) return { configurato: false }
  const cs = configSalute(cfg)
  const [heartbeat, salute] = await Promise.all([
    leggiHeartbeat(accounts, cfg),
    !cs
      ? null
      : conto(accounts, cs.account)
        ? cached('flotta:salute', 120_000, () =>
            teleport.saluteSettimana(conto(accounts, cs.account), { logGroup: cs.logGroup, giorni: 7, ore: 24 }),
          ).catch((err) => ({ errore: cleanAwsReason(err) }))
        : { errore: `account "${cs.account ?? '?'}" non configurato in accounts` },
  ])
  return {
    ...componiFlotta({ heartbeat, salute }, { adesso, soglie: soglieDevEnv(cfg), comandi: comandiDevEnv(cfg), persone: loadConfig().people ?? null }),
    sshCommand: cfg.sshCommand ?? null,
    auditNodeUrl: cfg.auditNodeUrl ?? null,
    auditUserUrl: cfg.auditUserUrl ?? null,
    webUrl: cfg.webUrl ?? null,
  }
}
