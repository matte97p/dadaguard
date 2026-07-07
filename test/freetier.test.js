import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeFreeTier } from '../server/freetier.js'

test('summarizeFreeTier: calcola pct e ordina per pct desc', () => {
  const out = summarizeFreeTier([
    { service: 'AWS Lambda', usageType: 'Global-Request', actualUsageAmount: 10, limit: 1000000, unit: 'Requests' },
    { service: 'AWS CodeBuild', usageType: 'Build-Min:g1.small', actualUsageAmount: 131, forecastedUsageAmount: 190, limit: 100, unit: 'Minutes' },
  ])
  assert.equal(out.length, 2)
  // CodeBuild oltre il 100% deve stare in cima
  assert.equal(out[0].service, 'AWS CodeBuild')
  assert.equal(out[0].pct, 131)
  assert.equal(out[0].forecast, 190)
  assert.equal(out[1].pct, 0) // 10/1e6 arrotonda a 0
})

test('summarizeFreeTier: limit mancante/0 → pct 0 (niente divisione per zero)', () => {
  const out = summarizeFreeTier([{ service: 'X', actualUsageAmount: 5, limit: 0 }])
  assert.equal(out[0].pct, 0)
  assert.equal(out[0].used, 5)
})

test('summarizeFreeTier: input vuoto → []', () => {
  assert.deepEqual(summarizeFreeTier(), [])
  assert.deepEqual(summarizeFreeTier([]), [])
})
