// Segnale #1 — liveness: l'endpoint risponde? con che latenza?
// Ogni check espone { key, run(service) -> result }. result.status ∈
// up | degraded | down | unknown.

const TIMEOUT_MS = 5000

export const key = 'liveness'

export async function run(service, ctx) {
  if (!service.healthUrl) {
    return null // segnale non applicabile (es. Lambda/worker senza endpoint HTTP)
  }
  const t = ctx?.t ?? ((k) => k)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const startedAt = performance.now()

  try {
    const res = await fetch(service.healthUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    })
    const latencyMs = Math.round(performance.now() - startedAt)
    const httpStatus = res.status

    let status = 'up'
    if (httpStatus >= 500) status = 'down'
    else if (httpStatus >= 400) status = 'degraded'

    return { key, status, httpStatus, latencyMs }
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startedAt)
    return {
      key,
      status: 'down',
      latencyMs,
      reason: err.name === 'AbortError' ? t('liveness.timeout', { ms: TIMEOUT_MS }) : err.message,
    }
  } finally {
    clearTimeout(timer)
  }
}
