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
  // Spacchetta gli errori: client (4xx, richieste sbagliate/quota) vs server (5xx, colpa di Bedrock)
  // = cause diverse. Se puliti, mostra "0 errori".
  const parts = [t('bedrock.invocations', { n: fmtCount(Math.round(m.inv)) })]
  if (cerr > 0) parts.push(t('bedrock.clienterr', { n: cerr }))
  if (serr > 0) parts.push(t('bedrock.servererr', { n: serr }))
  if (cerr === 0 && serr === 0) parts.push(t('bedrock.errors', { n: 0 }))
  if (throttles > 0) parts.push(t('bedrock.throttled', { n: throttles }))
  if (m.lat > 0) parts.push(t('bedrock.latency', { d: fmtMs(Math.round(m.lat)) }))
  if (m.tin > 0 || m.tout > 0) parts.push(t('bedrock.tokens', { in: fmtCount(Math.round(m.tin)), out: fmtCount(Math.round(m.tout)) }))
  return { status, summary: `${parts.join(' · ')} (${winL})`, clientErrors: cerr, serverErrors: serr, throttles }
}
