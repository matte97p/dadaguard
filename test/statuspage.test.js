import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseComponents, decide, dayKey, addMinute, availability, validateNew, applyUpdate, isActive,
  incidentImpact, pruneItems, toRss,
} from '../statuspage/logic.js'
import worker, { tick, statusPayload, dueForTick, lastDays } from '../statuspage/worker.js'
import { verifyAccess, _resetCerts } from '../statuspage/access.js'

// Nomi e indirizzi inventati: il repo è pubblico.
const COMPONENTS = JSON.stringify([
  { id: 'web', it: 'Vetrina', en: 'Storefront', probe: 'https://shop.example.com/' },
  { id: 'api', it: 'API', probe: 'https://api.example.com/health' },
  { id: 'jobs', it: 'Elaborazioni' },
])

function kv(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]))
  return {
    m,
    async get(k, type) {
      const v = m.get(k)
      return v == null ? null : type === 'json' ? JSON.parse(v) : v
    },
    async put(k, v) {
      m.set(k, v)
    },
  }
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  _resetCerts()
})

test('parseComponents: scarta voci malformate e sonde non https', () => {
  const out = parseComponents(JSON.stringify([
    { id: 'web', it: 'Vetrina', probe: 'https://shop.example.com/' },
    { id: 'web', it: 'Doppione' },
    { id: 'Maiuscolo', it: 'X' },
    { id: 'plain', it: 'Chiaro', probe: 'http://insicuro.example.com/' },
    { id: 'senza-nome' },
  ]))
  assert.deepEqual(out.map((c) => c.id), ['web', 'plain'])
  assert.equal(out[1].probe, null)
  assert.equal(out[0].name.en, 'Vetrina')
  assert.deepEqual(parseComponents('non json'), [])
})

test('decide: una sonda fallita sola non fa rosso, due sì', () => {
  assert.equal(decide({ probe: { ok: false, ms: 10 }, fails: 1 }), 'unknown')
  assert.equal(decide({ probe: { ok: false, ms: 10 }, fails: 2 }), 'outage')
  assert.equal(decide({ probe: { ok: true, ms: 200 } }), 'operational')
  assert.equal(decide({ probe: { ok: true, ms: 9000 } }), 'degraded')
})

test('decide: Dadaguard e incidente aperto possono solo peggiorare', () => {
  assert.equal(decide({ probe: { ok: true, ms: 100 }, interno: 'degraded' }), 'degraded')
  assert.equal(decide({ probe: { ok: true, ms: 100 }, interno: 'outage' }), 'outage')
  assert.equal(decide({ probe: { ok: false, ms: 1 }, fails: 3, interno: 'operational' }), 'outage')
  assert.equal(decide({ interno: 'operational', incident: 'degraded' }), 'degraded')
  assert.equal(decide({}), 'unknown')
})

test('dayKey: il giorno è quello del fuso della pagina', () => {
  const d = new Date('2026-03-01T23:30:00Z')
  assert.equal(dayKey(d, 'UTC'), '2026-03-01')
  assert.equal(dayKey(d, 'Europe/Rome'), '2026-03-02')
})

test('addMinute: conta per stato e tiene solo gli ultimi giorni', () => {
  let h = addMinute({}, '2026-01-01', { web: 'operational', api: 'outage' })
  h = addMinute(h, '2026-01-01', { web: 'degraded', api: 'unknown' })
  assert.deepEqual(h['2026-01-01'], { web: { o: 1, d: 1, x: 0, u: 0 }, api: { o: 0, d: 0, x: 1, u: 1 } })
  h = addMinute(h, '2026-01-02', { web: 'operational' }, 1)
  assert.deepEqual(Object.keys(h), ['2026-01-02'])
})

test('availability: i rallentati sono disponibili, gli ignoti non contano', () => {
  assert.equal(availability([{ o: 90, d: 10, x: 0, u: 50 }]), 1)
  assert.equal(availability([{ o: 98, d: 0, x: 2, u: 0 }, null]), 0.98)
  assert.equal(availability([null, { o: 0, d: 0, x: 0, u: 5 }]), null)
})

test('validateNew: campi obbligatori e testi puliti', () => {
  const now = new Date('2026-01-01T10:00:00Z')
  assert.throws(() => validateNew({ components: [] }, ['web'], { now, id: 'a' }), /componente/)
  assert.throws(() => validateNew({ components: ['web'], title: {}, text: { it: 'x' } }, ['web'], { now, id: 'a' }), /titolo/)
  assert.throws(() => validateNew({ kind: 'maintenance', components: ['web'], title: { it: 'x' }, text: { it: 'y' } }, ['web'], { now, id: 'a' }), /fine prevista/)
  const i = validateNew({ components: ['web', 'zzz'], impact: 'outage', title: { it: ' Giù\u0007 ' }, text: { en: 'Down' } }, ['web'], { now, by: 'rossi@example.com', id: 'a' })
  assert.deepEqual(i.components, ['web'])
  assert.equal(i.impact, 'outage')
  assert.deepEqual(i.title, { it: 'Giù', en: 'Giù' })
  assert.deepEqual(i.updates[0].text, { it: 'Down', en: 'Down' })
  assert.equal(i.updates[0].status, 'investigating')
  assert.equal(i.resolved, false)
})

test('applyUpdate: risolto chiude e fissa la fine', () => {
  const t0 = new Date('2026-01-01T10:00:00Z')
  const i = validateNew({ components: ['web'], title: { it: 't' }, text: { it: 'a' } }, ['web'], { now: t0, id: 'a' })
  assert.throws(() => applyUpdate(i, { status: 'boh', text: { it: 'x' } }, { now: t0 }), /stato/)
  const t1 = new Date('2026-01-01T10:30:00Z')
  const r = applyUpdate(i, { status: 'resolved', text: { it: 'ok' } }, { now: t1 })
  assert.equal(r.resolved, true)
  assert.equal(r.end, t1.toISOString())
  assert.equal(r.updates.length, 2)
  assert.equal(r.updates[0].status, 'resolved')
})

test('isActive e incidentImpact: la manutenzione non fa rosso, l\'incidente sì', () => {
  const now = new Date('2026-01-01T12:00:00Z')
  const inc = { kind: 'incident', impact: 'outage', components: ['web'], start: '2026-01-01T11:00:00.000Z', end: null, resolved: false, updates: [] }
  const mnt = { kind: 'maintenance', impact: 'maintenance', components: ['api'], start: '2026-01-01T11:30:00.000Z', end: '2026-01-01T12:30:00.000Z', resolved: false, updates: [] }
  assert.equal(isActive(inc, now), true)
  assert.equal(isActive(mnt, now), true)
  assert.equal(isActive(mnt, new Date('2026-01-01T13:00:00Z')), false)
  assert.equal(incidentImpact([inc, mnt], 'web', now), 'outage')
  assert.equal(incidentImpact([inc, mnt], 'api', now), null)
})

test('pruneItems: via i chiusi oltre 90 giorni, restano gli aperti', () => {
  const now = new Date('2026-06-01T00:00:00Z')
  const old = { resolved: true, start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' }
  const open = { resolved: false, start: '2026-01-01T00:00:00.000Z', end: null }
  assert.deepEqual(pruneItems([old, open], now), [open])
})

test('toRss: escape dei testi e lingua scelta', () => {
  const items = [{ id: 'a', title: { it: 'Giù <tutto>', en: 'Down' }, start: '2026-01-01T10:00:00.000Z', updates: [{ at: '2026-01-01T10:00:00.000Z', status: 'investigating', text: { it: 'x & y', en: 'z' } }] }]
  const it = toRss(items, { title: 'Prova', link: 'https://status.example.com/' })
  assert.match(it, /Giù &lt;tutto&gt;/)
  assert.match(it, /x &amp; y/)
  assert.match(toRss(items, { title: 'Prova', link: 'https://status.example.com/', lang: 'en' }), /<title>Down<\/title>/)
})

test('tick: sonde, Dadaguard e storico finiscono nello snapshot', async () => {
  const chiamate = []
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    chiamate.push({ u, headers: opts?.headers })
    if (u.startsWith('https://shop.example.com')) return new Response('ok', { status: 200 })
    if (u.startsWith('https://api.example.com')) return new Response('err', { status: 503 })
    if (u.startsWith('https://guard.example.com/api/public-status')) {
      return new Response(JSON.stringify({ components: [{ id: 'jobs', state: 'degraded' }, { id: 'web', state: 'operational' }] }), { headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`inatteso ${u}`)
  }
  const env = { COMPONENTS, STATUS: kv({ snap: { fails: { api: 1 } } }), DADAGUARD_URL: 'https://guard.example.com', DADAGUARD_CLIENT_ID: 'id', DADAGUARD_CLIENT_SECRET: 'sec', TZ: 'UTC' }
  const s = await tick(env, new Date('2026-01-01T10:00:00Z'))
  assert.deepEqual(s.states, { web: 'operational', api: 'outage', jobs: 'degraded' })
  assert.equal(s.interno, true)
  assert.deepEqual(s.history['2026-01-01'].api, { o: 0, d: 0, x: 1, u: 0 })
  const g = chiamate.find((c) => c.u.includes('public-status'))
  assert.equal(g.headers['CF-Access-Client-Id'], 'id')
})

test('tick: senza Dadaguard resta la sonda, e lo dice', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('public-status')) throw new Error('giù')
    return new Response('ok')
  }
  const env = { COMPONENTS, STATUS: kv(), DADAGUARD_URL: 'https://guard.example.com', TZ: 'UTC' }
  const s = await tick(env, new Date('2026-01-01T10:00:00Z'))
  assert.equal(s.interno, false)
  assert.deepEqual(s.states, { web: 'operational', api: 'operational', jobs: 'unknown' })
})

test('statusPayload: storico per giorno e niente autore degli incidenti', async () => {
  const now = new Date('2026-01-03T10:00:00Z')
  const env = {
    COMPONENTS,
    TZ: 'UTC',
    STATUS: kv({
      snap: { checkedAt: '2026-01-03T09:59:30.000Z', interno: true, states: { web: 'operational' }, history: { '2026-01-02': { web: { o: 1440, d: 0, x: 0, u: 0 } } } },
      items: [{ id: 'a', kind: 'incident', impact: 'degraded', components: ['web'], title: { it: 't', en: 't' }, start: '2026-01-02T10:00:00.000Z', end: null, resolved: false, updates: [{ at: '2026-01-02T10:00:00.000Z', status: 'investigating', text: { it: 'x', en: 'x' }, by: 'rossi@example.com' }] }],
    }),
  }
  const p = await statusPayload(env, now)
  assert.equal(p.stale, false)
  assert.equal(p.days.length, 90)
  assert.equal(p.days.at(-1), '2026-01-03')
  const web = p.components.find((c) => c.id === 'web')
  assert.deepEqual(web.history.at(-2), { o: 1440, d: 0, x: 0, u: 0 })
  assert.equal(web.uptime, 1)
  assert.equal(JSON.stringify(p).includes('rossi@example.com'), false)
})

test('statusPayload: dati vecchi di oltre 3 minuti sono dichiarati', async () => {
  const env = { COMPONENTS, STATUS: kv({ snap: { checkedAt: '2026-01-03T09:50:00.000Z' } }) }
  assert.equal((await statusPayload(env, new Date('2026-01-03T10:00:00Z'))).stale, true)
  assert.equal((await statusPayload({ COMPONENTS, STATUS: kv() }, new Date())).stale, true)
})

test('fetch: /admin senza token di Access risponde 403, anche configurato', async () => {
  const env = { COMPONENTS, STATUS: kv(), ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: 'aud' }
  for (const [path, method] of [['/admin', 'GET'], ['/admin/api/items', 'GET'], ['/admin/api/items', 'POST']]) {
    const res = await worker.fetch(new Request(`https://status.example.com${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }), env)
    assert.equal(res.status, 403, `${method} ${path}`)
  }
  const spento = await worker.fetch(new Request('https://status.example.com/admin'), { COMPONENTS, STATUS: kv() })
  assert.equal(spento.status, 403)
})

test('fetch: la pagina ha CSP con nonce e il JSON risponde', async () => {
  const env = { COMPONENTS, STATUS: kv(), SITE_NAME: 'Prova' }
  const page = await worker.fetch(new Request('https://status.example.com/'), env)
  const csp = page.headers.get('content-security-policy')
  const n = csp.match(/nonce-([A-Za-z0-9+/=]+)/)[1]
  const body = await page.text()
  assert.match(body, new RegExp(`<script nonce="${n.replace(/[+/=]/g, '\\$&')}">`))
  assert.match(csp, /frame-ancestors 'none'/)
  const j = await worker.fetch(new Request('https://status.example.com/api/status.json'), env)
  assert.equal(j.status, 200)
  assert.equal((await j.json()).site, 'Prova')
  assert.equal((await worker.fetch(new Request('https://status.example.com/nope'), env)).status, 404)
  assert.equal((await worker.fetch(new Request('https://status.example.com/', { method: 'POST' }), env)).status, 405)
})

// Un token di Access firmato con una chiave generata qui, e le chiavi pubbliche servite da un fetch finto.
async function accessFixture({ aud = 'aud-1', iss = 'https://team.example.com', exp = Math.floor(Date.now() / 1000) + 600, email = 'rossi@example.com' } = {}) {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' }
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'RS256', kid: 'k1' })
  const body = b64({ aud: [aud], iss, exp, email })
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`))).toString('base64url')
  const fetchImpl = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })
  return { token: `${head}.${body}.${sig}`, fetchImpl }
}

const reqWith = (token) => new Request('https://status.example.com/admin', { headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} })
const ENV_ACCESS = { ACCESS_TEAM_DOMAIN: 'team.example.com', ACCESS_AUD: 'aud-1' }

test('verifyAccess: token valido restituisce l\'email', async () => {
  const { token, fetchImpl } = await accessFixture()
  assert.equal(await verifyAccess(reqWith(token), ENV_ACCESS, { fetchImpl }), 'rossi@example.com')
})

test('verifyAccess: audience, emittente, scadenza e firma sbagliati non passano', async () => {
  for (const opts of [{ aud: 'altro' }, { iss: 'https://evil.example.com' }, { exp: Math.floor(Date.now() / 1000) - 10 }]) {
    _resetCerts()
    const { token, fetchImpl } = await accessFixture(opts)
    assert.equal(await verifyAccess(reqWith(token), ENV_ACCESS, { fetchImpl }), null, JSON.stringify(opts))
  }
  _resetCerts()
  const { token, fetchImpl } = await accessFixture()
  const [h, p] = token.split('.')
  const altro = Buffer.from(JSON.stringify({ aud: ['aud-1'], iss: 'https://team.example.com', exp: 9999999999, email: 'intruso@example.com' })).toString('base64url')
  assert.equal(await verifyAccess(reqWith(`${h}.${altro}.${token.split('.')[2]}`), ENV_ACCESS, { fetchImpl }), null)
  assert.equal(await verifyAccess(reqWith(`${h}.${p}`), ENV_ACCESS, { fetchImpl }), null)
  assert.equal(await verifyAccess(reqWith(null), ENV_ACCESS, { fetchImpl }), null)
  assert.equal(await verifyAccess(reqWith(token), {}, { fetchImpl }), null)
})

test('buildConfig: tutto dalle variabili, niente custom domain, cron ogni minuto', async () => {
  const { buildConfig } = await import('../statuspage/build-config.mjs')
  assert.throws(() => buildConfig({}), /mancano/)
  const base = { CLOUDFLARE_ACCOUNT_ID: 'acc', STATUSPAGE_HOST: 'status.example.com', STATUSPAGE_ZONE: 'example.com', STATUSPAGE_KV_ID: 'kv1', STATUSPAGE_COMPONENTS: COMPONENTS }
  assert.throws(() => buildConfig({ ...base, STATUSPAGE_HOST: 'https://status.example.com/' }), /host/)
  assert.throws(() => buildConfig({ ...base, STATUSPAGE_COMPONENTS: '[]' }), /componente/)
  const c = buildConfig({ ...base, STATUSPAGE_TZ: 'Europe/Rome' })
  assert.deepEqual(c.routes, [{ pattern: 'status.example.com/*', zone_name: 'example.com' }])
  assert.deepEqual(c.kv_namespaces, [{ binding: 'STATUS', id: 'kv1' }])
  assert.deepEqual(c.triggers.crons, ['* * * * *'])
  assert.equal(c.workers_dev, false)
  assert.equal(c.vars.TZ, 'Europe/Rome')
  assert.equal(JSON.parse(c.vars.COMPONENTS).length, 3)
  assert.equal('DADAGUARD_CLIENT_SECRET' in c.vars, false)
  const due = buildConfig({ ...base, STATUSPAGE_HOST: 'status.example.com, status-test.example.com' })
  assert.deepEqual(due.routes.map((r) => r.pattern), ['status.example.com/*', 'status-test.example.com/*'])
  assert.throws(() => buildConfig({ ...base, STATUSPAGE_HOST: 'status.example.com,https://x' }), /host/)
})

test("dueForTick: un giro al minuto al massimo, anche con più visite", () => {
  const now = Date.parse('2026-01-01T10:00:00Z')
  assert.equal(dueForTick(null, now), true)
  assert.equal(dueForTick('2026-01-01T09:59:30.000Z', now), false)
  assert.equal(dueForTick('2026-01-01T09:59:00.000Z', now), true)
})

test('lastDays: 90 giorni di calendario anche attraverso il cambio dell\'ora legale', () => {
  const days = lastDays(new Date('2026-11-12T22:00:00Z'), 'Europe/Rome')
  assert.equal(days.length, 90)
  assert.equal(new Set(days).size, 90)
  assert.equal(days.at(-1), '2026-11-12')
  assert.equal(days[0], '2026-08-15')
  assert.ok(days.includes('2026-10-25'))
})
