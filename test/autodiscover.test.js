import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidatesToServices } from '../server/discover.js'

test('candidatesToServices: mappa candidati → voci servizio con account', () => {
  const candidates = [
    { name: 'worker', kind: 'lambda', aws: { type: 'lambda', function: 'worker', windowMinutes: 60 } },
    { name: 'web', kind: 'ecs', aws: { type: 'ecs', cluster: 'c', service: 'web' }, managed: true },
  ]
  const out = candidatesToServices(candidates, 'staging')
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], {
    name: 'worker',
    account: 'staging',
    aws: { type: 'lambda', function: 'worker', windowMinutes: 60 },
  })
  // managed propagato solo quando presente
  assert.equal(out[1].managed, true)
  assert.equal('managed' in out[0], false)
})

test('candidatesToServices: input vuoto/nullo → lista vuota', () => {
  assert.deepEqual(candidatesToServices(undefined, 'x'), [])
  assert.deepEqual(candidatesToServices([], 'x'), [])
})
