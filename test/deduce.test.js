import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchEnvTargets, matchByArn, extractArns, collectResourceArns } from '../server/topology/deduce.js'

const idList = [
  { name: 'webhook-stg', account: 'staging', ids: ['acme-staging-webhook'] },
  { name: 'webhook-prod', account: 'production', ids: ['acme-staging-webhook'] }, // stesso token, account diverso
  { name: 'db-prod', account: 'production', ids: ['reporting-prod-db.cluster-x.rds.amazonaws.com'] },
  { name: 'queue-stg', account: 'staging', ids: ['prod-queue'] },
]

test('collisione cross-account → resta solo lo stesso account', () => {
  const out = matchEnvTargets('WEBHOOK_FN=acme-staging-webhook', { name: 'dispatch', account: 'staging' }, idList)
  assert.deepEqual(out.map((t) => t.name), ['webhook-stg']) // NON webhook-prod
})

test('token unico cross-account → dipendenza vera mantenuta', () => {
  const env = 'DATABASE_URL=postgres://u:p@reporting-prod-db.cluster-x.rds.amazonaws.com:5432/db'
  const out = matchEnvTargets(env, { name: 'syncer', account: 'staging' }, idList)
  assert.deepEqual(out.map((t) => t.name), ['db-prod'])
})

test('niente substring: "prod-queue" dentro "prod-queue-events" non matcha', () => {
  const out = matchEnvTargets('Q=prod-queue-events', { name: 'x', account: 'staging' }, idList)
  assert.deepEqual(out, [])
})

test('non matcha se stesso (token posseduto solo dal self)', () => {
  const out = matchEnvTargets(
    'SELF=reporting-prod-db.cluster-x.rds.amazonaws.com',
    { name: 'db-prod', account: 'production' },
    idList,
  )
  assert.deepEqual(out, []) // il self è escluso e nessun altro possiede quel token
})

test('extractArns: pesca gli ARN da una definizione Step Functions', () => {
  const def = JSON.stringify({
    States: {
      Pay: { Resource: 'arn:aws:lambda:eu-west-1:111:function:acme-staging-webhook', Next: 'Q' },
      Q: { Resource: 'arn:aws:sqs:eu-west-1:111:prod-queue' },
    },
  })
  const arns = extractArns(def)
  assert.deepEqual(arns, [
    'arn:aws:lambda:eu-west-1:111:function:acme-staging-webhook',
    'arn:aws:sqs:eu-west-1:111:prod-queue',
  ])
  assert.deepEqual(extractArns(''), [])
  assert.deepEqual(extractArns(undefined), [])
})

test('matchByArn: risolve un ARN al servizio, preferendo lo stesso account', () => {
  // "acme-staging-webhook" esiste in staging e production: da uno step SFN staging vince lo staging.
  const arn = 'arn:aws:lambda:eu-west-1:111:function:acme-staging-webhook'
  // Ritorna il CANDIDATO, non il nome: serve la sua chiave per non fondere due omonimi in un nodo.
  assert.equal(matchByArn(arn, idList, { name: 'orchestrator', account: 'staging' })?.name, 'webhook-stg')
  // ARN che non punta a nulla di tracciato → null
  assert.equal(matchByArn('arn:aws:s3:::qualche-bucket', idList, { name: 'x', account: 'staging' }), null)
})

test('collectResourceArns: pesca gli ARN Resource dai soli statement Allow', () => {
  const doc = {
    Statement: [
      { Effect: 'Allow', Action: 'rds-db:connect', Resource: 'arn:aws:rds:eu-west-1:111:cluster:reporting-prod-db' },
      { Effect: 'Allow', Action: ['sqs:SendMessage'], Resource: ['arn:aws:sqs:eu-west-1:111:prod-queue', '*'] },
      { Effect: 'Deny', Action: '*', Resource: 'arn:aws:s3:::segreto' }, // Deny → ignorato
    ],
  }
  assert.deepEqual(collectResourceArns(doc), [
    'arn:aws:rds:eu-west-1:111:cluster:reporting-prod-db',
    'arn:aws:sqs:eu-west-1:111:prod-queue',
  ])
  assert.deepEqual(collectResourceArns({}), [])
  // statement singolo (oggetto, non array)
  assert.deepEqual(
    collectResourceArns({ Statement: { Effect: 'Allow', Resource: 'arn:aws:sns:eu-west-1:111:topic' } }),
    ['arn:aws:sns:eu-west-1:111:topic'],
  )
})
