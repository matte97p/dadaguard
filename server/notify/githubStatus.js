import { log } from '../log.js'

// Gli incidenti APERTI di GitHub, dalla sua pagina di stato pubblica (Statuspage, senza credenziali).
// Quando GitHub Actions non smista i job, i run restano in coda o non nascono nemmeno: la CI non scrive
// niente, perché non gira, e il quadro vedeva solo «test avviati» per sempre. Con l'incidente letto da
// qui il quadro lo dice: un allarme suo, e la causa sull'allarme della coda (vedi quadro.js).
//
// Contano solo gli incidenti sui componenti che toccano un rilascio (`DADAGUARD_GITHUB_STATUS_COMPONENTI`,
// default `Actions,Webhooks`): uno su Pages o Copilot non ferma un deploy. Una lettura ogni due minuti,
// condizionale come le altre (ETag): la pagina cambia poco.
//
// Configurazione:
//   DADAGUARD_GITHUB_STATUS             `off` per spegnerlo; acceso di default quando c'è la GitHub App
//                                       (chi non usa GitHub Actions non vuole i suoi incidenti), `on` per
//                                       accenderlo anche senza
//   DADAGUARD_GITHUB_STATUS_URL         un'altra pagina Statuspage (GitHub Enterprise, una prova)
//   DADAGUARD_GITHUB_STATUS_COMPONENTI  i componenti che contano, separati da virgola

const URL_DEFAULT = 'https://www.githubstatus.com/api/v2/incidents/unresolved.json'
const COMPONENTI_DEFAULT = ['Actions', 'Webhooks']
export const OGNI_MS = 2 * 60_000
const TIMEOUT_MS = 5_000

export function githubStatusConfig(env = process.env, { conApp = false } = {}) {
  const acceso = String(env.DADAGUARD_GITHUB_STATUS ?? '').trim().toLowerCase()
  if (/^(0|no|false|off)$/.test(acceso)) return null
  if (!conApp && !/^(1|si|yes|true|on)$/.test(acceso)) return null
  const componenti = String(env.DADAGUARD_GITHUB_STATUS_COMPONENTI ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return { url: String(env.DADAGUARD_GITHUB_STATUS_URL ?? '').trim() || URL_DEFAULT, componenti: componenti.length ? componenti : COMPONENTI_DEFAULT }
}

// Dalla risposta di Statuspage gli incidenti che toccano i componenti scelti: `{ id, nome, stato, url,
// da, componenti }`. Un incidente senza componenti (succede nei primi minuti, prima che GitHub li
// colleghi) conta se il NOME ne nomina uno: «Incident with Actions and Pages». Il nome finisce su Slack:
// via i caratteri con cui Slack costruisce link e formattazione. Puro/testabile.
export function incidentiRilevanti(json, componenti = COMPONENTI_DEFAULT) {
  const cercati = componenti.map((c) => c.toLowerCase())
  const pulito = (t, n) => String(t ?? '').replace(/[<>&`*_~|]/g, '').trim().slice(0, n)
  return (json?.incidents ?? [])
    .filter((i) => i && !['resolved', 'postmortem'].includes(i.status))
    .map((i) => {
      const nomi = (i.components ?? []).map((c) => String(c?.name ?? '')).filter((n) => cercati.includes(n.toLowerCase()))
      const dalNome = !(i.components ?? []).length ? componenti.filter((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(i.name ?? '')) : []
      return { i, toccati: [...new Set([...nomi, ...dalNome])] }
    })
    .filter(({ toccati }) => toccati.length)
    .map(({ i, toccati }) => ({
      id: String(i.id ?? i.name),
      nome: pulito(i.name, 120) || 'incident',
      stato: pulito(i.status, 30) || null,
      url: /^https:\/\/[^\s<>|]+$/.test(i.shortlink ?? '') ? i.shortlink : null,
      da: i.created_at ?? null,
      componenti: toccati,
    }))
}

// Il lettore: tiene ETag e ultimo elenco fra un giro e l'altro. `leggi` non lancia mai: la pagina di
// stato che non risponde vuol dire l'elenco di prima, non un quadro fermo. `deps.fetch` per le prove.
export function nuovoGithubStatus(cfg, deps = {}) {
  if (!cfg) return null
  const fetchStato = deps.fetch ?? globalThis.fetch
  const mem = { prossimo: 0, etag: null, incidenti: [], errore: null }

  async function leggi({ ora = Date.now() } = {}) {
    if (ora < mem.prossimo) return mem.incidenti
    mem.prossimo = ora + OGNI_MS
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetchStato(cfg.url, {
        headers: { Accept: 'application/json', 'User-Agent': 'dadaguard', ...(mem.etag ? { 'If-None-Match': mem.etag } : {}) },
        signal: ctrl.signal,
      })
      if (res.status !== 304) {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const prima = new Set(mem.incidenti.map((i) => i.id))
        mem.incidenti = incidentiRilevanti(await res.json(), cfg.componenti)
        mem.etag = res.headers.get('etag')
        for (const i of mem.incidenti) if (!prima.has(i.id)) log.warn('quadro: incidente GitHub aperto', { incidente: i.nome, componenti: i.componenti })
      }
      if (mem.errore) log.info('quadro: pagina di stato di GitHub di nuovo leggibile')
      mem.errore = null
    } catch (err) {
      // Una volta sola finché l'errore resta lo stesso.
      if (mem.errore !== err.message) log.warn('quadro: pagina di stato di GitHub non letta, tengo gli incidenti di prima', { err: err.message })
      mem.errore = err.message
    } finally {
      clearTimeout(timer)
    }
    return mem.incidenti
  }

  return { leggi, mem }
}
