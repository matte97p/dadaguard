import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregate } from '../server/runtime/cw.js'

test('aggregate: Sum / Average / Maximum / Minimum', () => {
  assert.equal(aggregate([1, 2, 3], 'Sum'), 6)
  assert.equal(aggregate([2, 4], 'Average'), 3)
  assert.equal(aggregate([5, 1, 9], 'Maximum'), 9)
  assert.equal(aggregate([5, 1, 9], 'Minimum'), 1)
})

test('aggregate: percentili → max dei punti; vuoto/undefined → 0', () => {
  assert.equal(aggregate([100, 250, 180], 'p95'), 250) // la coda peggiore della finestra
  assert.equal(aggregate([], 'Sum'), 0)
  assert.equal(aggregate(undefined, 'Average'), 0)
})
