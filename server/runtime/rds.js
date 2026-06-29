import {
  RDSClient,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per RDS/Aurora: status del cluster + istanze available.
// Permessi: rds:DescribeDBClusters, rds:DescribeDBInstances.
// Config: aws: { type: rds, cluster: <id> }  oppure  { type: rds, instance: <id> }
const statusFor = (s) => (s === 'available' ? 'up' : s === 'failed' || s === 'stopped' ? 'down' : 'degraded')

export async function rdsRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  // Stato AWS → etichetta leggibile via i18n; gli stati non mappati restano grezzi.
  const stLabel = (s) => {
    const k = `rds.status.${s}`
    const v = t(k)
    return v === k ? s : v
  }
  const client = new RDSClient(clientOpts(aws))

  if (cfg.cluster) {
    const out = await client.send(
      new DescribeDBClustersCommand({ DBClusterIdentifier: cfg.cluster }),
    )
    const c = out.DBClusters?.[0]
    if (!c) return { status: 'unknown', reason: t('rds.clusternotfound') }

    let available = (c.DBClusterMembers ?? []).length
    let total = available
    try {
      const inst = await client.send(
        new DescribeDBInstancesCommand({
          Filters: [{ Name: 'db-cluster-id', Values: [cfg.cluster] }],
        }),
      )
      const insts = inst.DBInstances ?? []
      total = insts.length
      available = insts.filter((i) => i.DBInstanceStatus === 'available').length
    } catch {
      /* tieni il conteggio dai membri del cluster */
    }

    const status = c.Status !== 'available' ? statusFor(c.Status) : available < total ? 'degraded' : 'up'
    return {
      status,
      summary: t('rds.cluster', { engine: c.Engine, status: stLabel(c.Status), available, total }),
    }
  }

  if (cfg.instance) {
    const out = await client.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: cfg.instance }),
    )
    const i = out.DBInstances?.[0]
    if (!i) return { status: 'unknown', reason: t('rds.instancenotfound') }
    return { status: statusFor(i.DBInstanceStatus), summary: t('rds.instance', { engine: i.Engine, status: stLabel(i.DBInstanceStatus) }) }
  }

  return { status: 'unknown', reason: t('rds.missing') }
}
