import { test } from 'node:test'
import assert from 'node:assert/strict'
import { candidatesToServices } from '../server/discover.js'
import { mergeServices, serviceKey } from '../server/autodiscover.js'

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

test('candidatesToServices: la description (dalla risorsa) è propagata quando presente', () => {
  const candidates = [
    { name: 'webhook', kind: 'lambda', aws: { type: 'lambda', function: 'webhook' }, description: 'riceve gli eventi GitHub' },
    { name: 'plain', kind: 'lambda', aws: { type: 'lambda', function: 'plain' } },
  ]
  const out = candidatesToServices(candidates, 'staging')
  assert.equal(out[0].description, 'riceve gli eventi GitHub')
  assert.equal('description' in out[1], false) // assente se la risorsa non ne ha
})

test('candidatesToServices: input vuoto/nullo → lista vuota', () => {
  assert.deepEqual(candidatesToServices(undefined, 'x'), [])
  assert.deepEqual(candidatesToServices([], 'x'), [])
})

test('candidatesToServices: region iniettata in aws.region (sweep #8)', () => {
  const c = [{ name: 'fn', kind: 'lambda', aws: { type: 'lambda', function: 'fn' } }]
  assert.equal(candidatesToServices(c, 'prod', 'us-east-1')[0].aws.region, 'us-east-1')
  // senza region: aws invariato
  assert.equal('region' in candidatesToServices(c, 'prod')[0].aws, false)
})

test('mergeServices: i dichiarati vincono, gli scoperti duplicati sono scartati', () => {
  const declared = [
    { name: 'webhook', account: 'staging', aws: { type: 'lambda', function: 'cato-staging-webhook' }, expectedVersion: 'v2' },
  ]
  const discovered = [
    // stessa risorsa del dichiarato (nome diverso) → NON aggiunto
    { name: 'cato-staging-webhook', account: 'staging', aws: { type: 'lambda', function: 'cato-staging-webhook' } },
    // risorsa nuova → aggiunta
    { name: 'orders', account: 'staging', aws: { type: 'ecs', cluster: 'c', service: 'orders' } },
  ]
  const out = mergeServices(declared, discovered)
  assert.equal(out.length, 2)
  assert.equal(out[0].name, 'webhook') // dichiarato preservato…
  assert.equal(out[0].expectedVersion, 'v2') // …con i suoi override
  assert.equal(out[1].name, 'orders') // scoperto nuovo aggiunto
})

test('serviceKey: stessa risorsa → stessa chiave a prescindere dal name; account/tipo distinguono', () => {
  const a = { name: 'x', account: 'prod', aws: { type: 'lambda', function: 'fn' } }
  const b = { name: 'y', account: 'prod', aws: { type: 'lambda', function: 'fn' } }
  assert.equal(serviceKey(a), serviceKey(b))
  const c = { name: 'x', account: 'staging', aws: { type: 'lambda', function: 'fn' } }
  assert.notEqual(serviceKey(a), serviceKey(c))
})
