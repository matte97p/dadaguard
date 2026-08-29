// La durata di una run passa da qui, e non è la latenza per cui la funzione era nata: una run viva da
// tre ore e mezza si leggeva "234m 56s", cioè un numero da dividere a mente. Qui si fissano la scala
// (ms → s → m → h) e i due bordi che sbagliavano in silenzio, "1m 60s" e "3h 60m".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtMs, fmtCount } from '../server/util/format.js'

test('sotto il minuto: ms e secondi', () => {
  assert.equal(fmtMs(0), '0ms')
  assert.equal(fmtMs(999), '999ms')
  assert.equal(fmtMs(1500), '1.5s')
  assert.equal(fmtMs(45000), '45s')
  assert.equal(fmtMs(9999), '10s') // non "10.0s": la coda a zero la toglie già fmtCount, stessa regola
})

test("fra il minuto e l'ora: «Xm Ys»", () => {
  assert.equal(fmtMs(60000), '1m')
  assert.equal(fmtMs(245759), '4m 6s')
  assert.equal(fmtMs(3599000), '59m 59s')
})

test("da un'ora in su: ore e minuti, senza secondi", () => {
  assert.equal(fmtMs(3600000), '1h')
  assert.equal(fmtMs(14096000), '3h 55m') // la run viva del tooltip: 234m 56s
  assert.equal(fmtMs(108000000), '30h') // niente giorni: oltre le 24h una run non arriva in lista
})

test('i bordi non producono unità impossibili: mai 60s di minuti né 60m di ore', () => {
  assert.equal(fmtMs(119700), '2m') // 1m 59,7s: prima «1m 60s»
  assert.equal(fmtMs(14380000), '4h') // 3h 59m 40s: prima avrebbe dato «3h 60m»
  assert.equal(fmtMs(3599900), '1h') // a un decimo dall'ora: si sale, non si scrive «59m 60s»
  assert.equal(fmtMs(59700), '1m') // 59,7s: prima «60s», l'unità impossibile del bordo più basso
  assert.equal(fmtMs(59999), '1m')
})

test('non un numero: —, mai uno zero inventato', () => {
  assert.equal(fmtMs(undefined), '—')
  assert.equal(fmtMs(NaN), '—')
  assert.equal(fmtMs('3600000'), '—')
})

// Una durata negativa esiste per davvero: `endedAt - startedAt` con gli orologi di due macchine che non
// concordano (server/prefect.js). Prima usciva "-12000ms", che è un tempo che non significa niente.
test('durata negativa: —, non un tempo al contrario', () => {
  assert.equal(fmtMs(-1), '—')
  assert.equal(fmtMs(-12000), '—')
})

// Client e server sono bundle separati e la funzione è copiata: se divergono, la stessa run mostra due
// durate diverse in due punti della UI (tooltip della striscia e riepilogo della card).
test('il gemello client dà le stesse stringhe del server', async () => {
  const { fmtMs: webFmtMs } = await import('../web/format.js')
  for (const ms of [0, 999, 1500, 9999, 45000, 59700, 60000, 119700, 245759, 3599000, 3599900, 3600000, 14096000, 14380000, 108000000, -12000, NaN]) {
    assert.equal(webFmtMs(ms), fmtMs(ms), `divergenza su ${ms}`)
  }
})

// Stessa guardia sull'altro formattatore copiato nei due file, che era GIÀ divergente: il client si
// fermava ai "k", quindi 1,79 milioni di invocazioni erano "1.8M" nel riepilogo della card (server) e
// "1788k" nel tooltip dello sparkline (client), due numeri per lo stesso dato nella stessa pagina.
test('anche fmtCount è allineato fra i due gemelli, M e B compresi', async () => {
  const { fmtCount: webFmtCount } = await import('../web/format.js')
  for (const n of [0, 999, 1234, 9999, 15000, 999999, 1788000, 12500000, 2.5e9, NaN]) {
    assert.equal(webFmtCount(n), fmtCount(n), `divergenza su ${n}`)
  }
  assert.equal(fmtCount(1788000), '1.8M')
  assert.equal(fmtCount(2.5e9), '2.5B')
})
