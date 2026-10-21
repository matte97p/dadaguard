import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyProbe, run, timeoutInRitardo } from '../server/checks/liveness.js'

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

// Il 12/10/2026 la CPU di Dadaguard era al 100% e il timer dei 5 s e' scattato a 9,3 s: «giu'» su un
// frontend che rispondeva in 0,1 s. Qui il ritardo si simula bloccando il processo dentro la fetch
// finta, come facevano i due giri di stato sovrapposti.
const blocca = (ms) => {
  const fine = Date.now() + ms
  while (Date.now() < fine) {}
}
const appesa = (bloccaMs) => (_url, { signal }) => {
  blocca(bloccaMs)
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
}
const svc = { healthUrl: 'https://app.example.com/' }

test('timeout in ritardo poi risposta: la seconda lettura vince, niente «giu»', async () => {
  let n = 0
  const fetchImpl = (url, o) => (++n === 1 ? appesa(200)(url, o) : Promise.resolve({ status: 200, headers: new Headers() }))
  const r = await run(svc, { fetchImpl, timeoutMs: 50 })
  assert.equal(n, 2)
  assert.equal(r.status, 'up')
  assert.equal('timedOut' in r, false)
})

test('due timeout in ritardo: sconosciuto, non giu', async () => {
  const r = await run(svc, { fetchImpl: appesa(200), timeoutMs: 50 })
  assert.equal(r.status, 'unknown')
  assert.equal(r.reason, 'liveness.late')
})

test('timeout puntuale: e giu davvero, e non si riprova', async () => {
  let n = 0
  // 300 ms e non 50: «puntuale» vuol dire entro il 20% del timeout, e con 50 ms il margine era di 10 ms,
  // meno di quanto ritarda l'event loop con la suite intera in parallelo (falliva una volta su dieci).
  const r = await run(svc, { fetchImpl: (u, o) => (n++, appesa(0)(u, o)), timeoutMs: 300 })
  assert.equal(n, 1)
  assert.equal(r.status, 'down')
  assert.equal(r.reason, 'liveness.timeout')
})

test('soglia del ritardo: 20% oltre il timeout', () => {
  assert.equal(timeoutInRitardo(5900), false)
  assert.equal(timeoutInRitardo(9299), true)
})
