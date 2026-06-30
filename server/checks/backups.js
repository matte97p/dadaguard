// Segnale: recency dell'ultimo snapshot RDS. up se recente, degraded se più vecchio della soglia
// (backupMaxAgeDays, default 2 → i backup automatici sono giornalieri), down se nessuno snapshot.
// Si applica ai servizi `type: rds`. Permessi: rds:DescribeDBClusterSnapshots, rds:DescribeDBSnapshots.
import {
  RDSClient,
  DescribeDBClusterSnapshotsCommand,
  DescribeDBSnapshotsCommand,
} from '@aws-sdk/client-rds'
import { clientOpts } from '../runtime/awsClient.js'

export const key = 'backups'

export async function run(service, ctx) {
  const cfg = service.aws
  if (cfg?.type !== 'rds') return null // backup-recency ha senso per i DB
  const t = ctx?.t ?? ((k) => k)
  const aws = {
    profile: ctx?.profile,
    roleArn: ctx?.roleArn,
    externalId: ctx?.externalId,
    region: cfg.region ?? ctx?.region,
  }
  try {
    const rds = new RDSClient(clientOpts(aws))
    let snaps = []
    if (cfg.cluster) {
      snaps = (await rds.send(new DescribeDBClusterSnapshotsCommand({ DBClusterIdentifier: cfg.cluster }))).DBClusterSnapshots ?? []
    } else if (cfg.instance) {
      snaps = (await rds.send(new DescribeDBSnapshotsCommand({ DBInstanceIdentifier: cfg.instance }))).DBSnapshots ?? []
    } else {
      return null
    }

    const times = snaps.map((s) => s.SnapshotCreateTime).filter(Boolean).map((d) => new Date(d).getTime())
    if (!times.length) return { key, status: 'down', summary: t('backups.none') }

    const days = Math.floor((Date.now() - Math.max(...times)) / 86400000)
    const maxAge = cfg.backupMaxAgeDays ?? 2
    return { key, status: days > maxAge ? 'degraded' : 'up', summary: t('backups.last', { days }) }
  } catch (err) {
    return { key, status: 'unknown', reason: err.message }
  }
}
