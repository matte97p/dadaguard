import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseExpectedBody, resolveExpected } from '../server/checks/version.js'

test('parseExpectedBody: testo semplice → prima riga', () => {
  assert.equal(parseExpectedBody('v2.3.4\n', 'text/plain'), 'v2.3.4')
  assert.equal(parseExpectedBody('  1.0.0  ', ''), '1.0.0')
})

test('parseExpectedBody: JSON → campo (default version, o dotted)', () => {
  assert.equal(parseExpectedBody('{"version":"9.9.9"}', 'application/json'), '9.9.9')
  assert.equal(parseExpectedBody('{"app":{"tag":"v7"}}', 'application/json', 'app.tag'), 'v7')
})

test('parseExpectedBody: JSON rilevato anche senza content-type', () => {
  assert.equal(parseExpectedBody('{"version":"3.1"}', ''), '3.1')
})

test('parseExpectedBody: campo assente → null', () => {
  assert.equal(parseExpectedBody('{"x":1}', 'application/json', 'version'), null)
})

test('resolveExpected: senza URL usa il literal in config (source=config)', async () => {
  assert.deepEqual(await resolveExpected({ expectedVersion: 'v1.2.3' }), {
    value: 'v1.2.3',
    source: 'config',
    from: 'config',
  })
})

test('resolveExpected: niente atteso → null', async () => {
  assert.equal(await resolveExpected({}), null)
})
