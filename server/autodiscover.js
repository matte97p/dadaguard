import { discover, candidatesToServices } from './discover.js'
import { mapLimit } from './util/pool.js'
import { log } from './log.js'

// Region da spazzolare per un account: `regions: [...]` (sweep multi-region #8) o la singola region.
function regionsOf(a) {
  if (Array.isArray(a.regions) && a.regions.length) return a.regions
  return [a.region] // anche undefined → la catena di default AWS sceglie la region
}

// Auto-discovery zero-config (#1) + sweep multi-region (#8): se non c'è alcun servizio
// dichiarato, scopre quelli che girano in OGNI account e OGNI region (read-only, in memoria —
// non scrive nulla). services.yaml resta un OVERRIDE. Account e (account×region) in parallelo
// con un cap, per non aprire troppe chiamate AWS insieme.
export async function autoDiscoverServices(accounts) {
  const jobs = []
  for (const [key, a] of Object.entries(accounts ?? {})) {
    for (const region of regionsOf(a)) jobs.push({ key, a, region })
  }
  const CAP = Number(process.env.DADAGUARD_CONCURRENCY) || 8
  const lists = await mapLimit(jobs, CAP, async ({ key, a, region }) => {
    try {
      const { candidates } = await discover({
        profile: a.profile,
        roleArn: a.roleArn,
        externalId: a.externalId,
        region,
        stateBucket: a.terraform?.stateBucket,
      })
      // tagga la region solo se stiamo davvero spazzolando più region per l'account
      const tag = regionsOf(a).length > 1 ? region : undefined
      return candidatesToServices(candidates, key, tag)
    } catch (err) {
      log.error('auto-discovery fallita', { account: key, region, err: err.message })
      return []
    }
  })
  return lists.flat()
}

// Identità di una risorsa AWS monitorata: account + tipo + identificatori. Serve a de-duplicare
// quando si uniscono i servizi dichiarati (watchlist) con quelli scoperti: stessa risorsa = stessa
// chiave, anche se il `name` differisce (la watchlist usa nomi umani, la discovery il nome AWS).
const ID_FIELDS = ['function', 'cluster', 'service', 'instance', 'table', 'bucket', 'arn', 'id', 'stream', 'asg', 'instanceId', 'queue', 'url', 'topic']
export function serviceKey(s) {
  const a = s?.aws ?? {}
  return `${s?.account ?? ''}|${a.type ?? ''}|${ID_FIELDS.map((f) => a[f] ?? '').join('|')}`
}

// Unione watchlist + servizi scoperti: i DICHIARATI vincono (conservano i loro override); un
// servizio scoperto si aggiunge solo se la sua risorsa non è già in watchlist.
export function mergeServices(declared, discovered) {
  const seen = new Set((declared ?? []).map(serviceKey))
  return [...(declared ?? []), ...(discovered ?? []).filter((s) => !seen.has(serviceKey(s)))]
}
