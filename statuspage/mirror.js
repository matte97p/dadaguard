// Copia lo stato dei componenti su una pagina Atlassian Statuspage, per chi vuole la pagina su un
// vendor ma lo stato deciso dai propri segnali (sonde, Dadaguard, incidenti di /admin).
//
// Si spinge solo quello che cambia: ogni minuto si confronta lo stato voluto con l'ultimo che
// Statuspage ha accettato, e una chiamata fallita resta "da mandare" e si riprova al giro dopo.
// `unknown` non si spinge mai: se non sappiamo, lasciamo su Statuspage l'ultimo stato vero invece
// di inventarne uno.
//
// Configurazione: vars `ATLASSIAN_PAGE_ID` e `ATLASSIAN_COMPONENTS` (JSON, id nostro -> id del
// componente su Statuspage), secret `ATLASSIAN_API_KEY`. Senza uno dei tre la copia è spenta.

const API = 'https://api.statuspage.io/v1'
const TIMEOUT_MS = 8000
const ID = /^[a-z0-9]{1,64}$/i

const STATO_ATLASSIAN = {
  operational: 'operational',
  degraded: 'degraded_performance',
  outage: 'major_outage',
}

// La mappa id nostro -> id Statuspage. Una voce malformata si scarta, come per i componenti.
export function parseMirrorMap(raw, ourIds) {
  let obj
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return {}
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out = {}
  for (const [id, remote] of Object.entries(obj)) {
    if (ourIds.includes(id) && typeof remote === 'string' && ID.test(remote)) out[id] = remote
  }
  return out
}

// Lo stato da mostrare su Statuspage, o null se non c'è niente di certo da dire.
export function toAtlassian(state, maintenance = false) {
  if (maintenance) return 'under_maintenance'
  return STATO_ATLASSIAN[state] ?? null
}

// Le chiamate da fare in questo giro: solo i componenti il cui stato voluto è diverso dall'ultimo
// accettato da Statuspage.
export function mirrorPlan({ states, maintenance = {}, map, sent = {} }) {
  const out = []
  for (const [id, remote] of Object.entries(map)) {
    const want = toAtlassian(states[id], Boolean(maintenance[id]))
    if (want && sent[id] !== want) out.push({ id, remote, status: want })
  }
  return out
}

export function mirrorEnabled(env) {
  return Boolean(env.ATLASSIAN_PAGE_ID && env.ATLASSIAN_API_KEY && env.ATLASSIAN_COMPONENTS)
}

// Esegue il piano, una chiamata alla volta (Statuspage limita le richieste per chiave), e restituisce
// il nuovo "ultimo accettato". Un errore non ferma gli altri componenti e non tocca il loro stato.
export async function pushMirror(env, plan, sent = {}) {
  const next = { ...sent }
  for (const p of plan) {
    try {
      const res = await fetch(`${API}/pages/${encodeURIComponent(env.ATLASSIAN_PAGE_ID)}/components/${encodeURIComponent(p.remote)}`, {
        method: 'PATCH',
        headers: { authorization: `OAuth ${env.ATLASSIAN_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ component: { status: p.status } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) next[p.id] = p.status
      else console.error(JSON.stringify({ evento: 'copia statuspage rifiutata', id: p.id, http: res.status }))
    } catch (err) {
      console.error(JSON.stringify({ evento: 'copia statuspage fallita', id: p.id, err: err.message }))
    }
  }
  return next
}
