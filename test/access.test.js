import { test } from 'node:test'
import assert from 'node:assert/strict'
import { principalArnForSimulation, aggregateSurfaces } from '../server/access.js'

test('principalArnForSimulation: assumed-role → ARN del ruolo', () => {
  assert.equal(
    principalArnForSimulation('arn:aws:sts::111122223333:assumed-role/dadaguard-readonly/dadaguard'),
    'arn:aws:iam::111122223333:role/dadaguard-readonly',
  )
})

test('principalArnForSimulation: utente/ruolo IAM → invariato (già valido come sorgente)', () => {
  assert.equal(principalArnForSimulation('arn:aws:iam::111122223333:user/matteo'), 'arn:aws:iam::111122223333:user/matteo')
  assert.equal(principalArnForSimulation('arn:aws:iam::111122223333:role/ops'), 'arn:aws:iam::111122223333:role/ops')
})

test('principalArnForSimulation: root / federated / vuoto → null (non simulabile)', () => {
  assert.equal(principalArnForSimulation('arn:aws:iam::111122223333:root'), null)
  assert.equal(principalArnForSimulation('arn:aws:sts::111122223333:federated-user/bob'), null)
  assert.equal(principalArnForSimulation(''), null)
  assert.equal(principalArnForSimulation(null), null)
})

const A = { costs: ['ce:GetCostAndUsage'], iam: ['iam:ListPolicies'] }

test('aggregateSurfaces: basta un account che consente → allowed', () => {
  const out = aggregateSurfaces([new Set(['ce:GetCostAndUsage']), new Set()], A)
  assert.equal(out.costs, 'allowed')
})

test('aggregateSurfaces: simulato ovunque ma negato ovunque → denied', () => {
  const out = aggregateSurfaces([new Set(['iam:ListPolicies']), new Set(['iam:ListPolicies'])], A)
  assert.equal(out.costs, 'denied') // nessuno ha ce:GetCostAndUsage
  assert.equal(out.iam, 'allowed')
})

test('aggregateSurfaces: account null (non simulabile) non conta come deny', () => {
  const out = aggregateSurfaces([null, new Set(['ce:GetCostAndUsage'])], A)
  assert.equal(out.costs, 'allowed')
})

test('aggregateSurfaces: tutti null → unknown (default sicuro: mostra)', () => {
  const out = aggregateSurfaces([null, null], A)
  assert.equal(out.costs, 'unknown')
  assert.equal(out.iam, 'unknown')
})

test('aggregateSurfaces: superficie composita → basta una delle azioni per accenderla', () => {
  const actions = { security: ['iam:ListPolicies', 'ec2:DescribeInstances', 's3:ListAllMyBuckets'] }
  assert.equal(aggregateSurfaces([new Set(['s3:ListAllMyBuckets'])], actions).security, 'allowed')
  assert.equal(aggregateSurfaces([new Set(['sts:GetCallerIdentity'])], actions).security, 'denied')
})
