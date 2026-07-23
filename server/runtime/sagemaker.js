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
  const e4 = Math.round(m.e4)
  const e5 = Math.round(m.e5)
  const status = e4 + e5 > 0 ? 'degraded' : 'up'
  const parts = [t('sagemaker.invocations', { n: fmtCount(Math.round(m.inv)) }), t('sagemaker.errors', { n: e4 + e5 })]
  if (m.lat > 0) parts.push(t('sagemaker.latency', { d: fmtMs(Math.round(m.lat / 1000)) }))
  const metrics = [{ label: t('m.inv'), value: fmtCount(Math.round(m.inv)) }]
  if (e5 > 0) metrics.push({ label: t('m.errServer'), value: String(e5), tone: 'critical' })
  if (e4 > 0) metrics.push({ label: t('m.errClient'), value: String(e4), tone: 'warning' })
  if (e4 === 0 && e5 === 0) metrics.push({ label: t('m.errors'), value: '0', tone: 'good' })
  if (m.lat > 0) metrics.push({ label: t('m.latency'), value: `~${fmtMs(Math.round(m.lat / 1000))}` })
  return { status, summary: `${parts.join(' · ')} (${winL})`, metrics, window: winL, spark: m.series?.inv }
}
