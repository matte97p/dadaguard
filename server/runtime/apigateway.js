import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from './awsClient.js'
import { fmtCount } from '../util/format.js'

// RuntimeProvider per API Gateway: errori 5xx recenti (15 min) via CloudWatch. up se 0, degraded se >0.
// Permesso: cloudwatch:GetMetricData. Config: aws: { type: apigateway, apiName: <nome>, stage?: <stage> }
export async function apigatewayRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  if (!cfg.apiName) return { status: 'unknown', reason: t('apigw.noname') }
  const cw = new CloudWatchClient(clientOpts(aws))
  const end = new Date()
  const start = new Date(end.getTime() - 15 * 60 * 1000)
  const dims = [{ Name: 'ApiName', Value: cfg.apiName }, ...(cfg.stage ? [{ Name: 'Stage', Value: cfg.stage }] : [])]
  const q = (id, name) => ({
    Id: id,
    MetricStat: { Metric: { Namespace: 'AWS/ApiGateway', MetricName: name, Dimensions: dims }, Period: 900, Stat: 'Sum' },
    ReturnData: true,
  })
  const res = await cw.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: [q('c', 'Count'), q('e', '5XXError')] }))
  const sum = (id) => (res.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []).reduce((a, b) => a + b, 0)
  const count = sum('c')
  const e5 = sum('e')
  // La finestra è 15 minuti e non lo diceva nessuno: "3.400 richieste" senza periodo non è un numero.
  // Sta nel testo e non in un campo `window`: quello lo rende solo la card, e questo provider non
  // espone metriche, quindi lì non arriverebbe mai — due fonti per lo stesso dato, una muta.
  const window = '15m'
  return {
    status: e5 > 0 ? 'degraded' : 'up',
    summary: t('apigw.summary', { n: fmtCount(Math.round(count)), e: e5, window }),
    ...(e5 > 0
      ? {
          alert:
            t('apigw.alert', { e: e5, n: fmtCount(Math.round(count)), window }) +
            t('rule.fires', { regola: t('apigw.regola') }),
        }
      : {}),
  }
}
