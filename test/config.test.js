import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../server/config.js'

test('validateConfig: doc valido passa', () => {
  const r = validateConfig({ accounts: { staging: {} }, services: [{ name: 'a' }] })
  assert.equal(r.services.length, 1)
})

test('validateConfig: doc vuoto = config minimale ok', () => {
  assert.deepEqual(validateConfig({}), { accounts: {}, services: [] })
})

test('validateConfig: accounts come array → errore', () => {
  assert.throws(() => validateConfig({ accounts: [] }), /accounts/)
})

test('validateConfig: services non lista → errore', () => {
  assert.throws(() => validateConfig({ services: {} }), /services/)
})

test('validateConfig: service senza name → errore', () => {
  assert.throws(() => validateConfig({ services: [{ foo: 1 }] }), /name/)
})
