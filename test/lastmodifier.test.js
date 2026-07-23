import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resourceIdentifier } from '../server/runtime/lastModifier.js'

test('resourceIdentifier: nome/id per tipo (per CloudTrail ResourceName)', () => {
  assert.equal(resourceIdentifier({ type: 'lambda', function: 'my-fn' }), 'my-fn')
  assert.equal(resourceIdentifier({ type: 'ecs', service: 'web' }), 'web')
  assert.equal(resourceIdentifier({ type: 'rds', cluster: 'db-1' }), 'db-1')
  assert.equal(resourceIdentifier({ type: 'sqs', queue: 'jobs' }), 'jobs')
  assert.equal(resourceIdentifier({ type: 'dynamodb', table: 'items' }), 'items')
  assert.equal(resourceIdentifier({ type: 's3', bucket: 'my-bucket' }), 'my-bucket')
  assert.equal(resourceIdentifier({ type: 'ec2', instanceId: 'i-0abc' }), 'i-0abc')
})

test('resourceIdentifier: ARN → ultimo segmento (sns/sfn/acm)', () => {
  assert.equal(resourceIdentifier({ type: 'sns', arn: 'arn:aws:sns:eu-central-1:123:my-topic' }), 'my-topic')
  assert.equal(
    resourceIdentifier({ type: 'sfn', arn: 'arn:aws:states:eu-central-1:123:stateMachine:my-sm' }),
    'my-sm',
  )
})

test('resourceIdentifier: tipi non mappabili → null', () => {
  assert.equal(resourceIdentifier({ type: 'ecs-scheduled', taskDefinition: 'x' }), null) // il chi = registeredBy
  assert.equal(resourceIdentifier({ type: 'bedrock', model: 'x' }), null)
  assert.equal(resourceIdentifier({ type: 'ses' }), null)
  assert.equal(resourceIdentifier(null), null)
  assert.equal(resourceIdentifier({}), null)
})
