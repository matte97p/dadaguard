import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tacche, etichettaFascia, percorso, percorsoBanda, riduci, impila, tondo, agoBreve, numero } from '../web/grafici.js'

// I conti dei grafici del cruscotto (Flotta, Accessi): le tacche dell'asse, i buchi delle linee, le
// colonne impilate. Un'etichetta sbagliata sposta un guasto di un giorno; una linea che attraversa un
// buco disegna una misura che nessuno ha fatto.

const ORA = 3_600_000
const GIORNO = 24 * ORA

test('tacche: su sette giorni una tacca per mezzanotte locale, nel punto giusto anche fra due fasce', () => {
  const inizio = new Date(2026, 9, 1, 13, 0, 0).getTime()
  const tt = tacche({ inizio, passoMs: ORA, punti: 168 }, 'it')
  assert.equal(tt.length, 7)
  for (const k of tt) {
    const d = new Date(k.t)
    assert.equal(d.getHours(), 0)
    assert.equal(k.i, (k.t - inizio) / ORA)
  }
  assert.equal(tt[0].i, 11)
})

test('tacche: su un ora ogni quarto d ora, con l ora e i minuti', () => {
  const inizio = new Date(2026, 9, 7, 14, 2, 0).getTime()
  const tt = tacche({ inizio, passoMs: 120_000, punti: 30 }, 'it')
  assert.deepEqual(tt.map((k) => k.label), ['14:15', '14:30', '14:45', '15:00'])
})

test('tacche: una serie senza forma non ha tacche', () => {
  assert.deepEqual(tacche({}), [])
  assert.deepEqual(tacche({ inizio: 0, passoMs: 0, punti: 3 }), [])
})

test('etichettaFascia: l ora sola sotto l ora, l intervallo sopra, il giorno per le fasce di un giorno', () => {
  const t = new Date(2026, 9, 6, 14, 0).getTime()
  assert.match(etichettaFascia(t, ORA, 'it'), /14:00$/)
  assert.match(etichettaFascia(t, 6 * ORA, 'it'), /14:00 - 20:00$/)
  assert.doesNotMatch(etichettaFascia(t, GIORNO, 'it'), /:/)
  assert.equal(etichettaFascia(NaN, ORA), '')
})

test('percorso: un null spezza la linea invece di unire i vicini', () => {
  const d = percorso([1, 2, null, 4], (i) => i * 10, (v) => v)
  assert.equal(d, 'M0.0,1.0L10.0,2.0M30.0,4.0')
  assert.equal(percorso([null, null], (i) => i, (v) => v), '')
})

test('percorsoBanda: un tratto per ogni corsa in cui ci sono tutte e due le serie', () => {
  const d = percorsoBanda([5, 6, null, 7, 8], [1, 2, 3, 4, 5], (i) => i, (v) => v)
  assert.equal((d.match(/M/g) ?? []).length, 2)
  assert.equal((d.match(/Z/g) ?? []).length, 2)
})

test('riduci: i gruppi si contano dalla fine, e un gruppo tutto null resta null', () => {
  assert.deepEqual(riduci([1, 2, 3, 4, 5], 2, 'somma'), [1, 5, 9])
  assert.deepEqual(riduci([3, 1, null, null, 2, 5], 2, 'min'), [1, null, 2])
  assert.deepEqual(riduci([3, 1, 2], 1), [3, 1, 2])
})

test('impila: ogni pezzo parte dove finisce quello sotto, e una fascia ignota ha totale null', () => {
  const p = impila([{ k: 'a', valori: [1, null] }, { k: 'b', valori: [2, null] }], 2)
  assert.deepEqual(p[0].pezzi.map((x) => [x.da, x.a]), [[0, 1], [1, 3]])
  assert.equal(p[0].totale, 3)
  assert.equal(p[1].totale, null)
})

test('tondo: il massimo dell asse e 1, 2 o 5 per una potenza di dieci', () => {
  assert.equal(tondo(7.3), 10)
  assert.equal(tondo(1.4), 2)
  assert.equal(tondo(42), 50)
  assert.equal(tondo(0), 1)
})

test('agoBreve e numero: la cella stretta e la virgola della lingua', () => {
  const t = (k) => ({ 'ago.now': 'adesso', 'time.unit.m': 'm', 'time.unit.h': 'h', 'time.unit.d': 'g' })[k]
  const ora = Date.UTC(2026, 9, 7, 12)
  assert.equal(agoBreve(ora - 12 * 60_000, t, ora), '12m')
  assert.equal(agoBreve(ora - 25 * ORA, t, ora), '25h')
  assert.equal(agoBreve(ora - 3 * GIORNO, t, ora), '3g')
  assert.equal(agoBreve(null, t, ora), null)
  assert.equal(numero(3.74, 'it'), '3,7')
  assert.equal(numero(3.74, 'en'), '3.7')
  assert.equal(numero(null), null)
})
