// Una riga cliccabile è comoda finché non ruba i gesti che vivono dentro di lei: il caso peggiore è
// il clic che apre un pannello mentre stavi copiando un nome, o al posto di aprire il link
// dell'endpoint. Qui si fissa chi vince.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowClickOpens } from '../web/format.js'

// Bersaglio finto: `closest` risponde sì se il selettore contiene uno degli antenati dichiarati.
const target = (...ancestors) => ({
  closest: (sel) => (ancestors.some((a) => sel.includes(a)) ? {} : null),
})

test('clic sul vuoto della riga: apre', () => {
  assert.equal(rowClickOpens(target()), true)
  assert.equal(rowClickOpens(target('td')), true)
})

test('clic su un link o un bottone: NON apre (il gesto è suo)', () => {
  assert.equal(rowClickOpens(target('a')), false)
  assert.equal(rowClickOpens(target('button')), false)
  assert.equal(rowClickOpens(target('input')), false)
})

test('clic nella colonna azioni o sulla freccia di espansione: NON apre', () => {
  assert.equal(rowClickOpens(target('.dg-actions')), false)
  assert.equal(rowClickOpens(target('.ant-table-row-expand-icon')), false)
  assert.equal(rowClickOpens(target('[data-no-row-click]')), false)
})

test('con del testo selezionato: NON apre, nemmeno sul vuoto', () => {
  // Trascinare per copiare un nome finisce con un mouseup, che è un clic: aprire un pannello lì
  // significa perdere la selezione appena fatta.
  assert.equal(rowClickOpens(target(), 'image-resizer'), false)
  assert.equal(rowClickOpens(target(), '   '), true) // solo spazi = nessuna selezione vera
  assert.equal(rowClickOpens(target(), ''), true)
})

test('bersaglio senza closest (o assente): apre, non esplode', () => {
  // Difensivo: se il bersaglio non è un elemento (jsdom parziale, evento sintetico) l'apertura è il
  // comportamento atteso, non un errore in console.
  assert.equal(rowClickOpens(null), true)
  assert.equal(rowClickOpens({}), true)
  assert.equal(rowClickOpens(undefined, 'x'), false) // la selezione vince anche senza bersaglio
})
