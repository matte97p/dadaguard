// WAF Cloudflare — richieste che il firewall ha FERMATO, per zona e per regola.
//
// Perché sta in un watchdog di coerenza e non in un pannello di sicurezza: una richiesta bloccata dal
// WAF non risulta da nessuna parte a valle. Il servizio è verde, i log applicativi sono puliti, le
// metriche ECS non si muovono — semplicemente l'utente non è mai arrivato. È il caso peggiore di
// "il tuo 200 OK mente": non c'è nemmeno un 500 da guardare.
//
// La distinzione che conta è fra AZIONI: `log` osserva e lascia passare, `block`/`challenge` fermano.
// Sono tenute separate perché mettere una regola in `log` NON evita che un'altra blocchi la stessa
// richiesta: chi guarda un totale unico conclude di aver disinnescato il problema mentre il traffico
// continua a cadere.
//
// Fonte: GraphQL Analytics (`firewallEventsAdaptiveGroups`). Scope token: Zone:Read + Zone Analytics:Read.
// Read-only. Nessun dato personale: si aggrega per regola/host/percorso, mai per IP o user agent.
import { cloudflareToken } from './cfToken.js'
import { mapLimit } from './util/pool.js'
import { truncateItems } from './util/format.js'
import { cachedCall } from './util/cache.js'

const API = 'https://api.cloudflare.com/client/v4'
const TTL_MS = 5 * 60 * 1000 // le analytics Cloudflare si aggiornano a minuti: 5 min non perde nulla
const MAX_ZONES = 20

// Azioni che FERMANO la richiesta (l'utente non arriva). Tutto il resto (`log`, `allow`, `skip`) la
// lascia passare: va contato a parte, non sommato. Puro/testabile.
// Cloudflare scrive la stessa azione in più forme (`managed_challenge`, `managedChallenge`): si
// normalizza togliendo separatori e maiuscole, così una forma nuova non finisce per sbaglio fra le
// "passate".
const BLOCKING = new Set(['block', 'drop', 'challenge', 'jschallenge', 'managedchallenge'])
export function isBlockingAction(action) {
  return BLOCKING.has(
    String(action ?? '')
      .toLowerCase()
      .replace(/[-_]/g, ''),
  )
}

// Sorgente della regola → categoria stabile, che dice DOVE si aggiusta: `custom` è una regola scritta
// da noi (quindi in IaC), `managed` è il ruleset gestito da Cloudflare, `ratelimit` è il rate limiting.
// Tre posti diversi. Si ritorna la categoria, non l'etichetta: il testo lo traduce la UI. Puro/testabile.
export function ruleSourceKind(source) {
  const s = String(source ?? '').toLowerCase()
  if (s.includes('ratelimit')) return 'ratelimit'
  if (s.includes('custom')) return 'custom'
  if (s.includes('managed') || s === 'waf') return 'managed'
  if (s.includes('bot')) return 'bot'
  if (s.includes('securitylevel')) return 'securitylevel'
  return 'other'
}

// Nodi `firewallEventsAdaptiveGroups` → riepilogo per zona. Le regole sono ordinate per richieste
// FERMATE (non per totale): una regola con un milione di `log` non è un problema, una che blocca
// diecimila richieste lo è. Puro/testabile.
export function summarizeFirewall(nodes = []) {
  let blocked = 0
  let logged = 0
  const byRule = new Map()
  const byHost = new Map()
  for (const n of nodes) {
    const d = n.dimensions ?? {}
    const count = n.count ?? 0
    const blocking = isBlockingAction(d.action)
    if (blocking) blocked += count
    else logged += count
    const key = `${d.ruleId ?? '?'}:${d.action ?? '?'}`
    const rule = byRule.get(key) ?? {
      ruleId: d.ruleId ?? null,
      action: d.action ?? null,
      source: d.source ?? null,
      sourceKind: ruleSourceKind(d.source),
      blocking,
      count: 0,
      hosts: new Set(),
      paths: new Set(),
    }
    rule.count += count
    if (d.clientRequestHTTPHost) rule.hosts.add(d.clientRequestHTTPHost)
    if (d.clientRequestPath) rule.paths.add(d.clientRequestPath)
    byRule.set(key, rule)
    if (blocking && d.clientRequestHTTPHost) byHost.set(d.clientRequestHTTPHost, (byHost.get(d.clientRequestHTTPHost) ?? 0) + count)
  }
  const rules = [...byRule.values()]
    // Tagliare host e percorsi a tre SENZA dirlo fa concludere che la regola scatti solo su quelli: il
    // «+N» è la differenza tra una lista corta e una lista sbagliata. Stessa regola delle altre liste.
    .map((r) => ({ ...r, hosts: truncateItems([...r.hosts], 3), paths: truncateItems([...r.paths], 3) }))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.count - a.count)
  return {
    blocked,
    logged,
    rules,
    hosts: [...byHost.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count),
  }
}

async function cfPost(token, body) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (json?.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; ')) // GraphQL: errori con HTTP 200
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return json
}

const query = (dims) =>
  `query($zone:String!,$since:Time!){viewer{zones(filter:{zoneTag:$zone}){firewallEventsAdaptiveGroups(limit:60,filter:{datetime_geq:$since},orderBy:[count_DESC]){count dimensions{${dims}}}}}}`

const DIMS_RICH = 'action source ruleId clientRequestHTTPHost clientRequestPath'
const DIMS_MIN = 'action source ruleId'

// Eventi firewall di UNA zona. Come per le analytics dei Worker: prima la query ricca (host e
// percorso — il "cosa non è arrivato"), poi la minima se lo schema o il token non la concedono.
async function zoneFirewall(token, zoneTag, since) {
  const run = async (dims) => {
    const json = await cfPost(token, { query: query(dims), variables: { zone: zoneTag, since } })
    return json?.data?.viewer?.zones?.[0]?.firewallEventsAdaptiveGroups ?? []
  }
  try {
    return summarizeFirewall(await run(DIMS_RICH))
  } catch {
    return summarizeFirewall(await run(DIMS_MIN))
  }
}

// Il piano serve, non è un dettaglio anagrafico: `firewallEventsAdaptiveGroups` non è compreso nel
// piano Free, e su quelle zone Cloudflare risponde «zone ... does not have access to the path». È una
// condizione permanente, non un guasto — quindi la si riconosce PRIMA di interrogare.
async function listZones(token) {
  const res = await fetch(`${API}/zones?per_page=50`, { headers: { authorization: `Bearer ${token}` } })
  const json = await res.json().catch(() => null)
  if (!res.ok || json?.success === false) {
    const msg = (json?.errors ?? []).map((e) => e.message).join('; ') || `HTTP ${res.status}`
    throw new Error(`${msg} — serve lo scope Zone:Read sul token Cloudflare`)
  }
  return (json.result ?? [])
    .map((z) => ({ id: z.id, name: z.name, plan: z.plan?.legacy_id ?? null }))
    .slice(0, MAX_ZONES)
}

// Piani senza il dataset firewall analytics. Si elencano quelli ESCLUSI e non quelli ammessi: un piano
// nuovo deve essere provato e fallire una volta, non essere zittito per sempre da una lista bianca.
const NO_FIREWALL_ANALYTICS = new Set(['free'])
const noDatasetError = (msg) => /does not have access to the path/i.test(String(msg ?? ''))

// Riepilogo WAF di tutte le zone. Nessun token → null (integrazione spenta, come le altre viste
// Cloudflare). Una zona che non risponde porta il suo errore, senza far cadere le altre: gli scope
// dei token Cloudflare sono per-scopo e capita che ne manchi uno solo.
export async function wafOverview({ hours = 24 } = {}) {
  const cred = cloudflareToken()
  if (!cred) return null
  return cachedCall(`waf:${hours}`, TTL_MS, async () => {
    const since = new Date(Date.now() - hours * 3600_000).toISOString()
    let zones
    try {
      zones = await listZones(cred.token)
    } catch (err) {
      return { hours, error: err.message, zones: [] }
    }
    const out = await mapLimit(zones, 4, async (z) => {
      const base = { zone: z.name, zoneId: z.id, plan: z.plan }
      // Domini parcheggiati su piano Free: niente dataset da chiedere. Saltare la chiamata non è solo
      // cosmetico — erano 8 richieste per ogni refresh che potevano solo fallire.
      if (NO_FIREWALL_ANALYTICS.has(z.plan)) return { ...base, noDataset: true }
      try {
        return { ...base, ...(await zoneFirewall(cred.token, z.id, since)) }
      } catch (err) {
        if (noDatasetError(err.message)) return { ...base, noDataset: true }
        return { ...base, error: err.message }
      }
    })
    // Prima le zone dove qualcosa è stato fermato: sono le uniche su cui c'è da decidere.
    return { hours, zones: out.sort((a, b) => (b.blocked ?? 0) - (a.blocked ?? 0)) }
  })
}
