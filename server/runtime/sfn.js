import { SFNClient, DescribeStateMachineCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per Step Functions: state machine attiva + esecuzioni FALLITE nelle ultime 24h.
// Permessi: states:DescribeStateMachine, states:ListExecutions. Config: { type: sfn, arn: <stateMachineArn> }
export async function sfnRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const sfn = new SFNClient(clientOpts(aws))
  const sm = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: cfg.arn }))
  if (!sm) return { status: 'unknown', reason: t('sfn.notfound') }
  if (sm.status && sm.status !== 'ACTIVE') return { status: 'degraded', summary: t('sfn.status', { status: sm.status }) }

  const failed = (await sfn.send(new ListExecutionsCommand({ stateMachineArn: cfg.arn, statusFilter: 'FAILED', maxResults: 10 }))).executions ?? []
  const recent = failed.filter((e) => e.startDate && Date.now() - new Date(e.startDate).getTime() < 86400000)
  if (recent.length) return { status: 'degraded', summary: t('sfn.failed', { n: recent.length }) }
  return { status: 'up', summary: t('sfn.ok') }
}
