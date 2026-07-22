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
  const startTime = Date.now() - Math.max(1, minutes) * 60 * 1000
  const cap = Math.min(Math.max(1, limit), 200)
  try {
    // FilterLogEvents restituisce gli eventi dal PIÙ VECCHIO e PAGINA: con finestre larghe + "solo
    // errori" la prima pagina può coprire il tratto iniziale (senza match) e tornare VUOTA con un
    // nextToken → una sola chiamata farebbe sembrare "48h" vuoto mentre "24h" ha dati. Seguiamo il
    // token finché non riempiamo `cap` eventi, con un tetto di pagine per non spazzolare all'infinito.
    const events = []
    let nextToken
    let pages = 0
    const MAX_PAGES = 25
    do {
      const out = await cw.send(
        new FilterLogEventsCommand({
          logGroupName: logGroup,
          startTime,
          nextToken,
          limit: cap,
          ...(errorsOnly ? { filterPattern: ERROR_PATTERN } : {}),
        }),
      )
      for (const e of out.events ?? []) events.push({ ts: e.timestamp, message: (e.message ?? '').trimEnd() })
      nextToken = out.nextToken
      pages += 1
    } while (nextToken && events.length < cap && pages < MAX_PAGES)
    return { logGroup, events: events.slice(0, cap), truncated: Boolean(nextToken) }
  } catch (err) {
    return { logGroup, error: cleanAwsReason(err, t) } // es. group inesistente / permessi
  }
}
