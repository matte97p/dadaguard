import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per Auto Scaling Group: desired capacity vs istanze in servizio e healthy.
// Permesso richiesto: autoscaling:DescribeAutoScalingGroups.
export async function asgRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const client = new AutoScalingClient(clientOpts(aws))
  const out = await client.send(
    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [cfg.asg] }),
  )

  const group = out.AutoScalingGroups?.[0]
  if (!group) return { status: 'unknown', reason: t('asg.notfound') }

  const desiredCount = group.DesiredCapacity ?? 0
  const instances = group.Instances ?? []
  const healthy = instances.filter(
    (i) => i.HealthStatus === 'Healthy' && i.LifecycleState === 'InService',
  ).length

  let status
  if (desiredCount === 0) status = 'idle' // capacità desiderata 0: a riposo, non un errore
  else if (healthy >= desiredCount) status = 'up'
  else if (healthy === 0) status = 'down'
  else status = 'degraded'

  return {
    status,
    summary: t('asg.healthy', { healthy, desired: desiredCount }),
    desiredCount,
    runningCount: healthy,
  }
}
