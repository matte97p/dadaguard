import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isIdle } from '../server/waste.js'

test('isIdle: risorsa vecchia e sotto soglia → idle', () => {
  assert.equal(isIdle({ ageDays: 30, metric: 0.5, threshold: 2 }), true) // EC2 CPU 0.5% < 2%
  assert.equal(isIdle({ ageDays: 30, metric: 0, threshold: 0 }), true) // DB 0 connessioni
})

test('isIdle: sopra soglia → non idle', () => {
  assert.equal(isIdle({ ageDays: 30, metric: 5, threshold: 2 }), false) // CPU 5% > 2%
  assert.equal(isIdle({ ageDays: 30, metric: 1, threshold: 0 }), false) // DB con connessioni
})

test('isIdle: risorsa troppo giovane → mai segnalata (dati insufficienti)', () => {
  assert.equal(isIdle({ ageDays: 1, metric: 0, threshold: 2 }), false)
  assert.equal(isIdle({ ageDays: 2.9, metric: 0, threshold: 0 }), false)
})
