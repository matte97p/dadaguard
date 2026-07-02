import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per SQS: profondità della coda (messaggi in attesa + in volo). Una coda non va
// "giù": il segnale è il BACKLOG. Con `maxDepth` opzionale → degraded se la supera (coda intasata).
// Permessi: sqs:GetQueueUrl, sqs:GetQueueAttributes.
// Config: aws: { type: sqs, queue: <nome o URL>, maxDepth?: <n> }
export async function sqsRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const client = new SQSClient(clientOpts(aws))

  let url = cfg.queue
  if (!/^https?:\/\//.test(String(url))) {
    try {
      url = (await client.send(new GetQueueUrlCommand({ QueueName: cfg.queue }))).QueueUrl
    } catch (err) {
      // solo "coda inesistente" è notfound; throttle/denied/... risalgono e li ripulisce cleanAwsReason a monte.
      if (err.name === 'QueueDoesNotExist' || /NonExistentQueue/i.test(err.name || '')) return { status: 'unknown', reason: t('sqs.notfound') }
      throw err
    }
  }

  const a =
    (
      await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      )
    ).Attributes ?? {}
  const depth = Number(a.ApproximateNumberOfMessages ?? 0)
  const inflight = Number(a.ApproximateNumberOfMessagesNotVisible ?? 0)
  const status = cfg.maxDepth && depth > cfg.maxDepth ? 'degraded' : 'up'
  return { status, summary: t('sqs.summary', { n: depth, inflight }), depth, inflight }
}
