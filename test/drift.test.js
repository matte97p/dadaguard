import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPlan } from '../server/driftFull.js'

test('classifyPlan: nessun cambiamento = insync', () => {
  assert.equal(classifyPlan('done', 0, 'No changes. Your infrastructure matches the configuration.').kind, 'insync')
})

test('classifyPlan: solo add = pending (non drift)', () => {
  const r = classifyPlan('done', 2, 'Plan: 7 to add, 0 to change, 0 to destroy.')
  assert.equal(r.kind, 'pending')
  assert.deepEqual(r.counts, { add: 7, change: 0, destroy: 0 })
})

test('classifyPlan: change/destroy = drift vero', () => {
  assert.equal(classifyPlan('done', 2, 'Plan: 0 to add, 2 to change, 1 to destroy.').kind, 'drift')
})

test('classifyPlan: stato error = error', () => {
  assert.equal(classifyPlan('error', 1, '').kind, 'error')
})
