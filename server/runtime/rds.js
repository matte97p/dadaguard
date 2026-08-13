import {
  RDSClient,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds'
import { clientOpts } from './awsClient.js'
import { awsState } from '../i18n.js'
import { truncateList } from '../util/format.js'

// RuntimeProvider per RDS/Aurora: status del cluster + istanze available.
// Permessi: rds:DescribeDBClusters, rds:DescribeDBInstances.
// Config: aws: { type: rds, cluster: <id> }  oppure  { type: rds, instance: <id> }
const MAX_NOMI = 2 // quante istanze si nominano prima di «+N»
const statusFor = (s) => (s === 'available' ? 'up' : s === 'failed' || s === 'stopped' ? 'down' : 'degraded')

export async function rdsRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  // Stato AWS → etichetta leggibile: prima le parole specifiche di RDS (`rds.status.*`), poi la mappa
  // comune a tutti i provider. Senza il secondo passaggio, `rebooting` — che è proprio lo stato in cui
  // si trova un'istanza durante un failover, il caso per cui questo testo esiste — restava in inglese.
  const stLabel = (s) => {
    const k = `rds.status.${s}`
    const v = t(k)
    return v === k ? awsState(s, t) : v
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
    let writer = null // l'istanza di SCRITTURA, se è lei quella fuori
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
      // scritture sono a rischio; un reader fuori = ridondanza in meno. Due guasti diversi, e quindi
      // due LISTE diverse: mescolarli fa dire «fuori il nodo di SCRITTURA reader-1, reader-2», che
      // afferma una cosa falsa su ogni nome dopo il primo.
      const writerId = (c.DBClusterMembers ?? []).find((mb) => mb.IsClusterWriter)?.DBInstanceIdentifier ?? null
      writer = writerId ? (fuori.find((i) => i.DBInstanceIdentifier === writerId) ?? null) : null
    } catch {
      /* tieni il conteggio dai membri del cluster */
    }

    const status = c.Status !== 'available' ? statusFor(c.Status) : available < total ? 'degraded' : 'up'
    // Un cluster «disponibile» con 1/2 istanze è ATTENZIONE, e il testo diceva solo «disponibile»: la
    // contraddizione stava tutta lì. Il chi-e-cosa-comporta va in `alert` (la frase per la chat), non
    // nel summary, che è la riga della card — accanto ha già le metriche col conteggio.
    const nome = (i) => `${i.DBInstanceIdentifier} (${stLabel(i.DBInstanceStatus)})`
    const altri = fuori.filter((i) => i !== writer)
    // Il pezzo sul WRITER va per ULTIMO, non per primo: se il messaggio è troppo lungo il taglio tiene
    // la coda (vedi `cleanDetail`), e fra «le scritture sono a rischio» e «meno capacità di lettura» la
    // frase da salvare è la prima.
    const pezzi = [
      altri.length ? t('rds.readerdown', { list: truncateList(altri.map(nome), MAX_NOMI, t) }) : null,
      writer ? t('rds.writerdown', { list: nome(writer) }) : null,
    ].filter(Boolean)
    return {
      status,
      summary: t('rds.cluster', { engine: c.Engine, status: stLabel(c.Status), available, total }),
      ...(pezzi.length
        ? { alert: t('rds.cluster', { engine: c.Engine, status: stLabel(c.Status), available, total }) + pezzi.join('') }
        : {}),
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
