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
  const problems = [] // letture non riuscite, per account: vanno DETTE, non inghiottite
  const lists = await mapLimit(jobs, CAP, async ({ key, a, region }) => {
    try {
      const { candidates, problems: probs } = await discover({
        profile: a.profile,
        roleArn: a.roleArn,
        externalId: a.externalId,
        region,
        stateBucket: a.terraform?.stateBucket,
      })
      // Letture fallite dentro l'account: un elenco AWS non dà errore quando non c'è nulla (torna
      // vuoto), quindi un errore qui è SEMPRE un problema reale — permessi, ruolo non assumibile,
      // throttling. Prima venivano inghiottite in silenzio e l'account risultava semplicemente
      // "vuoto": indistinguibile da un account sano senza risorse.
      if (probs?.length) {
        log.error('auto-discovery: letture non riuscite', { account: key, region, problems: probs })
        problems.push({ account: key, region, problems: probs })
      }
      // tagga la region solo se stiamo davvero spazzolando più region per l'account
      const tag = regionsOf(a).length > 1 ? region : undefined
      return candidatesToServices(candidates, key, tag)
    } catch (err) {
      log.error('auto-discovery fallita', { account: key, region, err: err.message })
      return []
    }
  })
  const services = lists.flat()
  // `problems` viaggia come proprietà della lista: i chiamanti che non la guardano si comportano come
  // prima, chi la guarda (lo stato) può dirlo in faccia all'utente.
  services.problems = problems
  return services
}

// Identità di una risorsa AWS monitorata: account + tipo + identificatori. Serve a de-duplicare
// quando si uniscono i servizi dichiarati (watchlist) con quelli scoperti: stessa risorsa = stessa
// chiave, anche se il `name` differisce (la watchlist usa nomi umani, la discovery il nome AWS).
//
// Viaggia anche nel payload dello stato (`resourceId`, vedi server/status.js) perché è l'UNICA
// identità che distingue due risorse che si somigliano in tutto il resto: due servizi ECS con lo
// stesso nome in cluster diversi dello stesso account e della stessa region hanno account, nome,
// tipo e region identici, e li separa solo il cluster. La UI la usa come chiave delle righe, dove
// due chiavi uguali lasciano righe fantasma nel DOM.
const ID_FIELDS = ['function', 'cluster', 'service', 'taskDefinition', 'instance', 'table', 'bucket', 'arn', 'id', 'stream', 'asg', 'instanceId', 'queue', 'url', 'topic']
export function serviceKey(s) {
  const a = s?.aws ?? {}
  return `${s?.account ?? ''}|${a.type ?? ''}|${ID_FIELDS.map((f) => a[f] ?? '').join('|')}`
}

// La stessa identità, ma solo se DAVVERO identifica: un servizio dichiarato a mano in services.yaml
// può non avere nessun identificatore di risorsa, e in quel caso la chiave sarebbe `account|tipo|||…`
// per tutti quanti, cioè una collisione travestita da identità. `null` dice "non lo so", e chi la usa
// ha un ripiego onesto (account + region + tipo + nome) invece di una chiave finta.
export function resourceId(s) {
  const a = s?.aws ?? {}
  if (!ID_FIELDS.some((f) => a[f])) return null
  return serviceKey(s)
}

// Il pezzo di identità da MOSTRARE quando due righe hanno lo stesso nome nello stesso account: il
// cluster di un servizio ECS, il gruppo di autoscaling, la famiglia di una task-def. Non è la chiave
// (quella è `resourceId`, che va bene per una macchina e non per un occhio): è la parola più corta che
// dice quale delle omonime stai guardando. Senza, quattro righe `acme-gateway` nello stesso account
// sono quattro righe identiche, e l'unico modo di distinguerle è aprirle una per una.
//
// `null` quando la risorsa non ha niente da aggiungere: un load balancer si chiama come il servizio
// che serve, quindi ripeterne il nome non distingue nulla, e fra quelle due righe è il TIPO a dire
// quale è quale (la UI lo mostra già accanto).
const QUALIFIER_FIELDS = ['cluster', 'asg', 'function', 'table', 'bucket', 'domain', 'stream', 'queue', 'instanceId', 'instance', 'id']
export function qualifier(s) {
  const a = s?.aws ?? {}
  for (const f of QUALIFIER_FIELDS) if (a[f]) return String(a[f])
  // Task-def schedulata: vale la FAMIGLIA (`…/famiglia:3` → famiglia), che è il nome del cron.
  if (!a.taskDefinition) return null
  return String(a.taskDefinition).split('/').pop().split(':')[0] || null
}

// Unione watchlist + servizi scoperti: i DICHIARATI vincono (conservano i loro override); un
// servizio scoperto si aggiunge solo se la sua risorsa non è già in watchlist.
export function mergeServices(declared, discovered) {
  const seen = new Set((declared ?? []).map(serviceKey))
  return [...(declared ?? []), ...(discovered ?? []).filter((s) => !seen.has(serviceKey(s)))]
}
