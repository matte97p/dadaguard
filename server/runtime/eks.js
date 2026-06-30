import { EKSClient, DescribeClusterCommand } from '@aws-sdk/client-eks'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per EKS: stato del cluster + versione. ACTIVE = up; DELETING/FAILED = down; resto degraded.
// Permesso: eks:DescribeCluster. Config: aws: { type: eks, cluster: <nome> }
export async function eksRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const c = (await new EKSClient(clientOpts(aws)).send(new DescribeClusterCommand({ name: cfg.cluster }))).cluster
  if (!c) return { status: 'unknown', reason: t('eks.notfound') }
  const status = c.status === 'ACTIVE' ? 'up' : ['DELETING', 'FAILED'].includes(c.status) ? 'down' : 'degraded'
  return { status, summary: t('eks.summary', { version: c.version ?? '?', status: c.status }) }
}
