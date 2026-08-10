import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidatesToServices } from '../server/discover.js'
import { elasticacheStatus } from '../server/runtime/elasticache.js'

test('elasticacheStatus: available è su, la cancellazione è giù, il resto è degradato', () => {
  assert.equal(elasticacheStatus('available'), 'up')
  assert.equal(elasticacheStatus('deleting'), 'down')
  assert.equal(elasticacheStatus('incompatible-network'), 'down')
  assert.equal(elasticacheStatus('restore-failed'), 'down')
  // Uno stato trascorrente non è un guasto: modifying/creating stanno andando da qualche parte.
  assert.equal(elasticacheStatus('modifying'), 'degraded')
  assert.equal(elasticacheStatus('creating'), 'degraded')
  // Uno stato che AWS non ha ancora inventato non deve leggersi come "tutto bene".
  assert.equal(elasticacheStatus(undefined), 'degraded')
})

test('candidatesToServices: un load balancer porta ARN e nome, e prende la region del sweep', () => {
  const out = candidatesToServices(
    [{ name: 'acme-alb', kind: 'alb', aws: { type: 'alb', arn: 'arn:aws:elasticloadbalancing:::lb/app/acme', name: 'acme-alb', lbType: 'application' } }],
    'production',
    'eu-central-1',
  )
  assert.equal(out[0].account, 'production')
  assert.equal(out[0].aws.region, 'eu-central-1')
  // L'ARN è ciò che il provider usa: senza, ogni check farebbe una lettura in più per risolvere il nome.
  assert.equal(out[0].aws.arn, 'arn:aws:elasticloadbalancing:::lb/app/acme')
  assert.equal(out[0].aws.lbType, 'application')
})

test('candidatesToServices: una cache a replication group NON diventa una voce per nodo', () => {
  // Un Redis a due nodi si chiama `<gruppo>-001` e `<gruppo>-002`: la voce deve essere il gruppo,
  // altrimenti la flotta mostra due servizi di cui nessuno è il Redis.
  const out = candidatesToServices(
    [{ name: 'acme-redis', kind: 'elasticache', aws: { type: 'elasticache', replicationGroup: 'acme-redis' } }],
    'production',
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'acme-redis')
  assert.equal(out[0].aws.replicationGroup, 'acme-redis')
  assert.equal(out[0].aws.cluster, undefined)
})
