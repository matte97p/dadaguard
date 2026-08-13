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
    let fuori = [] // le istanze NON available, col loro stato: il conteggio non dice QUALE è fuori
    let writerFuori = false
    try {
      const inst = await client.send(
        new DescribeDBInstancesCommand({
          Filters: [{ Name: 'db-cluster-id', Values: [cfg.cluster] }],
        }),
      )
      const insts = inst.DBInstances ?? []
      total = insts.length
      available = insts.filter((i) => i.DBInstanceStatus === 'available').length
      fuori = insts.filter((i) => i.DBInstanceStatus !== 'available')
      // Chi è il writer lo dice il cluster (IsClusterWriter), non l'istanza: writer fuori = le
      // scritture sono a rischio; un reader fuori = ridondanza in meno. Due guasti diversi.
      const writerId = (c.DBClusterMembers ?? []).find((mb) => mb.IsClusterWriter)?.DBInstanceIdentifier ?? null
      writerFuori = Boolean(writerId) && fuori.some((i) => i.DBInstanceIdentifier === writerId)
    } catch {
      /* tieni il conteggio dai membri del cluster */
    }

    const status = c.Status !== 'available' ? statusFor(c.Status) : available < total ? 'degraded' : 'up'
    // Un cluster «disponibile» con 1/2 istanze è ATTENZIONE, e finora il testo diceva solo
    // «disponibile»: la contraddizione stava tutta lì. Qui si aggiunge chi è fuori e cosa comporta.
    const dettaglio = fuori.length
      ? t(writerFuori ? 'rds.writerdown' : 'rds.readerdown', {
          list: fuori.map((i) => `${i.DBInstanceIdentifier} (${stLabel(i.DBInstanceStatus)})`).join(', '),
        })
      : ''
    return {
      status,
      summary: t('rds.cluster', { engine: c.Engine, status: stLabel(c.Status), available, total }) + dettaglio,
      metrics: [
        { label: t('m.engine'), value: c.Engine },
        { label: t('m.state'), value: stLabel(c.Status), tone: c.Status === 'available' ? 'good' : 'critical' },
        { label: t('m.instances', { n: total }), value: `${available}/${total}`, tone: available < total ? 'warning' : 'good' },
      ],
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
