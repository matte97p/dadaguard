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

test('serviceSecretSlugs: spoglia anche il gruppo cron nel nome risorsa (cato-<env>-cron-<job>)', () => {
  // Nome risorsa REALE dei cron Cato: il gruppo `cron` è DENTRO il nome, ma in SSM è un path segment.
  assert.deepEqual(serviceSecretSlugs({ name: 'cato-production-cron-ai-credit-monitor' }, 'production'), [
    'ai-credit-monitor',
    'cron-ai-credit-monitor',
    'production-cron-ai-credit-monitor',
    'cato-production-cron-ai-credit-monitor',
  ])
})

test('end-to-end: i cron discoverati come cato-<env>-cron-<job> matchano il job annidato in SSM', () => {
  // Struttura SSM reale (cron annidati) + nomi risorsa reali (gruppo cron nel nome).
  const idx = indexComponents([
    'cron/follow-competitor/A',
    'cron/follow-competitor/B',
    'cron/ai-credit-monitor/X',
    'backend/K1',
  ])
  const match = (name) => {
    const hit = serviceSecretSlugs({ name }, 'production').find((s) => idx[s] > 0)
    return hit ? `${hit}:${idx[hit]}` : null
  }
  assert.equal(match('prod-follow-competitor'), 'follow-competitor:2') // naming legacy
  assert.equal(match('cato-production-cron-ai-credit-monitor'), 'ai-credit-monitor:1') // naming standard
  assert.equal(match('cato-production-backend'), 'backend:1')
  assert.equal(match('cato-production-webhook'), null) // runner CI: nessun secret proprio
})
