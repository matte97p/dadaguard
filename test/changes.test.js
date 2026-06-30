import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resourceName } from '../server/changes.js'

test('resourceName: per tipo prende l’identificatore giusto', () => {
  assert.equal(resourceName({ aws: { type: 'lambda', function: 'fn' } }), 'fn')
  assert.equal(resourceName({ aws: { type: 'ecs', cluster: 'c', service: 'web' } }), 'web')
  assert.equal(resourceName({ aws: { type: 'rds', cluster: 'db' } }), 'db')
  assert.equal(resourceName({ aws: { type: 'rds', instance: 'i1' } }), 'i1')
  assert.equal(resourceName({ aws: { type: 's3', bucket: 'b' } }), 'b')
})

test('resourceName: arn → ultimo segmento (sns/sfn)', () => {
  assert.equal(resourceName({ aws: { type: 'sns', arn: 'arn:aws:sns:eu-west-1:111:my-topic' } }), 'my-topic')
})

test('resourceName: identificatore o tipo mancante → null', () => {
  assert.equal(resourceName({ aws: { type: 'lambda' } }), null)
  assert.equal(resourceName({ aws: { type: 'boh', x: 1 } }), null)
  assert.equal(resourceName({}), null)
})
