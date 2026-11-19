// Copia lo stato dei componenti su una pagina Atlassian Statuspage, per chi vuole la pagina su un
// vendor ma lo stato deciso dai propri segnali (sonde e Dadaguard).
//
// Si spinge solo quello che cambia: ogni minuto si confronta lo stato voluto con l'ultimo che
// Statuspage ha accettato, e una chiamata fallita resta "da mandare" e si riprova al giro dopo.
// `unknown` non si spinge mai: se non sappiamo, lasciamo su Statuspage l'ultimo stato vero invece
// di inventarne uno. Incidents and maintenance are opened on Statuspage by a person.
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
export function toAtlassian(state) {
  return STATO_ATLASSIAN[state] ?? null
}

// Le chiamate da fare in questo giro: solo i componenti il cui stato voluto è diverso dall'ultimo
// accettato da Statuspage.
export function mirrorPlan({ states, map, sent = {} }) {
  const out = []
  for (const [id, remote] of Object.entries(map)) {
    const want = toAtlassian(states[id])
    if (want && sent[id] !== want) out.push({ id, remote, status: want })
  }
  return out
}

export function mirrorEnabled(env) {
  return Boolean(env.ATLASSIAN_PAGE_ID && env.ATLASSIAN_API_KEY && env.ATLASSIAN_COMPONENTS)
}

// Le manutenzioni annunciate su Statuspage mettono da sole i componenti in `under_maintenance` per la
// finestra. In una manutenzione vera i servizi spesso si fermano davvero: senza questo controllo il
// Worker vedrebbe le sonde fallire e scriverebbe `major_outage` sopra la manutenzione, e un lavoro
// annunciato ai clienti diventerebbe un guasto. Quindi: un componente che su Statuspage e' in
// manutenzione non si tocca finche' la finestra non si chiude. The engine never sends
// `under_maintenance` itself, so every maintenance seen there was opened on the vendor.
export function maintenanceByVendor(remoteStatus) {
  return remoteStatus === 'under_maintenance'
}

async function remoteStatuses(env) {
  try {
    const res = await fetch(`${API}/pages/${encodeURIComponent(env.ATLASSIAN_PAGE_ID)}/components`, {
      headers: { authorization: `OAuth ${env.ATLASSIAN_API_KEY}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const out = {}
    for (const c of await res.json()) if (c?.id && c?.status) out[c.id] = c.status
    return out
  } catch {
    return null
  }
}

// Esegue il piano, una chiamata alla volta (Statuspage limita le richieste per chiave). Legge prima lo
// stato su Statuspage, e lo fa a OGNI giro anche senza niente da mandare: e' il battito che dice se
// Statuspage ci accetta ancora (chiave revocata, limite di richieste, guasto loro). Restituisce
// { sent, ok }: `sent` e' il nuovo "ultimo accettato", `ok` e' falso se la lettura o un invio e' fallito.
// Senza lettura non manda niente, perche' potrebbe coprire una manutenzione.
export async function pushMirror(env, plan, sent = {}) {
  const next = { ...sent }
  const remote = await remoteStatuses(env)
  if (!remote) {
    console.error(JSON.stringify({ evento: 'copia statuspage rimandata', motivo: 'stato su Statuspage non leggibile' }))
    return { sent: next, ok: false }
  }
  let ok = true
  for (const p of plan) {
    if (maintenanceByVendor(remote[p.remote])) continue
    try {
      const res = await fetch(`${API}/pages/${encodeURIComponent(env.ATLASSIAN_PAGE_ID)}/components/${encodeURIComponent(p.remote)}`, {
        method: 'PATCH',
        headers: { authorization: `OAuth ${env.ATLASSIAN_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ component: { status: p.status } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) next[p.id] = p.status
      else {
        ok = false
        console.error(JSON.stringify({ evento: 'copia statuspage rifiutata', id: p.id, http: res.status }))
      }
    } catch (err) {
      ok = false
      console.error(JSON.stringify({ evento: 'copia statuspage fallita', id: p.id, err: err.message }))
    }
  }
  return { sent: next, ok }
}
