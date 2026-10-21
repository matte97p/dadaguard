import { test } from 'node:test'
import assert from 'node:assert/strict'
import { creaPronto } from '../server/util/pronto.js'

function conOrologio(opts) {
  let adesso = 0
  const pronto = creaPronto({ ...opts, now: () => adesso })
  return { pronto, avanza: (ms) => (adesso += ms) }
}

test('pronto: non lo è finché manca una scaldata', () => {
  const { pronto } = conOrologio({ attesi: ['status', 'runs'] })
  pronto.fatto('status')
  assert.deepEqual(pronto.stato(), { pronto: false, mancano: ['runs'], scaduto: false })
  pronto.fatto('runs')
  assert.equal(pronto.stato().pronto, true)
})

test('pronto: si apre comunque dopo maxMs, e dice che è per scadenza', () => {
  const { pronto, avanza } = conOrologio({ attesi: ['status'], maxMs: 1000 })
  avanza(999)
  assert.equal(pronto.stato().pronto, false)
  avanza(1)
  assert.deepEqual(pronto.stato(), { pronto: true, mancano: ['status'], scaduto: true })
})

test('pronto: senza niente da aspettare (demo) è pronto subito', () => {
  const { pronto } = conOrologio({ attesi: [] })
  assert.equal(pronto.stato().pronto, true)
})

test('pronto: quando() si risolve all\'ultima scaldata, non prima', async () => {
  const { pronto } = conOrologio({ attesi: ['status', 'runs'] })
  let risolto = false
  pronto.quando().then(() => (risolto = true))
  pronto.fatto('status')
  await Promise.resolve()
  assert.equal(risolto, false)
  pronto.fatto('runs')
  await pronto.quando()
  assert.equal(risolto, true)
})
