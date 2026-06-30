import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeHealth } from '../server/selfcheck.js'

test('summarizeHealth: tutti ok → up', () => {
  assert.deepEqual(summarizeHealth([{ ok: true }, { ok: true }]), { allOk: true, anyFail: false, status: 'up' })
})

test('summarizeHealth: almeno uno ko → down', () => {
  const s = summarizeHealth([{ ok: true }, { ok: false }])
  assert.equal(s.status, 'down')
  assert.equal(s.anyFail, true)
})

test('summarizeHealth: nessun account → unknown', () => {
  assert.equal(summarizeHealth([]).status, 'unknown')
})
