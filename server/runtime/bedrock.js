import { metricValues } from './cw.js'
import { identityT } from '../i18n.js'
import { fmtMs, fmtCount } from '../util/format.js'

// RuntimeProvider Amazon Bedrock. Serverless: guardiamo le metriche d'uso su una finestra (CloudWatch
// AWS/Bedrock, via il batcher condiviso): invocazioni, errori client/server, throttling, latenza.
//  - `aws: { type: bedrock, model: '<modelId>' }` (consigliato) → metriche del singolo modello.
//  - senza `model` → nessuna dimension (aggregato, se l'account pubblica metriche a quel livello).
const DEFAULT_WINDOW_MIN = 60

export async function bedrockRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? identityT
  const windowMin = cfg.windowMinutes ?? DEFAULT_WINDOW_MIN
  const dims = cfg.model ? [{ Name: 'ModelId', Value: cfg.model }] : []
  const m = await metricValues(
    aws,
    'AWS/Bedrock',
    dims,
    [
      ['inv', 'Invocations', 'Sum'],
      ['cerr', 'InvocationClientErrors', 'Sum'],
      ['serr', 'InvocationServerErrors', 'Sum'],
      ['thr', 'InvocationThrottles', 'Sum'],
      ['lat', 'InvocationLatency', 'Average'],
      ['tin', 'InputTokenCount', 'Sum'],
      ['tout', 'OutputTokenCount', 'Sum'],
    ],
    windowMin,
  )
  const winL = `${windowMin}m`
  if (!m.inv && !m.cerr && !m.serr && !m.thr) return { status: 'idle', summary: t('bedrock.idle', { window: winL }) }
  const cerr = Math.round(m.cerr)
  const serr = Math.round(m.serr)
  const throttles = Math.round(m.thr)
  const status = throttles > 0 || serr > 0 || cerr > 0 ? 'degraded' : 'up'
  // Stat tile strutturati (label + valore + tono di stato). Errori: client (4xx, richieste/quota) e
  // server (5xx, colpa di Bedrock) = cause diverse → tile distinti; puliti → "0" verde.
  const metrics = [{ label: t('m.inv'), value: fmtCount(Math.round(m.inv)) }]
  if (serr > 0) metrics.push({ label: t('m.errServer'), value: String(serr), tone: 'critical' })
  if (cerr > 0) metrics.push({ label: t('m.errClient'), value: String(cerr), tone: 'warning' })
  if (serr === 0 && cerr === 0) metrics.push({ label: t('m.errors'), value: '0', tone: 'good' })
  if (throttles > 0) metrics.push({ label: t('m.throttle'), value: String(throttles), tone: 'warning' })
  if (m.lat > 0) metrics.push({ label: t('m.latency'), value: `~${fmtMs(Math.round(m.lat))}` })
  if (m.tin > 0 || m.tout > 0) metrics.push({ label: t('m.tokens'), value: `${fmtCount(Math.round(m.tin))} → ${fmtCount(Math.round(m.tout))}` })
  const summary = `${metrics.map((x) => `${x.value} ${x.label}`).join(' · ')} (${winL})`
  return { status, summary, metrics, window: winL, spark: m.series?.inv, clientErrors: cerr, serverErrors: serr, throttles }
}
