// Verifica del token di Cloudflare Access sulle rotte di /admin.
//
// Access sta davanti a /admin e fa entrare solo chi ha fatto login. Il Worker però non si fida del
// solo fatto di essere stato raggiunto: se l'app di Access venisse tolta o allargata per errore,
// /admin sarebbe aperta a chiunque. Quindi ogni richiesta di admin porta l'header
// `Cf-Access-Jwt-Assertion`, e qui se ne controllano firma, audience, emittente e scadenza contro
// le chiavi pubbliche del team. Senza `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` configurati, /admin è
// spenta: chiusa per default.

const b64url = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const json = (part) => JSON.parse(new TextDecoder().decode(b64url(part)))

let certsCache = { at: 0, url: null, keys: null }
const CERTS_TTL_MS = 10 * 60 * 1000

async function certs(teamDomain, fetchImpl) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`
  if (certsCache.url === url && certsCache.keys && Date.now() - certsCache.at < CERTS_TTL_MS) return certsCache.keys
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`certs ${res.status}`)
  const body = await res.json()
  certsCache = { at: Date.now(), url, keys: body.keys ?? [] }
  return certsCache.keys
}

// Restituisce l'email di chi ha fatto login, o `null` se il token manca o non è valido.
export async function verifyAccess(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN
  const aud = env.ACCESS_AUD
  if (!teamDomain || !aud) return null
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const header = json(parts[0])
    const payload = json(parts[1])
    if (header.alg !== 'RS256') return null
    const keys = await certs(teamDomain, fetchImpl)
    const jwk = keys.find((k) => k.kid === header.kid)
    if (!jwk) return null
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    if (!ok) return null
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!auds.includes(aud)) return null
    if (payload.iss !== `https://${teamDomain}`) return null
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null
    return typeof payload.email === 'string' && payload.email ? payload.email : null
  } catch {
    return null
  }
}

// Solo per i test: svuota la cache delle chiavi.
export function _resetCerts() {
  certsCache = { at: 0, url: null, keys: null }
}
