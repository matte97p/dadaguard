// Segnale #1 — liveness: l'endpoint risponde? con che latenza?
// Ogni check espone { key, run(service) -> result }. result.status ∈
// up | degraded | down | unknown.

const TIMEOUT_MS = 5000

export const key = 'liveness'

// Porte d'ingresso di autenticazione: se la sonda finisce QUI, ha visto la porta, non l'applicazione.
const AUTH_HOSTS = [
  /\.cloudflareaccess\.com$/i,
  /\.okta\.com$/i,
  /\.auth0\.com$/i,
  /^accounts\.google\.com$/i,
  /^login\.microsoftonline\.com$/i,
]

const hostOf = (u) => {
  try {
    return new URL(u).host
  } catch {
    return null
  }
}

// Classifica la risposta della sonda. PURA, quindi testabile senza rete — ed è dove stava il bug:
// seguendo i redirect, un servizio dietro Cloudflare Access rispondeva `200` perché la sonda leggeva
// la PAGINA DI LOGIN («risponde · HTTP 200» su un'app che poteva essere spenta). Verificato sul vero:
//   GET https://dadaguard.example.com/  →  302  →  example.cloudflareaccess.com/cdn-cgi/access/login/…  →  200
// Una sonda anonima da fuori NON PUÒ dire se un'app protetta è sana: dirlo è peggio che non saperlo.
export function classifyProbe({ httpStatus, location = null, target = null }, t = (k) => k) {
  if (httpStatus >= 500) return { status: 'down' }
  if (httpStatus >= 400) return { status: 'degraded' }
  if (httpStatus >= 300) {
    const to = hostOf(location)
    if (to && AUTH_HOSTS.some((re) => re.test(to))) return { status: 'unknown', reason: t('liveness.gated') }
    const from = hostOf(target)
    // Redirect verso un altro host: chi risponde non è (necessariamente) l'app che stiamo sondando.
    if (to && from && to !== from) return { status: 'unknown', reason: t('liveness.elsewhere', { host: to }) }
    return { status: 'up' } // redirect interno: http→https, / → /app, dominio canonico
  }
  return { status: 'up' }
}

export async function run(service, ctx) {
  if (!service.healthUrl) {
    return null // segnale non applicabile (es. Lambda/worker senza endpoint HTTP)
  }
  const t = ctx?.t ?? ((k) => k)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const startedAt = performance.now()

  try {
    // `manual`: i redirect si LEGGONO, non si seguono. Seguirli fa arrivare la sonda alla pagina di
    // login di Access e restituire un 200 che parla della porta, non dell'applicazione.
    const res = await fetch(service.healthUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    })
    const latencyMs = Math.round(performance.now() - startedAt)
    const httpStatus = res.status
    const verdict = classifyProbe(
      { httpStatus, location: res.headers.get('location'), target: service.healthUrl },
      t,
    )
    return { key, httpStatus, latencyMs, ...verdict }
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
