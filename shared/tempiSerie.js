// Le SERIE della dashboard dei tempi (pagina Tempi): da un punto per build (`/api/deploys/storico`) alle
// fasce del grafico, alle tessere in cima e ai piccoli multipli per servizio. Condiviso fra server (il
// quantile) e pagina (tutto il resto): i filtri di servizio e ambiente si applicano nel browser, e
// rifare il giro di CodeBuild e GitHub per ogni filtro costerebbe decine di chiamate per niente.
//
// Un punto: { a: account, s: servizio, amb, t: inizio (ms), esito: 'ok' | 'ko', n: numero build,
// coda, build, deploy, totale, ci, attesa, lead } (durate in ms, null = non misurata).

const ORA = 3_600_000
const GIORNO = 24 * ORA

// Quantile con interpolazione lineare (lo stesso di numpy di default). Puro.
export function quantile(valori, q) {
  const v = valori.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const pos = (v.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return Math.round(v[lo] + (v[hi] - v[lo]) * (pos - lo))
}

export function riassunto(valori) {
  const v = valori.filter(Number.isFinite)
  return v.length ? { p50: quantile(v, 0.5), p90: quantile(v, 0.9), n: v.length } : null
}

// I pezzi della colonna impilata, in ordine fisso (il colore segue il pezzo, mai la posizione). Le
// due attese stanno insieme: l'attesa su GitHub (approvazioni, runner occupati) e la coda di CodeBuild
// sono tutte e due tempo in cui non lavora nessuno, e due grigi diversi non si distinguerebbero.
export const PEZZI = [
  { k: 'ci', campi: ['ci'] },
  { k: 'attese', campi: ['attesa', 'coda'] },
  { k: 'build', campi: ['build'] },
  { k: 'deploy', campi: ['deploy'] },
]

// La somma dei campi misurati di un punto; null se non ce n'è nessuno.
const somma = (p, campi) => {
  const v = campi.map((c) => p[c]).filter(Number.isFinite)
  return v.length ? v.reduce((s, x) => s + x, 0) : null
}

// Le fasce della finestra, allineate all'ora LOCALE (mezzanotte, o multipli di sei ore sulla
// settimana): chi legge pensa «martedì», non «da lunedì alle 22 UTC». L'ultima fascia contiene adesso.
export function griglia({ giorni = 30, ora = Date.now() } = {}) {
  const passoMs = giorni <= 7 ? 6 * ORA : GIORNO
  const d = new Date(ora)
  if (passoMs === GIORNO) d.setHours(24, 0, 0, 0)
  else d.setHours(Math.floor(d.getHours() / 6) * 6 + 6, 0, 0, 0)
  const punti = Math.round((giorni * GIORNO) / passoMs)
  return { inizio: d.getTime() - punti * passoMs, passoMs, punti }
}

const inFasce = (punti, g) => {
  const fasce = Array.from({ length: g.punti }, () => [])
  for (const p of punti) {
    const i = Math.floor((p.t - g.inizio) / g.passoMs)
    if (i >= 0 && i < g.punti) fasce[i].push(p)
  }
  return fasce
}

// Le serie per fascia. Le durate vengono dalle build RIUSCITE (una fallita si ferma a metà, e la sua
// durata direbbe che il rilascio è più veloce); i conteggi da tutte. Una fascia senza build ha le
// durate null (un buco nella linea) e i conteggi a zero (uno zero vero: non è uscito niente). Puro.
export function serieTempi(punti = [], g) {
  const fasce = inFasce(punti, g)
  const riuscite = fasce.map((f) => f.filter((p) => p.esito === 'ok'))
  const q = (campo, x) => riuscite.map((f) => quantile(f.map((p) => p[campo]), x))
  return {
    ...g,
    pezzi: PEZZI.map((pz) => ({ k: pz.k, valori: riuscite.map((f) => quantile(f.map((p) => somma(p, pz.campi)), 0.5)) })),
    totale: { p50: q('totale', 0.5), p90: q('totale', 0.9) },
    lead: { p50: q('lead', 0.5), p90: q('lead', 0.9) },
    riusciti: riuscite.map((f) => f.length),
    falliti: fasce.map((f) => f.filter((p) => p.esito === 'ko').length),
  }
}

// Le tessere in cima: i numeri dell'intera finestra, non la media delle fasce (una fascia con un
// rilascio solo peserebbe quanto una con venti). Puro.
export function kpiTempi(punti = [], { giorni = 30 } = {}) {
  const ok = punti.filter((p) => p.esito === 'ok')
  const ko = punti.filter((p) => p.esito === 'ko')
  const r = (campo) => riassunto(ok.map((p) => p[campo]))
  return {
    lead: r('lead'),
    ci: r('ci'),
    attese: riassunto(ok.map((p) => somma(p, ['attesa', 'coda']))),
    build: r('build'),
    deploy: r('deploy'),
    totale: r('totale'),
    falliti: ok.length + ko.length ? { n: ko.length, tot: ok.length + ko.length, tasso: ko.length / (ok.length + ko.length) } : null,
    alGiorno: ok.length / giorni,
  }
}

// I piccoli multipli: una riga per account e servizio con la mediana di `campo` per fascia, dalla
// riga con più rilasci. Tutte sulla STESSA scala (`dominio`): con una scala per riga un servizio da
// 40 secondi e uno da 12 minuti disegnano la stessa collina. Puro.
export function perServizio(punti = [], g, { campo = 'totale', max = 12 } = {}) {
  const gruppi = new Map()
  for (const p of punti) {
    if (p.esito !== 'ok') continue
    const k = `${p.a}|${p.s}`
    if (!gruppi.has(k)) gruppi.set(k, { k, account: p.a, servizio: p.s, punti: [] })
    gruppi.get(k).punti.push(p)
  }
  const righe = [...gruppi.values()]
    .sort((a, b) => b.punti.length - a.punti.length || a.servizio.localeCompare(b.servizio))
    .slice(0, max)
    .map((r) => ({
      k: r.k,
      account: r.account,
      servizio: r.servizio,
      n: r.punti.length,
      p50: quantile(r.punti.map((p) => p[campo]), 0.5),
      valori: inFasce(r.punti, g).map((f) => quantile(f.map((p) => p[campo]), 0.5)),
    }))
  const hi = Math.max(0, ...righe.flatMap((r) => r.valori.filter(Number.isFinite)))
  return { righe, dominio: [0, hi], altri: Math.max(0, gruppi.size - max) }
}
