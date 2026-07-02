import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { makeT } from '../server/i18n.js'

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
  const missing = [...used].filter((k) => it(k) === k || en(k) === k).sort()
  assert.deepEqual(missing, [], `chiavi i18n usate ma assenti nel dizionario server: ${missing.join(', ')}`)
})
