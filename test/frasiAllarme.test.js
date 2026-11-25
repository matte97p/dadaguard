import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fraseAllarme } from '../web/allarmi.js'

// `t` finto: la chiave e le variabili, per vedere cosa sceglie la funzione senza il dizionario.
const t = (k, v) => `${k}${v ? ' ' + JSON.stringify(v) : ''}`

test('fraseAllarme: nessun dato per N periodi', () => {
  const m = 'Threshold Crossed: no datapoints were received for 16 periods and 16 missing datapoints were treated as [Breaching].'
  assert.equal(fraseAllarme(m, t), 'alarm.noData {"n":16}')
})

test('fraseAllarme: valore sotto la soglia, con una sola misura', () => {
  const m = 'Threshold Crossed: 1 out of the last 1 datapoints [0.0 (25/11/26 12:29:00)] was less than the threshold (1.0) (minimum 1 datapoint for OK -> ALARM transition).'
  assert.equal(fraseAllarme(m, t), 'alarm.soglia.sotto {"v":"0","s":"1"}')
})

test('fraseAllarme: piu\' misure, prende la piu\' recente e dice quante su quante', () => {
  const m = 'Threshold Crossed: 2 out of the last 3 datapoints [6.0 (24/11/26 21:24:00), 2.0 (24/11/26 21:09:00)] were greater than the threshold (0.0) (minimum 2 datapoints for OK -> ALARM transition).'
  assert.equal(fraseAllarme(m, t), 'alarm.soglia.sopra {"v":"6","s":"0"}alarm.quante {"n":2,"m":3}')
})

test('fraseAllarme: «maggiore o uguale» e valori senza data (la forma della demo)', () => {
  const m = 'Threshold Crossed: 1 datapoint [3.0] was greater than or equal to the threshold (2.0).'
  assert.equal(fraseAllarme(m, t), 'alarm.soglia.sopraUguale {"v":"3","s":"2"}')
})

test('fraseAllarme: una forma che non conosce torna null, mai una frase inventata', () => {
  assert.equal(fraseAllarme('Unchecked: Initial alarm creation', t), null)
  assert.equal(fraseAllarme(null, t), null)
  assert.equal(fraseAllarme('', t), null)
})

test('fraseAllarme: una metrica di successi sotto soglia dice «in pratica» che l\'esecuzione non e\' riuscita', () => {
  const m = 'Threshold Crossed: 1 out of the last 1 datapoints [0.0 (25/11/26 12:29:00)] was less than the threshold (1.0) (minimum 1 datapoint for OK -> ALARM transition).'
  assert.equal(fraseAllarme(m, t, { metrica: 'Success' }), 'alarm.soglia.sotto {"v":"0","s":"1"}alarm.pratica.successoBasso')
})

test('fraseAllarme: nessun dato su una metrica di successi parla di esecuzioni, non di dati', () => {
  const m = 'Threshold Crossed: no datapoints were received for 6 periods and 6 missing datapoints were treated as [Breaching].'
  assert.equal(fraseAllarme(m, t, { metrica: 'RunSucceeded' }), 'alarm.noDataSuccesso {"n":6}')
})

test('fraseAllarme: una metrica di errori sopra soglia dice «in pratica» che ci sono stati errori', () => {
  const m = 'Threshold Crossed: 1 datapoint [4.0] was greater than or equal to the threshold (1.0).'
  assert.equal(fraseAllarme(m, t, { metrica: 'Errors' }), 'alarm.soglia.sopraUguale {"v":"4","s":"1"}alarm.pratica.errori')
})

test('fraseAllarme: una metrica che non conosce non aggiunge niente, e un verso opposto neppure', () => {
  const sotto = 'Threshold Crossed: 1 datapoint [0.0] was less than the threshold (1.0).'
  assert.equal(fraseAllarme(sotto, t, { metrica: 'QueueDepth' }), 'alarm.soglia.sotto {"v":"0","s":"1"}')
  assert.equal(fraseAllarme(sotto, t, { metrica: 'Errors' }), 'alarm.soglia.sotto {"v":"0","s":"1"}', 'errori che SCENDONO non sono un guasto')
})
