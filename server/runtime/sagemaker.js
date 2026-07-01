import { metricValues } from './cw.js'
import { identityT } from '../i18n.js'
import { fmtMs, fmtCount } from '../util/format.js'

// RuntimeProvider SageMaker (endpoint di inferenza). Serverless-ish: guardiamo le metriche d'uso
// CloudWatch AWS/SageMaker per EndpointName (invocazioni, errori 4xx/5xx, latenza del modello).
// `aws: { type: sagemaker, endpoint: '<EndpointName>' }`. Permesso: cloudwatch:GetMetricData.
const DEFAULT_WINDOW_MIN = 60

export async function sagemakerRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? identityT
  const win = cfg.windowMinutes ?? DEFAULT_WINDOW_MIN
  const dims = cfg.endpoint ? [{ Name: 'EndpointName', Value: cfg.endpoint }] : []
  const m = await metricValues(
    aws,
    'AWS/SageMaker',
    dims,
    [
      ['inv', 'Invocations', 'Sum'],
      ['e4', 'Invocation4XXErrors', 'Sum'],
      ['e5', 'Invocation5XXErrors', 'Sum'],
      ['lat', 'ModelLatency', 'Average'], // microsecondi
    ],
    win,
  )
  const winL = `${win}m`
  if (!m.inv && !m.e4 && !m.e5) return { status: 'idle', summary: t('sagemaker.idle', { window: winL }) }
  const errors = Math.round(m.e4 + m.e5)
  const status = errors > 0 ? 'degraded' : 'up'
  const parts = [t('sagemaker.invocations', { n: fmtCount(Math.round(m.inv)) }), t('sagemaker.errors', { n: errors })]
  if (m.lat > 0) parts.push(t('sagemaker.latency', { d: fmtMs(Math.round(m.lat / 1000)) }))
  return { status, summary: `${parts.join(' · ')} (${winL})` }
}
