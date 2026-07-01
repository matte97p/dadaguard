// #7 CAUSALITÀ: cosa ha CAMBIATO una risorsa di recente. Mentre "Eventi" mostra gli eventi
// operativi (ECS/RDS/ASG), qui leggiamo CloudTrail (LookupEvents) per la risorsa: le chiamate
// API di scrittura (chi/cosa/quando) — la "causa" dietro un servizio diventato giallo/rosso.
// Read-only, on-demand. Permesso: cloudtrail:LookupEvents (eventi di management, ~90gg).
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'

// Identificatore della risorsa per la lookup CloudTrail (ResourceName). Puro/testabile.
export function resourceName(service) {
  const a = service?.aws ?? {}
  switch (a.type) {
    case 'lambda': return a.function ?? null
    case 'ecs': return a.service ?? null
    case 'rds': return a.cluster ?? a.instance ?? null
    case 'asg': return a.asg ?? null
    case 'ec2': return a.instanceId ?? null
    case 'dynamodb': return a.table ?? null
    case 's3': return a.bucket ?? null
    case 'kinesis': return a.stream ?? null
    case 'sqs': return a.queue ?? null
    case 'elasticache': return a.cluster ?? null
    case 'eks': return a.cluster ?? null
    case 'cloudfront': return a.id ?? null
    case 'apigateway': return a.apiName ?? null
    case 'alb': return a.name ?? null
    case 'sns': return a.arn ? a.arn.split(':').pop() : null
    case 'sfn': return a.arn ? a.arn.split(':').pop() : null
    default: return null
  }
}

export async function recentChanges(service, accounts, { hours = 24, limit = 15 } = {}) {
  const name = resourceName(service)
  if (!name) return { notApplicable: true }
  const acct = service.account ? accounts[service.account] : null
  const aws = {
    profile: acct?.profile,
    roleArn: acct?.roleArn,
    externalId: acct?.externalId,
    region: service.aws?.region ?? acct?.region,
  }
  try {
    const ct = new CloudTrailClient(clientOpts(aws))
    const end = new Date()
    const start = new Date(end.getTime() - hours * 3600 * 1000)
    const out = await ct.send(
      new LookupEventsCommand({
        LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: name }],
        StartTime: start,
        EndTime: end,
        MaxResults: limit,
      }),
    )
    const changes = (out.Events ?? []).map((e) => {
      let errorCode = null
      try {
        errorCode = JSON.parse(e.CloudTrailEvent || '{}').errorCode ?? null
      } catch {
        /* payload non-JSON: ignora */
      }
      return {
        ts: e.EventTime,
        eventName: e.EventName,
        user: e.Username ?? null,
        source: e.EventSource ?? null,
        errorCode,
      }
    })
    return { changes }
  } catch (err) {
    return { error: cleanAwsReason(err) }
  }
}
