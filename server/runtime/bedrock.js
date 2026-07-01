import { metricValues } from './cw.js'
import { identityT } from '../i18n.js'

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
    ],
    windowMin,
  )
  const winL = `${windowMin}m`
  if (!m.inv && !m.cerr && !m.serr && !m.thr) return { status: 'idle', summary: t('bedrock.idle', { window: winL }) }
  const errors = Math.round(m.cerr + m.serr)
  const throttles = Math.round(m.thr)
  const status = throttles > 0 || m.serr > 0 || errors > 0 ? 'degraded' : 'up'
  const parts = [t('bedrock.invocations', { n: Math.round(m.inv) }), t('bedrock.errors', { n: errors })]
  if (throttles > 0) parts.push(t('bedrock.throttled', { n: throttles }))
  if (m.lat > 0) parts.push(t('bedrock.latency', { ms: Math.round(m.lat) }))
  return { status, summary: `${parts.join(' · ')} (${winL})` }
}
