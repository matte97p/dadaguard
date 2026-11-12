// La logica pura della status page: niente fetch, niente KV, niente orologio implicito. Il Worker
// (worker.js) la chiama con i dati già letti; i test la chiamano con dati inventati.

export const STATES = ['unknown', 'operational', 'degraded', 'outage']
const RANK = { unknown: 0, operational: 1, degraded: 2, outage: 3 }
export const worst = (a, b) => (RANK[b] > RANK[a] ? b : a)

export const HISTORY_DAYS = 90
// Una sonda sola che fallisce non fa rosso: la rete fra Cloudflare e l'origine ha i suoi
// singhiozzi, e una pagina che lampeggia rossa per un pacchetto perso vale meno di nessuna pagina.
export const FAILS_FOR_OUTAGE = 2
// Sopra questa latenza la sonda dice «rallentato», anche se risponde.
export const SLOW_MS = 5000
// Dopo quanto tempo senza un controllo la pagina avvisa che i dati sono vecchi.
export const STALE_MS = 3 * 60 * 1000

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/

// `COMPONENTS` arriva dalla configurazione del deploy, in JSON:
//   [{ "id": "web", "it": "Piattaforma web", "en": "Web app", "subIt": "...", "subEn": "...",
//      "probe": "https://app.example.com/" }]
// Una voce malformata si scarta: meglio un componente in meno che una pagina che non parte.
export function parseComponents(raw) {
  let list
  try {
    list = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const c of list) {
    if (!c || !ID.test(c.id) || seen.has(c.id) || typeof c.it !== 'string' || !c.it) continue
    seen.add(c.id)
    let probe = null
    if (typeof c.probe === 'string') {
      try {
        const u = new URL(c.probe)
        if (u.protocol === 'https:') probe = u.toString()
      } catch {
        probe = null
      }
    }
    out.push({
      id: c.id,
      name: { it: c.it, en: typeof c.en === 'string' && c.en ? c.en : c.it },
      sub: { it: c.subIt ?? '', en: c.subEn ?? c.subIt ?? '' },
      probe,
    })
  }
  return out
}

// Lo stato di un componente in questo minuto, dalle tre fonti:
//  - la sonda esterna (se il componente ne ha una): due fallimenti di fila = interruzione,
//    risposta lenta = rallentato;
//  - Dadaguard, che vede i segnali interni (un servizio giù dietro un'app che risponde ancora);
//  - un incidente aperto a mano: chi lo pubblica ha deciso che il cliente deve vederlo.
// Senza nessuna fonte che abbia detto qualcosa: unknown, mai un verde dedotto dal silenzio.
export function decide({ probe = null, fails = 0, interno = null, incident = null } = {}) {
  let s = 'unknown'
  if (probe) {
    if (probe.ok) s = worst(s, probe.ms > SLOW_MS ? 'degraded' : 'operational')
    else s = worst(s, fails >= FAILS_FOR_OUTAGE ? 'outage' : 'unknown')
  }
  if (interno && RANK[interno] !== undefined) s = worst(s, interno)
  if (incident) s = worst(s, incident)
  return s
}

// La data del giorno nel fuso della pagina (`YYYY-MM-DD`): le barre sono giorni del lettore, non
// giorni UTC, sennò un'interruzione alle 00:30 italiane finisce nel giorno prima.
export function dayKey(date, tz = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

// Aggiunge UN minuto di stati allo storico e butta i giorni oltre la finestra. Lo storico è
// `{ "<giorno>": { "<id>": { o, d, x, u } } }`: minuti operativi, rallentati, interrotti, ignoti.
export function addMinute(history, day, states, keepDays = HISTORY_DAYS) {
  const h = history && typeof history === 'object' ? { ...history } : {}
  const today = { ...(h[day] ?? {}) }
  for (const [id, s] of Object.entries(states)) {
    const c = { o: 0, d: 0, x: 0, u: 0, ...(today[id] ?? {}) }
    if (s === 'operational') c.o++
    else if (s === 'degraded') c.d++
    else if (s === 'outage') c.x++
    else c.u++
    today[id] = c
  }
  h[day] = today
  const days = Object.keys(h).sort()
  for (const d of days.slice(0, Math.max(0, days.length - keepDays))) delete h[d]
  return h
}

// Disponibilità su un insieme di conteggi: i minuti rallentati contano come disponibili (il
// servizio risponde), quelli ignoti non contano né a favore né contro. `null` senza misure.
export function availability(counts) {
  let up = 0
  let tot = 0
  for (const c of counts) {
    if (!c) continue
    up += (c.o ?? 0) + (c.d ?? 0)
    tot += (c.o ?? 0) + (c.d ?? 0) + (c.x ?? 0)
  }
  return tot === 0 ? null : up / tot
}

// ---------------------------------------------------------------------------------------------
// Incidenti e manutenzioni. Li scrive una persona dalla pagina /admin; qui si validano e si
// interrogano. Forma salvata:
//   { id, kind: 'incident'|'maintenance', impact: 'degraded'|'outage'|'maintenance',
//     components: [id], title: { it, en }, start, end|null, resolved: bool,
//     updates: [{ at, status, text: { it, en }, by }] }
// ---------------------------------------------------------------------------------------------

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved']
export const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed']
const MAX_TEXT = 2000
const MAX_TITLE = 140

function text(v, max) {
  if (typeof v !== 'string') return ''
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max)
}

function bilingual(v, max, field) {
  const it = text(v?.it, max)
  const en = text(v?.en, max)
  if (!it && !en) throw new Error(`${field}: serve almeno l'italiano o l'inglese`)
  return { it: it || en, en: en || it }
}

function isoOrNull(v, field) {
  if (v == null || v === '') return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`${field}: data non valida`)
  return d.toISOString()
}

// Valida un incidente o una manutenzione NUOVI. Lancia un errore leggibile, che la pagina di admin
// mostra così com'è.
export function validateNew(input, componentIds, { now = new Date(), by = null, id }) {
  const kind = input?.kind === 'maintenance' ? 'maintenance' : 'incident'
  const comps = Array.isArray(input?.components) ? [...new Set(input.components.filter((c) => componentIds.includes(c)))] : []
  if (comps.length === 0) throw new Error('scegli almeno un componente')
  const impact = kind === 'maintenance' ? 'maintenance' : input?.impact === 'outage' ? 'outage' : 'degraded'
  const statuses = kind === 'maintenance' ? MAINTENANCE_STATUSES : INCIDENT_STATUSES
  const status = statuses.includes(input?.status) ? input.status : statuses[0]
  const start = isoOrNull(input?.start, 'inizio') ?? now.toISOString()
  const end = isoOrNull(input?.end, 'fine')
  if (kind === 'maintenance' && !end) throw new Error('una manutenzione ha una fine prevista')
  if (end && end <= start) throw new Error('la fine viene prima dell\'inizio')
  const resolved = status === 'resolved' || status === 'completed'
  return {
    id,
    kind,
    impact,
    components: comps,
    title: bilingual(input?.title, MAX_TITLE, 'titolo'),
    start,
    end: resolved && !end ? now.toISOString() : end,
    resolved,
    updates: [{ at: now.toISOString(), status, text: bilingual(input?.text, MAX_TEXT, 'testo'), by }],
  }
}

// Aggiunge un aggiornamento. Uno stato finale chiude l'incidente e ne fissa la fine.
export function applyUpdate(item, input, { now = new Date(), by = null }) {
  const statuses = item.kind === 'maintenance' ? MAINTENANCE_STATUSES : INCIDENT_STATUSES
  if (!statuses.includes(input?.status)) throw new Error('stato non valido')
  const u = { at: now.toISOString(), status: input.status, text: bilingual(input?.text, MAX_TEXT, 'testo'), by }
  const resolved = input.status === 'resolved' || input.status === 'completed'
  const impact = item.kind === 'incident' && ['degraded', 'outage'].includes(input?.impact) ? input.impact : item.impact
  return {
    ...item,
    impact,
    resolved,
    end: resolved ? (item.end && item.end < u.at ? item.end : u.at) : item.end,
    updates: [u, ...item.updates],
  }
}

// È in corso adesso? Un incidente fino a quando non è risolto; una manutenzione nella sua finestra.
export function isActive(item, now = new Date()) {
  const t = now.toISOString()
  if (item.kind === 'maintenance') return !item.resolved && item.start <= t && (!item.end || t < item.end)
  return !item.resolved && item.start <= t
}

// L'impatto che un incidente aperto impone a un componente (la manutenzione non lo fa diventare
// rosso: è annunciata, e la pagina la mostra a parte).
export function incidentImpact(items, compId, now = new Date()) {
  let s = null
  for (const it of items) {
    if (it.kind !== 'incident' || !it.components.includes(compId) || !isActive(it, now)) continue
    s = s ? worst(s, it.impact) : it.impact
  }
  return s
}

// Tiene gli incidenti degli ultimi 90 giorni e le manutenzioni future.
export function pruneItems(items, now = new Date(), keepDays = HISTORY_DAYS) {
  const limit = new Date(now.getTime() - keepDays * 86400000).toISOString()
  return items.filter((i) => !i.resolved || (i.end ?? i.start) >= limit)
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

// Il feed RSS: un elemento per incidente o manutenzione, il più recente in cima.
export function toRss(items, { title, link, lang = 'it' }) {
  const sorted = [...items].sort((a, b) => (b.updates[0]?.at ?? b.start).localeCompare(a.updates[0]?.at ?? a.start))
  const entries = sorted
    .slice(0, 50)
    .map((i) => {
      const last = i.updates[0]
      const body = i.updates.map((u) => `${u.status}: ${u.text[lang] ?? u.text.it}`).join('\n\n')
      return `<item><title>${xml(i.title[lang] ?? i.title.it)}</title><link>${xml(`${link}#${i.id}`)}</link><guid isPermaLink="false">${xml(`${i.id}:${last?.at ?? i.start}`)}</guid><pubDate>${new Date(last?.at ?? i.start).toUTCString()}</pubDate><description>${xml(body)}</description></item>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(title)}</title><link>${xml(link)}</link><description>${xml(title)}</description><language>${lang}</language>${entries}</channel></rss>`
}
