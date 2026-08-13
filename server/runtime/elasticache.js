import {
  ElastiCacheClient,
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
} from '@aws-sdk/client-elasticache'
import { clientOpts } from './awsClient.js'
import { awsState } from '../i18n.js'

// RuntimeProvider per ElastiCache (Redis/Memcached): stato del cluster. available = up;
// deleting/restore-failed/incompatible-network = down; il resto (creating/modifying) = degraded.
// Permessi: elasticache:DescribeCacheClusters, elasticache:DescribeReplicationGroups.
// Config: aws: { type: elasticache, cluster: <cache-cluster-id> }
//     oppure aws: { type: elasticache, replicationGroup: <replication-group-id> }
//
// Il replication group è la forma da preferire quando c'è: un Redis con due nodi risponde a
// DescribeCacheClusters con `<gruppo>-001` e `<gruppo>-002`, e nessuno dei due È il Redis. Fissare il
// nodo primario nella config non aiuta: al primo failover quel nome indica una replica, e il check
// continuerebbe a dire «available» guardando la cosa sbagliata.
const DOWN = ['deleting', 'deleted', 'incompatible-network', 'restore-failed']

// Stato ElastiCache → stato della card. Puro/testabile: la stessa scala vale per un cluster singolo
// e per un replication group, che riusano lo stesso vocabolario di stati.
export function elasticacheStatus(raw) {
  if (raw === 'available') return 'up'
  return DOWN.includes(raw) ? 'down' : 'degraded'
}

export async function elasticacheRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const client = new ElastiCacheClient(clientOpts(aws))

  if (cfg.replicationGroup) {
    const o = await client.send(
      new DescribeReplicationGroupsCommand({ ReplicationGroupId: cfg.replicationGroup }),
    )
    const g = o.ReplicationGroups?.[0]
    if (!g) return { status: 'unknown', reason: t('elasticache.notfound') }
    return {
      status: elasticacheStatus(g.Status),
      summary: t('elasticache.summary', {
        engine: g.Engine ?? 'redis',
        status: awsState(g.Status, t),
        nodes: (g.MemberClusters ?? []).length,
      }),
    }
  }

  const o = await client.send(
    new DescribeCacheClustersCommand({ CacheClusterId: cfg.cluster, ShowCacheNodeInfo: false }),
  )
  const c = o.CacheClusters?.[0]
  if (!c) return { status: 'unknown', reason: t('elasticache.notfound') }
  return {
    status: elasticacheStatus(c.CacheClusterStatus),
    summary: t('elasticache.summary', {
      engine: c.Engine,
      status: awsState(c.CacheClusterStatus, t),
      nodes: c.NumCacheNodes ?? 0,
    }),
  }
}
