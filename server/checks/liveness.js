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
    // Messaggi distinti per causa invece dell'err.message grezzo del fetch: timeout / DNS / connessione
    // rifiutata / TLS / irraggiungibile. La causa vera del fetch undici sta in err.cause.code.
    const code = err.cause?.code || err.code || ''
    let reason
    if (err.name === 'AbortError') reason = t('liveness.timeout', { ms: TIMEOUT_MS })
    else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') reason = t('liveness.dns')
    else if (code === 'ECONNREFUSED' || code === 'ECONNRESET') reason = t('liveness.refused')
    else if (/CERT|TLS|SSL|SELF_SIGNED/i.test(code) || /certificate/i.test(err.message || '')) reason = t('liveness.tls')
    else reason = t('liveness.unreachable')
    return { key, status: 'down', latencyMs, reason }
  } finally {
    clearTimeout(timer)
  }
}
