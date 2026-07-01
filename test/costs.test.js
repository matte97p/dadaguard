import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthRange } from '../server/costs.js'

test('monthRange: mese passato → intervallo completo del mese (End esclusivo)', () => {
  const now = new Date('2026-07-01T02:00:00Z')
  assert.deepEqual(monthRange('2026-06', now), { start: '2026-06-01', end: '2026-07-01' })
  assert.deepEqual(monthRange('2026-02', now), { start: '2026-02-01', end: '2026-03-01' })
  // wrap di fine anno: dicembre → primo gennaio dell'anno dopo
  assert.deepEqual(monthRange('2026-12', new Date('2027-01-05T02:00:00Z')), {
    start: '2026-12-01',
    end: '2027-01-01',
  })
})

test('monthRange: mese corrente → End cappato a domani (MTD, niente date future)', () => {
  const now = new Date('2026-07-10T02:00:00Z')
  assert.deepEqual(monthRange('2026-07', now), { start: '2026-07-01', end: '2026-07-11' })
})

test('monthRange: month assente/non valido → mese corrente', () => {
  const now = new Date('2026-07-10T02:00:00Z')
  assert.deepEqual(monthRange(undefined, now), { start: '2026-07-01', end: '2026-07-11' })
  assert.deepEqual(monthRange('nope', now), { start: '2026-07-01', end: '2026-07-11' })
})
