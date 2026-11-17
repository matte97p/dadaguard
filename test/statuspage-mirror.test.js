import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseMirrorMap, toAtlassian, mirrorPlan, mirrorEnabled, pushMirror } from '../statuspage/mirror.js'
import { tick } from '../statuspage/worker.js'

// Id inventati: il repo è pubblico.
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test('parseMirrorMap: tiene solo id nostri noti e id remoti validi', () => {
  const map = parseMirrorMap(JSON.stringify({ web: 'abc123', api: 'bad id!', ghost: 'zzz999' }), ['web', 'api'])
  assert.deepEqual(map, { web: 'abc123' })
  assert.deepEqual(parseMirrorMap('non json', ['web']), {})
  assert.deepEqual(parseMirrorMap('[1,2]', ['web']), {})
})

test('toAtlassian: stati tradotti, unknown mai spinto, manutenzione vince', () => {
  assert.equal(toAtlassian('operational'), 'operational')
  assert.equal(toAtlassian('degraded'), 'degraded_performance')
  assert.equal(toAtlassian('outage'), 'major_outage')
  assert.equal(toAtlassian('unknown'), null)
  assert.equal(toAtlassian('outage', true), 'under_maintenance')
})

test('mirrorPlan: solo i componenti cambiati', () => {
  const plan = mirrorPlan({
    states: { web: 'operational', api: 'outage', jobs: 'unknown' },
    map: { web: 'r1', api: 'r2', jobs: 'r3' },
    sent: { web: 'operational', api: 'operational' },
  })
  assert.deepEqual(plan, [{ id: 'api', remote: 'r2', status: 'major_outage' }])
})

test('mirrorEnabled: servono pagina, chiave e mappa', () => {
  assert.equal(mirrorEnabled({ ATLASSIAN_PAGE_ID: 'p', ATLASSIAN_API_KEY: 'k' }), false)
  assert.equal(mirrorEnabled({ ATLASSIAN_PAGE_ID: 'p', ATLASSIAN_API_KEY: 'k', ATLASSIAN_COMPONENTS: '{}' }), true)
})

test('pushMirror: PATCH col formato di Statuspage, un errore non segna come mandato', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response('{}', { status: url.includes('r2') ? 500 : 200 })
  }
  const env = { ATLASSIAN_PAGE_ID: 'pg1', ATLASSIAN_API_KEY: 'key1' }
  const out = await pushMirror(env, [
    { id: 'web', remote: 'r1', status: 'operational' },
    { id: 'api', remote: 'r2', status: 'major_outage' },
  ], { api: 'operational' })
  assert.equal(calls[0].url, 'https://api.statuspage.io/v1/pages/pg1/components/r1')
  assert.equal(calls[0].init.method, 'PATCH')
  assert.equal(calls[0].init.headers.authorization, 'OAuth key1')
  assert.deepEqual(JSON.parse(calls[0].init.body), { component: { status: 'operational' } })
  assert.deepEqual(out, { web: 'operational', api: 'operational' })
})

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

test('tick: spinge su Statuspage al primo giro e non ripete al secondo', async () => {
  const patches = []
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.statuspage.io/')) {
      patches.push(JSON.parse(init.body).component.status)
      return new Response('{}', { status: 200 })
    }
    return new Response('ok', { status: 200 })
  }
  const env = {
    STATUS: kv(),
    COMPONENTS: JSON.stringify([{ id: 'web', it: 'Vetrina', probe: 'https://shop.example.com/' }]),
    ATLASSIAN_PAGE_ID: 'pg1',
    ATLASSIAN_API_KEY: 'key1',
    ATLASSIAN_COMPONENTS: JSON.stringify({ web: 'r1' }),
  }
  const first = await tick(env, new Date('2026-01-10T10:00:00Z'))
  assert.deepEqual(first.mirrored, { web: 'operational' })
  await tick(env, new Date('2026-01-10T10:01:00Z'))
  assert.deepEqual(patches, ['operational'])
})

test('tick: senza configurazione nessuna chiamata a Statuspage', async () => {
  let atlassian = 0
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://api.statuspage.io/')) atlassian++
    return new Response('ok', { status: 200 })
  }
  const env = { STATUS: kv(), COMPONENTS: JSON.stringify([{ id: 'web', it: 'Vetrina', probe: 'https://shop.example.com/' }]) }
  await tick(env, new Date('2026-01-10T10:00:00Z'))
  assert.equal(atlassian, 0)
})

test('/health: 200 col giro fresco, 503 con lo stato vecchio o assente, senza far partire un giro', async () => {
  const { default: worker, dueForStale } = await import('../statuspage/worker.js')
  let fetches = 0
  globalThis.fetch = async () => { fetches++; return new Response('ok') }
  const fresh = { STATUS: kv({ snap: { checkedAt: new Date().toISOString() } }), COMPONENTS: '[]' }
  const r1 = await worker.fetch(new Request('https://status.example.com/health'), fresh, { waitUntil() {} })
  assert.equal(r1.status, 200)
  const old = { STATUS: kv({ snap: { checkedAt: new Date(Date.now() - 10 * 60_000).toISOString() } }), COMPONENTS: '[]' }
  const r2 = await worker.fetch(new Request('https://status.example.com/health'), old, { waitUntil() { throw new Error('nessun giro') } })
  assert.equal(r2.status, 503)
  const none = { STATUS: kv(), COMPONENTS: '[]' }
  const r3 = await worker.fetch(new Request('https://status.example.com/health'), none, { waitUntil() {} })
  assert.equal(r3.status, 503)
  assert.equal(fetches, 0)
  assert.equal(dueForStale(null), true)
})
