import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consoleUrl } from '../server/console.js'

test('lambda → deep-link funzione con region', () => {
  const u = consoleUrl({ aws: { type: 'lambda', function: 'my-fn', region: 'eu-west-1' } })
  assert.match(u, /eu-west-1\.console\.aws\.amazon\.com\/lambda\/home\?region=eu-west-1#\/functions\/my-fn/)
})

test('ecs → deep-link cluster/service', () => {
  const u = consoleUrl({ aws: { type: 'ecs', cluster: 'c1', service: 'web', region: 'us-east-1' } })
  assert.match(u, /\/ecs\/v2\/clusters\/c1\/services\/web\/health/)
})

test('region fallback su service.region', () => {
  const u = consoleUrl({ region: 'ap-south-1', aws: { type: 'lambda', function: 'f' } })
  assert.match(u, /ap-south-1/)
})

test('identificatori mancanti / tipo ignoto → null', () => {
  assert.equal(consoleUrl({ aws: { type: 'lambda' } }), null)
  assert.equal(consoleUrl({ aws: { type: 'qualcosa' } }), null)
  assert.equal(consoleUrl({}), null)
})

test('s3 e cloudfront usano host globali', () => {
  assert.match(consoleUrl({ aws: { type: 's3', bucket: 'b' } }), /s3\.console\.aws\.amazon\.com\/s3\/buckets\/b/)
  assert.match(consoleUrl({ aws: { type: 'cloudfront', id: 'E1' } }), /cloudfront\/v4\/home#\/distributions\/E1/)
})
