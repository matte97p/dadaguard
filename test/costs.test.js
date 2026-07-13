import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthRange, monthEndProjection } from '../server/costs.js'

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

test('monthEndProjection: mese corrente (MTD) → run-rate lineare sui giorni trascorsi', () => {
  // 10 giorni coperti su 30 (giugno) → factor 3
  const p = monthEndProjection({ gross: 100, total: 60, period: { start: '2026-06-01', end: '2026-06-11' } })
  assert.equal(p.daysElapsed, 10)
  assert.equal(p.daysInMonth, 30)
  assert.equal(p.pct, 33)
  assert.equal(p.gross, 300)
  assert.equal(p.net, 180)
})

test('monthEndProjection: mese chiuso (end = primo del mese dopo) → null', () => {
  assert.equal(monthEndProjection({ gross: 100, total: 100, period: { start: '2026-06-01', end: '2026-07-01' } }), null)
  // luglio completo (31 gg coperti su 31)
  assert.equal(monthEndProjection({ gross: 100, total: 100, period: { start: '2026-07-01', end: '2026-08-01' } }), null)
})

test('monthEndProjection: period assente/malformato → null (nessuna proiezione)', () => {
  assert.equal(monthEndProjection({ gross: 10, total: 10 }), null)
  assert.equal(monthEndProjection({}), null)
  assert.equal(monthEndProjection({ gross: 10, total: 10, period: { start: 'nope', end: 'nope' } }), null)
})
