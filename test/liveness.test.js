import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyProbe } from '../server/checks/liveness.js'

// Una sonda anonima da fuori non può dire se un'app PROTETTA è sana. Prima la sonda seguiva i
// redirect e leggeva 200 sulla pagina di login di Cloudflare Access: «risponde · HTTP 200» su
// un'applicazione che poteva essere spenta. Verificato sul vero, oggi:
//   GET https://dadaguard.example.com/ → 302 → example.cloudflareaccess.com/cdn-cgi/access/login/… → 200
const t = (k, v) => (v?.host ? `${k}:${v.host}` : k)

test('2xx risponde: è su', () => {
  assert.deepEqual(classifyProbe({ httpStatus: 200 }, t), { status: 'up' })
  assert.deepEqual(classifyProbe({ httpStatus: 204 }, t), { status: 'up' })
})

test('il login di Access NON è l’app: stato sconosciuto, non verde', () => {
  const r = classifyProbe(
    {
      httpStatus: 302,
      location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login/dadaguard.example.com?kid=abc',
      target: 'https://dadaguard.example.com/',
    },
    t,
  )
  assert.equal(r.status, 'unknown', 'dire "sano" guardando la porta è peggio che non saperlo')
  assert.equal(r.reason, 'liveness.gated')
})

test('altre porte di login note (Okta, Auth0, Google, Microsoft) → sconosciuto', () => {
  for (const host of ['acme.okta.com', 'acme.auth0.com', 'accounts.google.com', 'login.microsoftonline.com']) {
    const r = classifyProbe({ httpStatus: 302, location: `https://${host}/login`, target: 'https://app.example.com/' }, t)
    assert.equal(r.status, 'unknown', host)
  }
})

test('redirect INTERNO (http→https, / → /app, dominio canonico) resta "su"', () => {
  const r = classifyProbe({ httpStatus: 301, location: 'https://app.example.com/app', target: 'https://app.example.com/' }, t)
  assert.deepEqual(r, { status: 'up' })
})

test('redirect verso un altro host: non è questa app a rispondere', () => {
  const r = classifyProbe({ httpStatus: 302, location: 'https://altro.example.net/', target: 'https://app.example.com/' }, t)
  assert.equal(r.status, 'unknown')
  assert.equal(r.reason, 'liveness.elsewhere:altro.example.net')
})

test('4xx attenzione, 5xx giù (invariato)', () => {
  assert.deepEqual(classifyProbe({ httpStatus: 404 }, t), { status: 'degraded' })
  assert.deepEqual(classifyProbe({ httpStatus: 403 }, t), { status: 'degraded' })
  assert.deepEqual(classifyProbe({ httpStatus: 500 }, t), { status: 'down' })
  assert.deepEqual(classifyProbe({ httpStatus: 503 }, t), { status: 'down' })
})

test('3xx senza Location: ha risposto, non si inventa un problema', () => {
  assert.deepEqual(classifyProbe({ httpStatus: 302, location: null, target: 'https://app.example.com/' }, t), { status: 'up' })
})

test('Location illeggibile non fa esplodere il check', () => {
  assert.deepEqual(classifyProbe({ httpStatus: 302, location: 'non-un-url', target: 'https://app.example.com/' }, t), { status: 'up' })
})
