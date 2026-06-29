import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per ECS: desired vs running task count di un servizio.
// Permesso richiesto: ecs:DescribeServices.
export async function ecsRuntime(cfg, aws) {
  const client = new ECSClient(clientOpts(aws))
  const out = await client.send(
    new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }),
  )

  const svc = out.services?.[0]
  if (!svc) return { status: 'unknown', reason: 'servizio ECS non trovato' }

  const desiredCount = svc.desiredCount ?? 0
  const runningCount = svc.runningCount ?? 0
  const pendingCount = svc.pendingCount ?? 0

  let status
  if (desiredCount === 0) status = 'unknown' // scalato a zero di proposito?
  else if (runningCount >= desiredCount) status = 'up'
  else if (runningCount === 0) status = 'down'
  else status = 'degraded'

  const summary =
    `${runningCount}/${desiredCount} task` + (pendingCount > 0 ? ` · ${pendingCount} pending` : '')

  return { status, summary, desiredCount, runningCount, pendingCount }
}
