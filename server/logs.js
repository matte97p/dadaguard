// Log recenti di una risorsa, on-demand (read-only, zero storage): la naturale risposta a
// "perché è rosso?". Risolve il log group e legge gli ultimi eventi via FilterLogEvents.
//  - lambda → /aws/lambda/<function> (deterministico)
//  - ecs    → log group dal task definition (logDriver awslogs)
//  - override → aws.logGroup per qualunque tipo
// Permessi: logs:FilterLogEvents (+ ecs:DescribeServices/DescribeTaskDefinition già concessi).
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'

// pattern CloudWatch: eventi che contengono uno di questi termini (OR)
const ERROR_PATTERN = '?ERROR ?Error ?error ?Exception ?exception ?FATAL ?CRITICAL ?Traceback'

async function resolveLogGroup(service, aws) {
  const cfg = service.aws ?? {}
  if (cfg.logGroup) return cfg.logGroup // override esplicito
  if (cfg.type === 'lambda' && cfg.function) return `/aws/lambda/${cfg.function}`
  if (cfg.type === 'ecs') {
    const ecs = new ECSClient(clientOpts(aws))
    const svc = (await ecs.send(new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }))).services?.[0]
    if (!svc?.taskDefinition) return null
    const td = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: svc.taskDefinition }))).taskDefinition
    for (const c of td?.containerDefinitions ?? []) {
      if (c.logConfiguration?.logDriver === 'awslogs') return c.logConfiguration.options?.['awslogs-group'] ?? null
    }
    return null
  }
  // cron su ECS RunTask: il log group sta nella task-def schedulata (nessun servizio da interrogare).
  if (cfg.type === 'ecs-scheduled' && cfg.taskDefinition) {
    const ecs = new ECSClient(clientOpts(aws))
    const td = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: cfg.taskDefinition }))).taskDefinition
    for (const c of td?.containerDefinitions ?? []) {
      if (c.logConfiguration?.logDriver === 'awslogs') return c.logConfiguration.options?.['awslogs-group'] ?? null
    }
    return null
  }
  return null // tipo senza log applicativi su CloudWatch
}

// FETTE A RITROSO, dalla più recente alla più vecchia, in minuti-fa: `[fromAgo, toAgo]`.
// Servono perché FilterLogEvents restituisce gli eventi dal PIÙ VECCHIO: chiedere "le ultime 100
// righe" alla finestra intera dà le 100 più VECCHIE. Su un servizio chiacchierone (3 nodi ALB che
// fanno health-check ogni 10s = ~1000 righe/h) il tetto si esaurisce nei primi 90 secondi della
// finestra, e l'attività di adesso — quella per cui hai aperto il pannello — non compare affatto.
//
// Le fette crescono (1, 2, 4, 8… minuti): sui casi densi la prima basta, e una finestra da 48h senza
// nessun match si copre in una ventina di chiamate invece di seicento. Tetto per fetta a 4h: oltre,
// una singola chiamata tornerebbe a spazzolare troppo per riempire il tetto di righe.
export function backwardSlices(minutes) {
  const out = []
  let toAgo = 0
  let size = 1
  while (toAgo < minutes) {
    out.push([toAgo, Math.min(minutes, toAgo + size)])
    toAgo += size
    size = Math.min(size * 2, 240)
  }
  return out
}

const MAX_PAGES_PER_SLICE = 10
const MAX_PAGES_TOTAL = 40

// Le `need` righe PIÙ RECENTI di una fetta, in ordine cronologico. `more` = nella fetta c'era altro
// prima di queste (scartato di proposito, o pagine finite): serve a marcare la risposta troncata.
async function readSlice(cw, params, need, budget) {
  const events = []
  let nextToken
  let pages = 0
  let dropped = false
  do {
    const out = await cw.send(new FilterLogEventsCommand({ ...params, nextToken }))
    for (const e of out.events ?? []) events.push({ ts: e.timestamp, message: (e.message ?? '').trimEnd() })
    if (events.length > need) {
      events.splice(0, events.length - need) // teniamo la CODA: dentro la fetta i più recenti stanno in fondo
      dropped = true
    }
    nextToken = out.nextToken
    pages += 1
    budget.pages += 1
  } while (nextToken && pages < MAX_PAGES_PER_SLICE && budget.pages < MAX_PAGES_TOTAL)
  return { events, more: dropped || Boolean(nextToken) }
}

// Ritorna { logGroup, events:[{ts,message}], truncated } | { notApplicable } | { logGroup, error }.
export async function recentLogs(service, accounts, { errorsOnly = false, minutes = 60, limit = 100, t = (k) => k } = {}) {
  const acct = service.account ? accounts[service.account] : null
  const aws = {
    profile: acct?.profile,
    roleArn: acct?.roleArn,
    externalId: acct?.externalId,
    region: service.aws?.region ?? acct?.region,
  }

  let logGroup
  try {
    logGroup = await resolveLogGroup(service, aws)
  } catch {
    logGroup = null
  }
  if (!logGroup) return { notApplicable: true }

  const cw = new CloudWatchLogsClient(clientOpts(aws))
  const now = Date.now()
  const cap = Math.min(Math.max(1, limit), 200)
  try {
    // "Log recenti" vuol dire le righe più recenti: si raccoglie dal presente verso il passato e si
    // ferma appena il tetto è pieno. Le fette più vecchie non vengono nemmeno chieste.
    const events = [] // ordine finale: dal più vecchio al più recente (come li legge il pannello)
    let truncated = false
    const budget = { pages: 0 }
    for (const [fromAgo, toAgo] of backwardSlices(Math.max(1, minutes))) {
      const need = cap - events.length
      if (need <= 0 || budget.pages >= MAX_PAGES_TOTAL) {
        truncated = true
        break
      }
      const slice = await readSlice(
        cw,
        {
          logGroupName: logGroup,
          startTime: now - toAgo * 60 * 1000,
          endTime: now - fromAgo * 60 * 1000,
          ...(errorsOnly ? { filterPattern: ERROR_PATTERN } : {}),
        },
        need,
        budget,
      )
      events.unshift(...slice.events) // la fetta appena letta è più vecchia di quelle già raccolte
      if (slice.more) truncated = true
    }
    return { logGroup, events, truncated }
  } catch (err) {
    return { logGroup, error: cleanAwsReason(err, t) } // es. group inesistente / permessi
  }
}
