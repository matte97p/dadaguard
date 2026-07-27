import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sparkStats } from '../web/format.js'

// Quando vale la pena disegnare un mini-grafico in una card, e con che scala. È la regola che
// decide fra "andamento leggibile" e "filetto che confonde": il numero è già scritto accanto,
// il grafico serve solo se aggiunge una FORMA.

test('sparkStats: serve un andamento, non due punti', () => {
  assert.equal(sparkStats([]).show, false)
  assert.equal(sparkStats([5]).show, false)
  assert.equal(sparkStats([1, 9]).show, false) // due punti sono un segmento
  assert.equal(sparkStats([1, 5, 9]).show, true)
})

test('sparkStats: serie piatta o quasi → niente grafico', () => {
  assert.equal(sparkStats([4, 4, 4, 4]).show, false) // piatta: sembrava un bordo per sbaglio
  assert.equal(sparkStats([0, 0, 0]).show, false) // cron mai partita nella finestra
  assert.equal(sparkStats([100, 103, 101, 102]).show, false) // 3% di escursione: niente da vedere
  assert.equal(sparkStats([100, 130, 90, 120]).show, true) // 30%: c'è un andamento
})

test('sparkStats: scarta i buchi (bucket CloudWatch vuoti) senza inventare zeri', () => {
  const s = sparkStats([2, null, 6, undefined, 4, NaN])
  assert.deepEqual(s.vals, [2, 6, 4])
  assert.equal(s.min, 2)
  assert.equal(s.max, 6)
  assert.equal(s.last, 4)
})

test('sparkStats: min/max/ultimo per il tooltip (il grafico non è l\'unico modo di leggere il dato)', () => {
  const s = sparkStats([3, 8, 5])
  assert.deepEqual({ min: s.min, max: s.max, last: s.last, show: s.show }, { min: 3, max: 8, last: 5, show: true })
})
