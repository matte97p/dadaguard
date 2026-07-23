import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRun, parseCron } from '../server/util/nextrun.js'

// 2026-01-01 è giovedì (Thu); 02 ven, 03 sab, 04 dom, 05 lun.

test('cron daily 02:00 — prima delle 02:00 → oggi', () => {
  assert.equal(nextRun('cron(0 2 * * ? *)', Date.UTC(2026, 0, 1, 1, 0)), Date.UTC(2026, 0, 1, 2, 0))
})

test('cron daily 02:00 — dopo le 02:00 → domani', () => {
  assert.equal(nextRun('cron(0 2 * * ? *)', Date.UTC(2026, 0, 1, 3, 0)), Date.UTC(2026, 0, 2, 2, 0))
})

test('cron hourly :00', () => {
  assert.equal(nextRun('cron(0 * * * ? *)', Date.UTC(2026, 0, 1, 1, 30)), Date.UTC(2026, 0, 1, 2, 0))
})

test('cron ogni 15 minuti (*/15)', () => {
  assert.equal(nextRun('cron(*/15 * * * ? *)', Date.UTC(2026, 0, 1, 1, 7)), Date.UTC(2026, 0, 1, 1, 15))
})

test('cron feriali 09:00 (MON-FRI) — giovedì dopo le 9 → venerdì', () => {
  assert.equal(nextRun('cron(0 9 ? * MON-FRI *)', Date.UTC(2026, 0, 1, 10, 0)), Date.UTC(2026, 0, 2, 9, 0))
})

test('cron feriali 09:00 — venerdì dopo le 9 salta il weekend → lunedì', () => {
  assert.equal(nextRun('cron(0 9 ? * MON-FRI *)', Date.UTC(2026, 0, 2, 10, 0)), Date.UTC(2026, 0, 5, 9, 0))
})

test('cron domenicale (dow=1=DOM in AWS)', () => {
  assert.equal(nextRun('cron(0 0 ? * 1 *)', Date.UTC(2026, 0, 1, 0, 0)), Date.UTC(2026, 0, 4, 0, 0))
})

test('rate(...) → null (anchor sconosciuto)', () => {
  assert.equal(nextRun('rate(1 hour)', Date.UTC(2026, 0, 1, 0, 0)), null)
})

test('caratteri avanzati non supportati (L) → null', () => {
  assert.equal(nextRun('cron(0 0 L * ? *)', Date.UTC(2026, 0, 1, 0, 0)), null)
})

test('parseCron: numero di campi errato → null', () => {
  assert.equal(parseCron('cron(0 2 * * ?)'), null)
  assert.equal(parseCron('non-cron'), null)
  assert.equal(parseCron(''), null)
})
