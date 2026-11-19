// The pure logic of the status engine: no fetch, no KV, no implicit clock. The Worker (worker.js)
// calls it with data already read; the tests call it with invented data.

export const STATES = ['unknown', 'operational', 'degraded', 'outage']
const RANK = { unknown: 0, operational: 1, degraded: 2, outage: 3 }
export const worst = (a, b) => (RANK[b] > RANK[a] ? b : a)

// Una sonda sola che fallisce non fa rosso: la rete fra Cloudflare e l'origine ha i suoi
// singhiozzi, e una pagina che lampeggia rossa per un pacchetto perso vale meno di nessuna pagina.
export const FAILS_FOR_OUTAGE = 2
// Sopra questa latenza la sonda dice «rallentato», anche se risponde.
export const SLOW_MS = 5000
// After how long without a tick /health answers 503.
export const STALE_MS = 3 * 60 * 1000

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/

// `COMPONENTS` comes from the deploy config, as JSON: [{ "id": "web", "probe": "https://app.example.com/" }].
// The probe is optional. Names are not needed here: the public page (for example on Atlassian
// Statuspage) owns them, and extra fields from older configs are ignored. A malformed entry is
// dropped: one component fewer is better than an engine that does not start.
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
    if (!c || typeof c.id !== 'string' || !ID.test(c.id) || seen.has(c.id)) continue
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
    out.push({ id: c.id, probe })
  }
  return out
}

// The state of a component in this minute, from two sources:
//  - the external probe (when the component has one): two failures in a row = outage, a slow answer
//    = degraded;
//  - Dadaguard, which sees the internal signals (a service down behind an app that still answers).
// Incidents and maintenance are written on the public page itself (for example on Atlassian
// Statuspage), not here. With no source saying anything: unknown, never a green inferred from silence.
export function decide({ probe = null, fails = 0, interno = null } = {}) {
  let s = 'unknown'
  if (probe) {
    if (probe.ok) s = worst(s, probe.ms > SLOW_MS ? 'degraded' : 'operational')
    else s = worst(s, fails >= FAILS_FOR_OUTAGE ? 'outage' : 'unknown')
  }
  if (interno && RANK[interno] !== undefined) s = worst(s, interno)
  return s
}
