// La cache serve a non ripagare Cost Explorer (~$0.01 a chiamata) per un dato che si aggiorna poche
// volte al giorno. Due proprietà non negoziabili: le chiamate concorrenti non pagano due volte, e un
// ERRORE non resta in cache (altrimenti un errore momentaneo diventa un'ora di pagina rotta).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cached, invalidate, size } from '../server/util/ttlcache.js'

test('la seconda chiamata non richiama la funzione', async () => {
  invalidate()
  let chiamate = 0
  const fn = () => {
    chiamate++
    return Promise.resolve('x')
  }
  assert.equal(await cached('k', 60_000, fn), 'x')
  assert.equal(await cached('k', 60_000, fn), 'x')
  assert.equal(chiamate, 1)
})

test('scaduto il TTL si richiama', async () => {
  invalidate()
  let chiamate = 0
  const fn = () => Promise.resolve(++chiamate)
  await cached('k', 0, fn) // TTL 0 = sempre scaduto
  await cached('k', 0, fn)
  assert.equal(chiamate, 2)
})

test('chiamate concorrenti: una sola richiesta pagata', async () => {
  invalidate()
  let chiamate = 0
  const fn = () => {
    chiamate++
    return new Promise((r) => setTimeout(() => r('v'), 20))
  }
  const [a, b, c] = await Promise.all([cached('k', 60_000, fn), cached('k', 60_000, fn), cached('k', 60_000, fn)])
  assert.deepEqual([a, b, c], ['v', 'v', 'v'])
  assert.equal(chiamate, 1)
})

test('un errore NON resta in cache: il tentativo dopo riprova', async () => {
  invalidate()
  let chiamate = 0
  const fn = () => {
    chiamate++
    return chiamate === 1 ? Promise.reject(new Error('AccessDenied')) : Promise.resolve('ok')
  }
  await assert.rejects(() => cached('k', 60_000, fn), /AccessDenied/)
  assert.equal(await cached('k', 60_000, fn), 'ok')
  assert.equal(chiamate, 2)
})

test('invalidate per prefisso: svuota un gruppo, non tutto', async () => {
  invalidate()
  await cached('costs:prod:now', 60_000, () => Promise.resolve(1))
  await cached('trend:prod:13', 60_000, () => Promise.resolve(2))
  assert.equal(size(), 2)
  invalidate('costs:')
  assert.equal(size(), 1)
})
