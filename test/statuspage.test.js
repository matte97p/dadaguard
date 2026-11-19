import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseComponents, decide } from '../statuspage/logic.js'
import worker, { tick, HISTORY_ARCHIVE_KEY } from '../statuspage/worker.js'

// Nomi e indirizzi inventati: il repo è pubblico.
const COMPONENTS = JSON.stringify([
  { id: 'web', probe: 'https://shop.example.com/' },
  { id: 'api', probe: 'https://api.example.com/health' },
  { id: 'jobs' },
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
})

test('parseComponents: scarta voci malformate e sonde non https, ignora i nomi', () => {
  const out = parseComponents(JSON.stringify([
    { id: 'web', it: 'Vetrina', probe: 'https://shop.example.com/' },
    { id: 'web' },
    { id: 'Maiuscolo' },
    { id: 'plain', probe: 'http://insicuro.example.com/' },
    { it: 'senza id' },
  ]))
  assert.deepEqual(out, [{ id: 'web', probe: 'https://shop.example.com/' }, { id: 'plain', probe: null }])
  assert.deepEqual(parseComponents('non json'), [])
})

test('decide: una sonda fallita sola non fa rosso, due sì', () => {
  assert.equal(decide({ probe: { ok: false, ms: 10 }, fails: 1 }), 'unknown')
  assert.equal(decide({ probe: { ok: false, ms: 10 }, fails: 2 }), 'outage')
  assert.equal(decide({ probe: { ok: true, ms: 200 } }), 'operational')
  assert.equal(decide({ probe: { ok: true, ms: 9000 } }), 'degraded')
})

test('decide: Dadaguard può solo peggiorare', () => {
  assert.equal(decide({ probe: { ok: true, ms: 100 }, interno: 'degraded' }), 'degraded')
  assert.equal(decide({ probe: { ok: true, ms: 100 }, interno: 'outage' }), 'outage')
  assert.equal(decide({ probe: { ok: false, ms: 1 }, fails: 3, interno: 'operational' }), 'outage')
  assert.equal(decide({ interno: 'operational' }), 'operational')
  assert.equal(decide({}), 'unknown')
})

test('tick: sonde e Dadaguard finiscono nello snapshot, senza storico', async () => {
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
  const STATUS = kv({ snap: { fails: { api: 1 } } })
  const env = { COMPONENTS, STATUS, DADAGUARD_URL: 'https://guard.example.com', DADAGUARD_CLIENT_ID: 'id', DADAGUARD_CLIENT_SECRET: 'sec' }
  const s = await tick(env, new Date('2026-01-01T10:00:00Z'))
  assert.deepEqual(s.states, { web: 'operational', api: 'outage', jobs: 'degraded' })
  assert.equal(s.interno, true)
  assert.equal('history' in s, false)
  assert.deepEqual([...STATUS.m.keys()], ['snap'])
  const g = chiamate.find((c) => c.u.includes('public-status'))
  assert.equal(g.headers['CF-Access-Client-Id'], 'id')
})

test('tick: senza Dadaguard resta la sonda, e lo dice', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('public-status')) throw new Error('giù')
    return new Response('ok')
  }
  const env = { COMPONENTS, STATUS: kv(), DADAGUARD_URL: 'https://guard.example.com' }
  const s = await tick(env, new Date('2026-01-01T10:00:00Z'))
  assert.equal(s.interno, false)
  assert.deepEqual(s.states, { web: 'operational', api: 'operational', jobs: 'unknown' })
})

test('tick: lo storico di una versione vecchia si sposta una volta in archivio, non si perde', async () => {
  globalThis.fetch = async () => new Response('ok')
  const history = { '2026-01-01': { web: { o: 1440, d: 0, x: 0, u: 0 } } }
  const STATUS = kv({ snap: { checkedAt: '2026-01-02T09:59:00.000Z', history }, items: [] })
  const puts = []
  const put = STATUS.put
  STATUS.put = async (k, v) => { puts.push(k); return put(k, v) }
  const env = { COMPONENTS, STATUS }
  await tick(env, new Date('2026-01-02T10:00:00Z'))
  assert.deepEqual(JSON.parse(STATUS.m.get(HISTORY_ARCHIVE_KEY)), history)
  assert.equal('history' in JSON.parse(STATUS.m.get('snap')), false)
  // Gli altri dati non si toccano.
  assert.equal(STATUS.m.get('items'), '[]')
  await tick(env, new Date('2026-01-02T10:01:00Z'))
  assert.deepEqual(puts, [HISTORY_ARCHIVE_KEY, 'snap', 'snap'])
})

test('fetch: solo /health, il resto 404', async () => {
  const env = { COMPONENTS, STATUS: kv({ snap: { checkedAt: new Date().toISOString() } }) }
  for (const path of ['/', '/api/status.json', '/feed.xml', '/admin', '/admin/api/items', '/nope']) {
    assert.equal((await worker.fetch(new Request(`https://status.example.com${path}`), env)).status, 404, path)
  }
  assert.equal((await worker.fetch(new Request('https://status.example.com/health'), env)).status, 200)
  assert.equal((await worker.fetch(new Request('https://status.example.com/health', { method: 'POST' }), env)).status, 405)
})

test('buildConfig: tutto dalle variabili, niente custom domain, cron ogni minuto', async () => {
  const { buildConfig } = await import('../statuspage/build-config.mjs')
  assert.throws(() => buildConfig({}), /mancano/)
  const base = { CLOUDFLARE_ACCOUNT_ID: 'acc', STATUSPAGE_HOST: 'status.example.com', STATUSPAGE_ZONE: 'example.com', STATUSPAGE_KV_ID: 'kv1', STATUSPAGE_COMPONENTS: COMPONENTS }
  assert.throws(() => buildConfig({ ...base, STATUSPAGE_HOST: 'https://status.example.com/' }), /host/)
  assert.throws(() => buildConfig({ ...base, STATUSPAGE_COMPONENTS: '[]' }), /componente/)
  const c = buildConfig({ ...base, STATUSPAGE_ACCESS_AUD: 'aud', STATUSPAGE_TZ: 'Europe/Rome' })
  assert.deepEqual(c.routes, [{ pattern: 'status.example.com/*', zone_name: 'example.com' }])
  assert.deepEqual(c.kv_namespaces, [{ binding: 'STATUS', id: 'kv1' }])
  assert.deepEqual(c.triggers.crons, ['* * * * *'])
  assert.equal(c.workers_dev, false)
  // Le variabili della vecchia pagina non arrivano più al Worker.
  assert.deepEqual(Object.keys(c.vars), ['COMPONENTS'])
  assert.deepEqual(JSON.parse(c.vars.COMPONENTS)[0], { id: 'web', probe: 'https://shop.example.com/' })
  assert.equal('DADAGUARD_CLIENT_SECRET' in c.vars, false)
  const due = buildConfig({ ...base, STATUSPAGE_HOST: 'status.example.com, status-test.example.com' })
  assert.deepEqual(due.routes.map((r) => r.pattern), ['status.example.com/*', 'status-test.example.com/*'])
  assert.throws(() => buildConfig({ ...base, STATUSPAGE_HOST: 'status.example.com,https://x' }), /host/)
})
