import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { makeT, hasKey } from '../server/i18n.js'

test('makeT: interpolazione it/en', () => {
  assert.equal(makeT('it')('lambda.calls', { n: 5 }), '5 chiamate')
  assert.equal(makeT('en')('lambda.calls', { n: 5 }), '5 calls')
})

test('makeT: lingua sconosciuta → fallback IT', () => {
  assert.equal(makeT('xx')('drift.insync'), 'sì')
})

test('makeT: chiave assente → ritorna la chiave', () => {
  assert.equal(makeT('it')('nope.nope'), 'nope.nope')
})

// Anti-regressione: ogni chiave i18n `namespace.key` usata staticamente nei provider runtime e nei
// check deve esistere in it E en. Così un provider nuovo (bedrock/sagemaker/ses/opensearch…) non può
// più finire in produzione mostrando la chiave grezza perché il dizionario server non è stato aggiornato.
test('i18n server: le chiavi usate nel server (top-level, runtime, checks) esistono in it e en', () => {
  const it = makeT('it')
  const en = makeT('en')
  const used = new Set()
  for (const d of ['../server/', '../server/runtime/', '../server/checks/']) {
    const dirUrl = new URL(d, import.meta.url)
    for (const f of readdirSync(dirUrl)) {
      if (!f.endsWith('.js') || f === 'i18n.js') continue // i18n.js ha le DEFINIZIONI, non usi
      const src = readFileSync(new URL(f, dirUrl), 'utf8')
      for (const m of src.matchAll(/t\('([a-z]+\.[a-zA-Z.]+)'/g)) used.add(m[1])
    }
  }
  // `hasKey` e non `t`: `makeT('en')` ripiega sull'italiano, quindi una riga EN dimenticata non fa
  // uscire la chiave grezza (che questo test vedrebbe) ma la parola italiana a chi legge in inglese.
  const missing = [...used].filter((k) => !hasKey('it', k) || !hasKey('en', k)).sort()
  assert.deepEqual(missing, [], `chiavi i18n usate ma assenti nel dizionario server: ${missing.join(', ')}`)
})

// Forma plurale delle etichette: un conteggio e la sua parola devono concordare. "1 errori" era
// visibile in tabella, dove la cella compone «numero + etichetta».
test('makeT: forma plurale {n#singolare#plurale} (IT ed EN)', () => {
  const it = makeT('it')
  const en = makeT('en')
  assert.equal(it('m.errors', { n: 1 }), 'errore')
  assert.equal(it('m.errors', { n: 0 }), 'errori')
  assert.equal(it('m.errors', { n: 3 }), 'errori')
  assert.equal(it('m.runs', { n: 1 }), 'esecuzione')
  assert.equal(it('m.inv', { n: 2 }), 'invocazioni')
  assert.equal(en('m.errors', { n: 1 }), 'error')
  assert.equal(en('m.errors', { n: 2 }), 'errors')
  // Vale anche nelle FRASI, non solo nelle etichette: "3 allarme/i attivo/i" era la scorciatoia
  // scritta prima che l'interpolazione plurale esistesse, e si leggeva in chat a ogni allarme.
  assert.equal(it('alarms.firing', { n: 1, list: 'x' }), '1 allarme attivo: x')
  assert.equal(it('alarms.firing', { n: 3, list: 'x, y, z' }), '3 allarmi attivi: x, y, z')
  assert.equal(en('alarms.firing', { n: 1, list: 'x' }), '1 alarm firing: x')
})

test('makeT: senza il conteggio la forma plurale non lascia in giro i segnaposto', () => {
  const it = makeT('it')
  assert.ok(!it('m.errors').includes('#'), `etichetta grezza: ${it('m.errors')}`)
})
