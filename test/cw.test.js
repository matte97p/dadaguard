import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregate, periodFor } from '../server/runtime/cw.js'

test('aggregate: Sum / Average / Maximum / Minimum', () => {
  assert.equal(aggregate([1, 2, 3], 'Sum'), 6)
  assert.equal(aggregate([2, 4], 'Average'), 3)
  assert.equal(aggregate([5, 1, 9], 'Maximum'), 9)
  assert.equal(aggregate([5, 1, 9], 'Minimum'), 1)
})

test('aggregate: percentili → max dei punti; vuoto/undefined → 0', () => {
  assert.equal(aggregate([100, 250, 180], 'p95'), 250) // la coda peggiore della finestra
  assert.equal(aggregate([], 'Sum'), 0)
  assert.equal(aggregate(undefined, 'Average'), 0)
})

// ⚠️ CloudWatch non rifiuta un `Period` di granularità sbagliata: risponde 200 con `Values: []`, e il
// dead man's switch legge il vuoto come «nessuna esecuzione». Queste asserzioni sono l'unico posto in
// cui quel silenzio fa rumore.
test('periodFor: ogni finestra produce un Period della granularità che CloudWatch pretende', () => {
  const grana = (min) => (min > 62 * 1440 ? 3600 : min > 14 * 1440 ? 300 : 60)
  // Un minuto alla volta su tutte le finestre plausibili: `period` sale di 60s ogni 24 minuti, quindi
  // un campione rado salterebbe proprio i valori che sforano.
  for (let min = 1; min <= 95 * 1440; min += 1) {
    const p = periodFor(min)
    assert.equal(p % grana(min), 0, `finestra ${min}m → Period ${p} non multiplo di ${grana(min)}`)
    assert.ok(p >= 60 && p <= 86400, `finestra ${min}m → Period ${p} fuori dai limiti CloudWatch`)
  }
})

test('periodFor: il caso vero del 22/09/2026 (cron mensile, finestra ~18g)', () => {
  // Prima della correzione: 60 * round(26785/24) = 66960, che non è multiplo di 300 → zero punti.
  assert.equal(periodFor(26785) % 300, 0)
  assert.equal(periodFor(26761) % 300, 0)
  assert.equal(periodFor(26641) % 300, 0)
})

test('periodFor: sotto i 14 giorni la granularità resta al minuto (nessuna regressione)', () => {
  assert.equal(periodFor(7 * 24 * 60), 25200) // waste.js: 7 giorni → 24 bucket da 7 ore
  assert.equal(periodFor(60), 180) // 1 ora → bucket da 3 minuti
  assert.equal(periodFor(10), 60) // finestra minima → pavimento di 60s
})

test('periodFor: il tetto di 86400 vale anche dopo l\'arrotondamento per eccesso', () => {
  assert.equal(periodFor(400 * 1440), 86400) // 86400 è multiplo di 3600, quindi resta valido
})
