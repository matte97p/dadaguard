import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from './awsClient.js'
import { identityT } from '../i18n.js'

// RuntimeProvider per Amazon Bedrock. Bedrock è serverless: non c'è "runtime desiderato" da
// confrontare, quindi guardiamo le METRICHE d'uso su una finestra (CloudWatch, namespace AWS/Bedrock):
// invocazioni, errori client/server, throttling, latenza media. Profilo simile alla Lambda on-demand.
//  - `aws: { type: bedrock, model: '<modelId>' }` → metriche del singolo modello (consigliato).
//  - senza `model` → nessuna dimension (aggregato, se l'account pubblica metriche a quel livello).
// Permessi: cloudwatch:GetMetricData (già concesso). Niente permesso Bedrock necessario per le metriche.
const DEFAULT_WINDOW_MIN = 60

export async function bedrockRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? identityT
  const windowMin = cfg.windowMinutes ?? DEFAULT_WINDOW_MIN
  const cw = new CloudWatchClient(clientOpts(aws))
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - windowMin * 60 * 1000)
  const period = Math.min(windowMin * 60, 86400)
  const dims = cfg.model ? [{ Name: 'ModelId', Value: cfg.model }] : []
  const q = (id, name, stat) => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: 'AWS/Bedrock', MetricName: name, Dimensions: dims },
      Period: period,
      Stat: stat,
    },
    ReturnData: true,
  })

  const res = await cw.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: [
        q('inv', 'Invocations', 'Sum'),
        q('cerr', 'InvocationClientErrors', 'Sum'),
        q('serr', 'InvocationServerErrors', 'Sum'),
        q('thr', 'InvocationThrottles', 'Sum'),
        q('lat', 'InvocationLatency', 'Average'),
      ],
    }),
  )
  const agg = (id, how = 'sum') => {
    const v = res.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []
    if (!v.length) return 0
    if (how === 'avg') return v.reduce((a, b) => a + b, 0) / v.length
    return v.reduce((a, b) => a + b, 0)
  }
  const invocations = agg('inv')
  const clientErrors = agg('cerr')
  const serverErrors = agg('serr')
  const throttles = agg('thr')
  const latencyMs = Math.round(agg('lat', 'avg'))
  const win = `${windowMin}m`

  // Nessuna attività nella finestra → idle (nessuno l'ha invocato, non è un guasto).
  if (invocations === 0 && clientErrors === 0 && serverErrors === 0 && throttles === 0) {
    return { status: 'idle', summary: t('bedrock.idle', { window: win }) }
  }

  const errors = clientErrors + serverErrors
  // Throttling o errori server (5xx, lato Bedrock) = problema; errori client (4xx) segnalati ma meno gravi.
  const status = throttles > 0 || serverErrors > 0 || errors > 0 ? 'degraded' : 'up'
  const parts = [t('bedrock.invocations', { n: invocations }), t('bedrock.errors', { n: errors })]
  if (throttles > 0) parts.push(t('bedrock.throttled', { n: throttles }))
  if (latencyMs > 0) parts.push(t('bedrock.latency', { ms: latencyMs }))
  return { status, summary: `${parts.join(' · ')} (${win})` }
}
