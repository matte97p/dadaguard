import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeT } from '../server/i18n.js'

test('makeT: interpolazione it/en', () => {
  assert.equal(makeT('it')('lambda.calls', { n: 5 }), '5 chiamate')
  assert.equal(makeT('en')('lambda.calls', { n: 5 }), '5 calls')
})

test('makeT: lingua sconosciuta → fallback IT', () => {
  assert.equal(makeT('xx')('drift.insync'), 'combacia con Terraform')
})

test('makeT: chiave assente → ritorna la chiave', () => {
  assert.equal(makeT('it')('nope.nope'), 'nope.nope')
})
