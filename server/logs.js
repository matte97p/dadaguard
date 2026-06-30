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
import { clientOpts } from './runtime/awsClient.js'

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
  return null // tipo senza log applicativi su CloudWatch
}

// Ritorna { logGroup, events:[{ts,message}], truncated } | { notApplicable } | { logGroup, error }.
export async function recentLogs(service, accounts, { errorsOnly = false, minutes = 60, limit = 100 } = {}) {
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
  try {
    const out = await cw.send(
      new FilterLogEventsCommand({
        logGroupName: logGroup,
        startTime,
        limit: Math.min(Math.max(1, limit), 200), // finestra limitata: niente scansioni enormi
        ...(errorsOnly ? { filterPattern: ERROR_PATTERN } : {}),
      }),
    )
    const events = (out.events ?? []).map((e) => ({ ts: e.timestamp, message: (e.message ?? '').trimEnd() }))
    return { logGroup, events, truncated: Boolean(out.nextToken) }
  } catch (err) {
    return { logGroup, error: err.message } // es. group inesistente / permessi
  }
}
