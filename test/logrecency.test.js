import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backwardSlices } from '../server/logs.js'

// "Log recenti" deve dire le righe PIÙ RECENTI. FilterLogEvents pagina dal più vecchio, quindi
// chiedere 100 righe alla finestra intera dava le 100 più VECCHIE: su agentic-chat staging (3 nodi ALB
// che fanno health-check ogni 10s, ~1000 righe/h) il tetto si esauriva nei primi 90 secondi della
// finestra da 1h — e l'attività di adesso non compariva affatto.
// Le fette a ritroso sono il meccanismo che lo evita: qui si fissano copertura, ordine e costo.

test('le fette partono da adesso e vanno a ritroso', () => {
  const s = backwardSlices(60)
  assert.equal(s[0][0], 0) // la prima fetta tocca il presente
  for (let i = 1; i < s.length; i++) assert.equal(s[i][0], s[i - 1][1]) // contigue, senza buchi
})

test('le fette coprono tutta la finestra e non la superano', () => {
  for (const minutes of [1, 5, 60, 360, 1440, 2880]) {
    const s = backwardSlices(minutes)
    assert.equal(s[0][0], 0)
    assert.equal(s[s.length - 1][1], minutes, `finestra ${minutes} non coperta fino in fondo`)
    for (const [from, to] of s) assert.ok(to > from && to <= minutes)
  }
})

test('la prima fetta è piccola: sui servizi densi basta una chiamata per gli ultimi 100 eventi', () => {
  assert.deepEqual(backwardSlices(60)[0], [0, 1])
})

test('le fette crescono: 48h senza match si coprono in una ventina di chiamate, non in seicento', () => {
  const s = backwardSlices(2880)
  assert.ok(s.length <= 25, `48h in ${s.length} fette: troppe chiamate`)
  const naive = 2880 / 1
  assert.ok(s.length < naive / 20)
})

test('finestra di un minuto: una fetta sola', () => {
  assert.deepEqual(backwardSlices(1), [[0, 1]])
})
