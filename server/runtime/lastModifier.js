import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail'
import { clientOpts } from './awsClient.js'
import { principalName } from '../util/principal.js'

// Ultimo modificatore di una risorsa via CloudTrail — GENERICO per tutti i tipi AWS.
// Trova l'evento di SCRITTURA più recente (readOnly=false) sulla risorsa e ne estrae il principal.
// Usare readOnly=false (invece di elencare i nomi-evento per servizio) rende l'helper universale.
// Best-effort: CloudTrail negato/throttle/vuoto → null. Cache: con `cacheKey` (es. fn@LastModified)
// è precisa e permanente (si invalida al cambio chiave); senza, TTL (evita raffiche su ogni refresh).
// GLI ERRORI NON SI CACHANO → si ritenta al refresh successivo finché non riesce (throttle 2 TPS).

const DEFAULT_TTL_MS = 30 * 60 * 1000
const _cache = new Map() // key → { who, at }

const arnTail = (arn) => (arn ? String(arn).split(/[:/]/).filter(Boolean).pop() : null)

// Identificatore da passare a CloudTrail ResourceName, per tipo. Puro/testabile.
// null = tipo non mappabile (nessun lookup) o `ecs-scheduled` (il "chi" lo dà registeredBy).
export function resourceIdentifier(aws) {
  switch (aws?.type) {
    case 'lambda':
      return aws.function ?? null
    case 'ecs':
      return aws.service ?? null
    case 'rds':
      return aws.cluster ?? aws.instance ?? null
    case 'sqs':
      return aws.queue ?? null
    case 'dynamodb':
      return aws.table ?? null
    case 's3':
      return aws.bucket ?? null
    case 'elasticache':
      return aws.cluster ?? null
    case 'kinesis':
      return aws.stream ?? null
    case 'opensearch':
      return aws.domain ?? null
    case 'eks':
      return aws.cluster ?? null
    case 'cloudfront':
      return aws.id ?? null
    case 'alb':
      return aws.name ?? null
    case 'ec2':
      return aws.instanceId ?? null
    case 'apigateway':
      return aws.apiName ?? null
    case 'sns':
    case 'sfn':
    case 'acm':
      return arnTail(aws.arn)
    default:
      return null
  }
}

const parseEvent = (raw) => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function lastModifier(resourceName, aws, { cacheKey, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!resourceName) return null
  const key = cacheKey ?? `ttl:${resourceName}`
  const hit = _cache.get(key)
  if (hit && (cacheKey || now - hit.at < ttlMs)) return hit.who
  try {
    const ct = new CloudTrailClient(clientOpts(aws))
    const out = await ct.send(
      new LookupEventsCommand({
        LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: resourceName }],
        MaxResults: 20, // più recenti prima; prendiamo il primo evento di scrittura
      }),
    )
    let who = null
    for (const e of out.Events ?? []) {
      const rec = parseEvent(e.CloudTrailEvent)
      if (rec && rec.readOnly === false) {
        who = e.Username || principalName(rec.userIdentity?.arn)
        break
      }
    }
    _cache.set(key, { who, at: now }) // successo (anche "nessun evento") → cache
    return who
  } catch {
    return null // throttle/denied → non cache: ritenta al prossimo refresh
  }
}
