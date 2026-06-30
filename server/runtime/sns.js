import { SNSClient, GetTopicAttributesCommand } from '@aws-sdk/client-sns'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per SNS: il topic esiste + numero di sottoscrizioni confermate. Segnale "debole"
// (un topic non va "giù"): conferma esistenza/configurazione. Permesso: sns:GetTopicAttributes.
// Config: aws: { type: sns, arn: <topic-arn> }
export async function snsRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const a = (await new SNSClient(clientOpts(aws)).send(new GetTopicAttributesCommand({ TopicArn: cfg.arn }))).Attributes
  if (!a) return { status: 'unknown', reason: t('sns.notfound') }
  return { status: 'up', summary: t('sns.summary', { n: Number(a.SubscriptionsConfirmed ?? 0) }) }
}
