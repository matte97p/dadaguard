// Copia lo stato dei componenti su una pagina Atlassian Statuspage, per chi vuole la pagina su un
// vendor ma lo stato deciso dai propri segnali (sonde e Dadaguard).
//
// Every minute the engine reads what Statuspage shows and pushes a component only when the page
// differs from the measured state: after our own change (compared with the last state Statuspage
// accepted, so a failed call is retried on the next tick), or whenever the page shows `operational`
// while we measure a problem (for example a maintenance that ended by setting it back to operational).
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

// The calls to make on this tick, given what Statuspage shows now (`remote`, Statuspage id -> state).
// A component is pushed when the page differs from the measured state and is not in a maintenance,
// and either:
//  - the measured state changed since the last one Statuspage accepted (`sent`), or
//  - the page shows `operational` while we measure a problem. A maintenance window can end by setting
//    the component back to operational: if it was down before and is still down, nothing changed for
//    us, and without this the page would stay green.
// Any other state set by someone else (a person on an incident, partial or worse) is left alone until
// the measured state changes: the page never shows green on a problem, but a person's call on how bad
// it is stands. A component missing from the listing falls back to `sent` alone.
export function mirrorPlan({ states, map, sent = {}, remote = {} }) {
  const out = []
  for (const [id, remoteId] of Object.entries(map)) {
    const want = toAtlassian(states[id])
    if (!want) continue
    const shown = remote[remoteId]
    if (shown === want || maintenanceByVendor(shown)) continue
    const changed = sent[id] !== want
    const greenOnAProblem = shown === 'operational'
    if (changed || greenOnAProblem) out.push({ id, remote: remoteId, status: want })
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

// Legge lo stato su Statuspage, ne ricava il piano (mirrorPlan) e lo esegue, una chiamata alla volta
// (Statuspage limita le richieste per chiave). La lettura si fa a OGNI giro anche senza niente da
// mandare: e' il battito che dice se Statuspage ci accetta ancora (chiave revocata, limite di
// richieste, guasto loro). Restituisce { sent, ok }: `sent` e' il nuovo "ultimo accettato", `ok` e'
// falso se la lettura o un invio e' fallito. Senza lettura non manda niente, perche' potrebbe coprire
// una manutenzione.
export async function pushMirror(env, { states, map }, sent = {}) {
  const next = { ...sent }
  const remote = await remoteStatuses(env)
  if (!remote) {
    console.error(JSON.stringify({ evento: 'copia statuspage rimandata', motivo: 'stato su Statuspage non leggibile' }))
    return { sent: next, ok: false }
  }
  // A component that Statuspage already shows in the measured state counts as accepted, so `sent`
  // follows the page (for example after a maintenance) and is never older than what it shows.
  for (const [id, remoteId] of Object.entries(map)) {
    const want = toAtlassian(states[id])
    if (want && remote[remoteId] === want) next[id] = want
  }
  let ok = true
  for (const p of mirrorPlan({ states, map, sent, remote })) {
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
