import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per ECS: desired vs running task count di un servizio.
// Permesso richiesto: ecs:DescribeServices.
export async function ecsRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const client = new ECSClient(clientOpts(aws))
  const out = await client.send(
    new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }),
  )

  const svc = out.services?.[0]
  if (!svc) return { status: 'unknown', reason: t('ecs.notfound') }

  const desiredCount = svc.desiredCount ?? 0
  const runningCount = svc.runningCount ?? 0
  const pendingCount = svc.pendingCount ?? 0

  let status
  if (desiredCount === 0) status = 'idle' // scalato a zero di proposito: a riposo, non un errore
  else if (runningCount >= desiredCount) status = 'up'
  else if (runningCount === 0) status = 'down'
  else status = 'degraded'

  const summary =
    t('ecs.tasks', { running: runningCount, desired: desiredCount }) +
    (pendingCount > 0 ? t('ecs.pending', { n: pendingCount }) : '')

  return { status, summary, desiredCount, runningCount, pendingCount }
}
