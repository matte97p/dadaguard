import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finestra, entroLimiti, tetto, gradini, elenco } from '../server/finestre.js'

// Perche' queste prove. Il catalogo esiste per togliere sedici numeri sparsi in altrettanti file, e
// sbaglia in due modi che non fanno rumore: un endpoint che non e' dichiarato e prende un default per
// caso (e allora i sedici numeri rinascono), e un tetto che non viene applicato (e allora la pagina
// torna a scaricare tutto, che e' il guasto da cui siamo partiti).

test('finestre: una chiave non dichiarata e un errore, non un default', () => {
  assert.throws(() => finestra('endpoint-che-non-esiste'), /non dichiarata/)
})

test('finestre: il default e quello del catalogo', () => {
  assert.equal(finestra('teleport').def, 1)
  assert.equal(finestra('accessi-mappa').def, 168)
})

// ⚠️ Il tetto non e' un suggerimento: una query string che chiede un mese su un endpoint che ne
// dichiara una settimana viene riportata dentro, non accontentata.
test('finestre: chi chiede piu del massimo ottiene il massimo', () => {
  assert.equal(entroLimiti('teleport', 9999), 168)
  assert.equal(entroLimiti('deploys', 100000), 720)
})

test('finestre: valori non numerici o negativi tornano al default', () => {
  for (const v of [undefined, null, '', 'abc', 0, -5, NaN]) {
    assert.equal(entroLimiti('teleport', v), 1, `valore ${String(v)}`)
  }
})

test('finestre: un valore dentro i limiti passa intero', () => {
  assert.equal(entroLimiti('teleport', 24), 24)
})

test('finestre: il tetto delle righe e dichiarato, e le istantanee non ne hanno', () => {
  assert.equal(tetto('teleport'), 1500)
  assert.equal(tetto('quotas'), null)
})

// I gradini li da il catalogo e non la pagina: un elenco ricopiato in quattordici pagine diventa
// quattordici elenchi diversi al primo che ne cambia uno.
test('finestre: i gradini non superano mai il massimo dichiarato', () => {
  for (const f of elenco()) {
    for (const g of gradini(f.chiave)) {
      const maxOre = f.unita === 'giorni' ? f.max * 24 : f.max
      assert.ok(g <= maxOre, `${f.chiave}: gradino ${g} oltre ${maxOre}`)
    }
  }
})

test('finestre: le istantanee non offrono gradini', () => {
  assert.deepEqual(gradini('quotas'), [])
})

test('finestre: il default e sempre fra i gradini offerti', () => {
  for (const f of elenco()) {
    if (f.max === 0) continue
    const inOre = f.unita === 'giorni' ? f.def * 24 : f.def
    assert.ok(gradini(f.chiave).includes(inOre), `${f.chiave}: il default ${inOre} non e fra i gradini`)
  }
})

// Il catalogo e' la fonte: se qualcuno rimette un numero a mano in un endpoint, questa prova non lo
// vede. Vede pero' un catalogo incoerente, che e' il modo in cui il file smette di valere.
test('finestre: nessun default oltre il proprio massimo', () => {
  for (const f of elenco()) assert.ok(f.def <= f.max, `${f.chiave}: default ${f.def} oltre ${f.max}`)
})
