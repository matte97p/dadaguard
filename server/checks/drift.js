// Segnale #6 — drift (leggero): gli attributi chiave dichiarati in Terraform
// combaciano con la realtà AWS? Confronta lo state (da S3, in ctx.tf.attrs) con le
// describe AWS, SENZA `terraform plan` (troppo lento + lock sul backend per il
// fetch-on-load). Copertura oggi: Lambda (runtime/memory/timeout/handler).
// Il plan completo resta un'azione on-demand separata.
import { getLambdaConfig } from '../runtime/lambdaConfig.js'
import { isThrottle } from '../runtime/awsClient.js'

export const key = 'drift'

export async function run(service, ctx) {
  const cfg = service.aws
  const t = ctx?.t ?? ((k) => k)
  if (cfg?.type !== 'lambda') return null // copertura iniziale: solo Lambda
  if (!ctx?.tf) return null // account senza stateBucket → drift non applicabile
  if (ctx.tf.error) return { key, status: 'unknown', reason: t('drift.stateunreadable') }
  const desired = ctx.tf.attrs?.lambda?.[cfg.function]
  if (!desired) return null // lambda non gestita da TF (lo segnala #7)

  const aws = {
    profile: ctx.profile,
    roleArn: ctx.roleArn,
    externalId: ctx.externalId,
    region: cfg.region ?? ctx.region,
  }
  try {
    const conf = await getLambdaConfig(cfg.function, aws)

    // Formato: "reale (atteso da Terraform)" — così è chiaro quale lato è quale.
    const diffs = []
    if (desired.runtime != null && desired.runtime !== conf.Runtime)
      diffs.push(t('drift.runtime', { actual: conf.Runtime, expected: desired.runtime }))
    if (desired.memory_size != null && desired.memory_size !== conf.MemorySize)
      diffs.push(t('drift.memory', { actual: conf.MemorySize, expected: desired.memory_size }))
    if (desired.timeout != null && desired.timeout !== conf.Timeout)
      diffs.push(t('drift.timeout', { actual: conf.Timeout, expected: desired.timeout }))
    if (desired.handler != null && desired.handler !== conf.Handler) diffs.push(t('drift.handler'))

    if (!diffs.length) return { key, status: 'up', summary: t('drift.insync') }
    return { key, status: 'degraded', summary: t('drift.diverge', { diffs: diffs.join(', ') }) }
  } catch (err) {
    return { key, status: 'unknown', reason: isThrottle(err) ? t('drift.throttled') : err.message }
  }
}
