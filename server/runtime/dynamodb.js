import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { clientOpts } from './awsClient.js'
import { fmtCount } from '../util/format.js'

// RuntimeProvider per DynamoDB: stato della tabella. ACTIVE = up; CREATING/UPDATING = degraded;
// DELETING/inaccessibile = down. Permesso: dynamodb:DescribeTable.
// Config: aws: { type: dynamodb, table: <nome> }
export async function dynamodbRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const o = await new DynamoDBClient(clientOpts(aws)).send(new DescribeTableCommand({ TableName: cfg.table }))
  const tbl = o.Table
  if (!tbl) return { status: 'unknown', reason: t('dynamodb.notfound') }

  const st = tbl.TableStatus
  const status = st === 'ACTIVE' ? 'up' : st === 'DELETING' ? 'down' : 'degraded'
  return { status, summary: t('dynamodb.summary', { status: st, items: fmtCount(tbl.ItemCount ?? 0) }) }
}
