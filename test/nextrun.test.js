import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRun, parseCron, prevRun, missedWindow } from '../server/util/nextrun.js'

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

// --- prevRun / missedWindow: il dead man's switch per i cron a cadenza NON costante ---
// Caso reale (27/07/2026): due `scrape-volume-monitor` (staging e prod) rossi insieme di lunedì.
// Il cron è `cron(0 17 ? * MON-FRI *)`: l'ultima esecuzione attesa era venerdì 17:00, 67 ore prima.
// Con la finestra dedotta da una cadenza "giornaliera" (29h) il controllo grida al guasto ogni
// lunedì. La finestra deve venire dall'espressione, non da una cadenza inventata.

test('prevRun: fire precedente (lun-ven 17:00, guardando lunedì mattina → venerdì)', () => {
  // 2026-07-27 è lunedì; 2026-07-24 venerdì.
  const lunMattina = Date.UTC(2026, 6, 27, 12, 4)
  assert.equal(prevRun('cron(0 17 ? * MON-FRI *)', lunMattina), Date.UTC(2026, 6, 24, 17, 0))
})

test('prevRun: daily → il fire di ieri; subito dopo lo scatto → quello appena passato', () => {
  assert.equal(prevRun('cron(0 2 * * ? *)', Date.UTC(2026, 0, 2, 1, 0)), Date.UTC(2026, 0, 1, 2, 0))
  assert.equal(prevRun('cron(0 2 * * ? *)', Date.UTC(2026, 0, 2, 2, 30)), Date.UTC(2026, 0, 2, 2, 0))
})

test('prevRun: rate() e caratteri non gestiti → null (niente stima inventata)', () => {
  assert.equal(prevRun('rate(1 hour)', Date.UTC(2026, 0, 2, 1, 0)), null)
  assert.equal(prevRun('cron(0 17 L * ? *)', Date.UTC(2026, 0, 2, 1, 0)), null)
})

test('missedWindow: lun-ven visto di lunedì → finestra che copre il venerdì (non 29h)', () => {
  const lunMattina = Date.UTC(2026, 6, 27, 12, 4)
  const w = missedWindow('cron(0 17 ? * MON-FRI *)', lunMattina)
  assert.equal(w.expectedAt, Date.UTC(2026, 6, 24, 17, 0))
  const oreDiFinestra = Math.round(w.windowMin / 60)
  assert.ok(oreDiFinestra >= 67 && oreDiFinestra <= 68, `finestra ${oreDiFinestra}h, attese ~67h`)
})

test('missedWindow: appena scattato → misura sul fire PRECEDENTE (metrica non ancora pubblicata)', () => {
  // 2 minuti dopo lo scatto delle 17:00: il riferimento resta quello del giorno prima, altrimenti
  // il controllo diventa rosso per un paio di minuti a ogni esecuzione.
  const w = missedWindow('cron(0 2 * * ? *)', Date.UTC(2026, 0, 2, 2, 2))
  assert.equal(w.expectedAt, Date.UTC(2026, 0, 1, 2, 0))
})

test('missedWindow: cron ogni minuto → finestra corta (cadenza + grazia)', () => {
  const w = missedWindow('cron(* * * * ? *)', Date.UTC(2026, 0, 2, 3, 30))
  assert.ok(w.windowMin <= 21, `finestra ${w.windowMin}m troppo larga per un cron al minuto`)
})

test('missedWindow: espressione non calcolabile → null (il chiamante torna all euristica)', () => {
  assert.equal(missedWindow('rate(4 hours)', Date.UTC(2026, 0, 2, 3, 30)), null)
})
