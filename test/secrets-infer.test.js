import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceSecretSlugs, countTopSegment } from '../server/secrets/ssmIndex.js'

test('serviceSecretSlugs: spoglia il prefisso d’ambiente, più spogliato prima', () => {
  assert.deepEqual(serviceSecretSlugs({ name: 'prod-follow-competitor' }, 'production'), [
    'follow-competitor',
    'prod-follow-competitor',
  ])
})

test('serviceSecretSlugs: spoglia fino a due segmenti (cato-<env>-<svc>)', () => {
  assert.deepEqual(serviceSecretSlugs({ name: 'cato-staging-backend' }, 'staging'), [
    'backend',
    'staging-backend',
    'cato-staging-backend',
  ])
})

test('serviceSecretSlugs: nessun prefisso d’ambiente → solo il nome', () => {
  assert.deepEqual(serviceSecretSlugs({ name: 'agentic-chat' }, 'production'), ['agentic-chat'])
})

test('serviceSecretSlugs: ripiega su aws.function/service e gestisce vuoto', () => {
  assert.deepEqual(serviceSecretSlugs({ aws: { function: 'prod-syncer' } }, 'production'), ['syncer', 'prod-syncer'])
  assert.deepEqual(serviceSecretSlugs({}, 'production'), [])
})

test('serviceSecretSlugs: non spoglia un token che NON è d’ambiente', () => {
  // 'billing' non è un token d'ambiente → resta parte dello slug
  assert.deepEqual(serviceSecretSlugs({ name: 'billing-worker' }, 'production'), ['billing-worker'])
})

test('countTopSegment: conta i parametri per componente di primo livello', () => {
  const names = ['backend/DB_URL', 'backend/API_KEY', 'follow-competitor/TOKEN', 'deploy/slack_webhook_url']
  assert.deepEqual(countTopSegment(names), { backend: 2, 'follow-competitor': 1, deploy: 1 })
})

test('countTopSegment: input vuoto/nullo → oggetto vuoto', () => {
  assert.deepEqual(countTopSegment(undefined), {})
  assert.deepEqual(countTopSegment([]), {})
})
