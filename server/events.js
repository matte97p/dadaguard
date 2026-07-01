// Eventi recenti di una risorsa, on-demand (read-only): il "perché è degradato" testuale, accanto
// ai log. ECS service events, RDS events (24h), ASG scaling activities. Read-only/zero storage.
// Permessi: ecs:DescribeServices (già), rds:DescribeEvents, autoscaling:DescribeScalingActivities.
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs'
import { RDSClient, DescribeEventsCommand } from '@aws-sdk/client-rds'
import { AutoScalingClient, DescribeScalingActivitiesCommand } from '@aws-sdk/client-auto-scaling'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'

export async function recentEvents(service, accounts, { limit = 30 } = {}) {
  const cfg = service.aws ?? {}
  const acct = service.account ? accounts[service.account] : null
  const aws = {
    profile: acct?.profile,
    roleArn: acct?.roleArn,
    externalId: acct?.externalId,
    region: cfg.region ?? acct?.region,
  }
  try {
    if (cfg.type === 'ecs') {
      const s = (await new ECSClient(clientOpts(aws)).send(new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }))).services?.[0]
      return { events: (s?.events ?? []).slice(0, limit).map((e) => ({ ts: e.createdAt, message: e.message })) }
    }
    if (cfg.type === 'rds') {
      const out = await new RDSClient(clientOpts(aws)).send(
        new DescribeEventsCommand({
          SourceIdentifier: cfg.cluster ?? cfg.instance,
          SourceType: cfg.cluster ? 'db-cluster' : 'db-instance',
          Duration: 1440, // ultime 24h (in minuti)
        }),
      )
      return { events: (out.Events ?? []).slice(-limit).reverse().map((e) => ({ ts: e.Date, message: e.Message })) }
    }
    if (cfg.type === 'asg') {
      const out = await new AutoScalingClient(clientOpts(aws)).send(
        new DescribeScalingActivitiesCommand({ AutoScalingGroupName: cfg.asg, MaxRecords: limit }),
      )
      return { events: (out.Activities ?? []).map((a) => ({ ts: a.StartTime, message: `${a.StatusCode}: ${a.Description}` })) }
    }
  } catch (err) {
    return { error: cleanAwsReason(err) }
  }
  return { notApplicable: true }
}
