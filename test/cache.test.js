import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cachedCall, clearCache } from '../server/util/cache.js'

test('cachedCall: chiamate concorrenti con la stessa chiave → una sola esecuzione (single-flight)', async () => {
  clearCache()
  let calls = 0
  const fn = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 10))
    return 'v'
  }
  const [a, b, c] = await Promise.all([cachedCall('k', 1000, fn), cachedCall('k', 1000, fn), cachedCall('k', 1000, fn)])
  assert.equal(a, 'v')
  assert.equal(b, 'v')
  assert.equal(c, 'v')
  assert.equal(calls, 1, 'fn deve essere eseguita una sola volta')
})

test('cachedCall: entro il TTL riusa il valore, senza ri-eseguire', async () => {
  clearCache()
  let calls = 0
  const fn = async () => (calls++, calls)
  const first = await cachedCall('k', 1000, fn)
  const second = await cachedCall('k', 1000, fn)
  assert.equal(first, 1)
  assert.equal(second, 1, 'entro il TTL non ri-esegue')
  assert.equal(calls, 1)
})

test('cachedCall: scaduto il TTL ri-esegue', async () => {
  clearCache()
  let calls = 0
  const fn = async () => (calls++, calls)
  await cachedCall('k', 5, fn)
  await new Promise((r) => setTimeout(r, 15))
  const again = await cachedCall('k', 5, fn)
  assert.equal(again, 2, 'oltre il TTL ri-esegue')
})

test('cachedCall: gli errori non vengono cachati (si riprova)', async () => {
  clearCache()
  let calls = 0
  const fn = async () => {
    calls++
    if (calls === 1) throw new Error('boom')
    return 'ok'
  }
  await assert.rejects(() => cachedCall('k', 1000, fn), /boom/)
  const retry = await cachedCall('k', 1000, fn)
  assert.equal(retry, 'ok', 'dopo un errore la chiave è libera e riprova')
  assert.equal(calls, 2)
})
