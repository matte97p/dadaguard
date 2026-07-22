// Guardiano ANTI-ESPOSIZIONE (self-check automatico, in-app).
//
// Dadaguard non ha login proprio: il login è Cloudflare Access DAVANTI (vedi deploy/). Se qualcuno
// rimuove Access, lo apre a "everyone" o rompe il tunnel/route, la dashboard — che mostra infra e
// costi AWS reali — resta esposta a chiunque abbia l'URL, e nessuno se ne accorge. Qui Dadaguard
// verifica la PROPRIA porta d'ingresso in continuo: una GET NON autenticata al suo hostname pubblico
// DEVE rimbalzare (redirect) verso il login di Cloudflare Access. Un 200 secco = ESPOSTA.
//
// Read-only e senza credenziali: è una richiesta anonima verso sé stessi, come la farebbe un estraneo.

const ACCESS_MARKERS = ['cloudflareaccess.com', '/cdn-cgi/access']
const REDIRECTS = new Set([301, 302, 303, 307, 308])

// ZERO-CONFIG: ricava l'URL pubblico dall'header della richiesta (che passa da Cloudflare) → non
// serve nessuna var impostata a mano. `override` (config.publicUrl / env) vince se presente.
export function publicUrlFromHeaders(headers = {}, override = null) {
  if (override) return override
  const host = headers['x-forwarded-host'] || headers.host
  if (!host) return null
  const firstHost = String(host).split(',')[0].trim()
  if (!firstHost) return null
  const proto = String(headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https'
  return `${proto}://${firstHost}`
}

// Puro/testabile: classifica l'esito della sonda.
export function classifyExposure({ status, location, error } = {}, t = (k) => k) {
  if (error) return { key: 'exposure', status: 'unknown', summary: t('exposure.unknown') }
  const loc = String(location ?? '').toLowerCase()
  if (REDIRECTS.has(status) && ACCESS_MARKERS.some((m) => loc.includes(m))) {
    return { key: 'exposure', status: 'up', summary: t('exposure.protected') }
  }
  if (status === 200) return { key: 'exposure', status: 'down', summary: t('exposure.exposed') }
  // Redirect verso altro, 401/403 non-Access, 5xx… → non confermabile (né "protetto" né "esposto").
  return { key: 'exposure', status: 'unknown', summary: t('exposure.unknown') }
}

// Sonda la porta pubblica. Ritorna null se non c'è un URL pubblico configurato (segnale non
// applicabile: in locale/demo Dadaguard non è pubblicato). Mai lancia: gli errori → 'unknown'.
export async function probeExposure(publicUrl, t = (k) => k, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  if (!publicUrl) return null
  let url
  try {
    url = new URL(publicUrl)
  } catch {
    return classifyExposure({ error: 'bad-url' }, t)
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual', // vogliamo VEDERE il 302, non seguirlo
      signal: ctrl.signal,
      headers: { 'user-agent': 'dadaguard-selfcheck' },
    })
    return classifyExposure({ status: res.status, location: res.headers.get('location') }, t)
  } catch (err) {
    return classifyExposure({ error: err.message }, t)
  } finally {
    clearTimeout(timer)
  }
}
