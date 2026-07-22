import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceSecretSlugs, indexComponents } from '../server/secrets/ssmIndex.js'

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

test('indexComponents: app-service top-level + cron annidato (struttura Cato reale)', () => {
  // Nomi come li ritorna ssmSecrets (relativi a /cato/<env>), presi dalla struttura di produzione:
  const names = [
    'backend/ARIZE_API_KEY',
    'backend/MISTRAL_API_KEY',
    'agentic-chat/SUPABASE_URL',
    'cron/follow-competitor/SLACK_WEBHOOK_URL',
    'cron/follow-competitor/SUPABASE_URL',
    'cron/ai-credit-monitor/POSTHOG_API_KEY',
  ]
  const idx = indexComponents(names)
  assert.equal(idx.backend, 2)
  assert.equal(idx['agentic-chat'], 1)
  assert.equal(idx.cron, 3) // il gruppo top-level resta contato
  assert.equal(idx['follow-competitor'], 2) // …e il job annidato è indicizzato a sé → ora MATCHA
  assert.equal(idx['ai-credit-monitor'], 1)
  // la KEY di un app-service (2 segmenti) NON diventa un componente
  assert.equal('ARIZE_API_KEY' in idx, false)
})

test('indexComponents: input vuoto/nullo → oggetto vuoto', () => {
  assert.deepEqual(indexComponents(undefined), {})
  assert.deepEqual(indexComponents([]), {})
})

test('end-to-end: prod-follow-competitor (lambda cron) matcha il suo job annidato', () => {
  const idx = indexComponents(['cron/follow-competitor/A', 'cron/follow-competitor/B', 'backend/X'])
  // lo slug del servizio scoperto…
  const slugs = serviceSecretSlugs({ name: 'prod-follow-competitor' }, 'production')
  const hit = slugs.find((s) => idx[s] > 0)
  assert.equal(hit, 'follow-competitor')
  assert.equal(idx[hit], 2)
})
