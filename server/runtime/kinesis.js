import { KinesisClient, DescribeStreamSummaryCommand } from '@aws-sdk/client-kinesis'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per Kinesis Data Streams: stato dello stream + numero di shard. ACTIVE = up.
// Permesso: kinesis:DescribeStreamSummary. Config: aws: { type: kinesis, stream: <nome> }
export async function kinesisRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const s = (await new KinesisClient(clientOpts(aws)).send(new DescribeStreamSummaryCommand({ StreamName: cfg.stream }))).StreamDescriptionSummary
  if (!s) return { status: 'unknown', reason: t('kinesis.notfound') }
  const status = s.StreamStatus === 'ACTIVE' ? 'up' : s.StreamStatus === 'DELETING' ? 'down' : 'degraded'
  return { status, summary: t('kinesis.summary', { status: s.StreamStatus, shards: s.OpenShardCount ?? 0 }) }
}
