import { ElastiCacheClient, DescribeCacheClustersCommand } from '@aws-sdk/client-elasticache'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per ElastiCache (Redis/Memcached): stato del cluster. available = up;
// deleting/restore-failed/incompatible-network = down; il resto (creating/modifying) = degraded.
// Permesso: elasticache:DescribeCacheClusters.
// Config: aws: { type: elasticache, cluster: <cache-cluster-id> }
const DOWN = ['deleting', 'deleted', 'incompatible-network', 'restore-failed']

export async function elasticacheRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const o = await new ElastiCacheClient(clientOpts(aws)).send(
    new DescribeCacheClustersCommand({ CacheClusterId: cfg.cluster, ShowCacheNodeInfo: false }),
  )
  const c = o.CacheClusters?.[0]
  if (!c) return { status: 'unknown', reason: t('elasticache.notfound') }

  const st = c.CacheClusterStatus
  const status = st === 'available' ? 'up' : DOWN.includes(st) ? 'down' : 'degraded'
  return { status, summary: t('elasticache.summary', { engine: c.Engine, status: st, nodes: c.NumCacheNodes ?? 0 }) }
}
