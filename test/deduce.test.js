import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchEnvTargets } from '../server/topology/deduce.js'

const idList = [
  { name: 'webhook-stg', account: 'staging', ids: ['cato-staging-webhook'] },
  { name: 'webhook-prod', account: 'production', ids: ['cato-staging-webhook'] }, // stesso token, account diverso
  { name: 'db-prod', account: 'production', ids: ['avvista-prod-db.cluster-x.rds.amazonaws.com'] },
  { name: 'queue-stg', account: 'staging', ids: ['prod-queue'] },
]

test('collisione cross-account → resta solo lo stesso account', () => {
  const out = matchEnvTargets('WEBHOOK_FN=cato-staging-webhook', { name: 'dispatch', account: 'staging' }, idList)
  assert.deepEqual(out.map((t) => t.name), ['webhook-stg']) // NON webhook-prod
})

test('token unico cross-account → dipendenza vera mantenuta', () => {
  const env = 'DATABASE_URL=postgres://u:p@avvista-prod-db.cluster-x.rds.amazonaws.com:5432/db'
  const out = matchEnvTargets(env, { name: 'syncer', account: 'staging' }, idList)
  assert.deepEqual(out.map((t) => t.name), ['db-prod'])
})

test('niente substring: "prod-queue" dentro "prod-queue-events" non matcha', () => {
  const out = matchEnvTargets('Q=prod-queue-events', { name: 'x', account: 'staging' }, idList)
  assert.deepEqual(out, [])
})

test('non matcha se stesso (token posseduto solo dal self)', () => {
  const out = matchEnvTargets(
    'SELF=avvista-prod-db.cluster-x.rds.amazonaws.com',
    { name: 'db-prod', account: 'production' },
    idList,
  )
  assert.deepEqual(out, []) // il self è escluso e nessun altro possiede quel token
})
