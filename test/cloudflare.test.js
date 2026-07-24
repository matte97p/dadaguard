import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortId, triggerOfSource, normalizeDeployment, deploymentToBuild, summarizeAnalytics } from '../server/cloudflare.js'

test('shortId: accorcia oltre 8 char, lascia i corti', () => {
  assert.equal(shortId('a1b2c3d4e5f6'), 'a1b2c3d4')
  assert.equal(shortId('short'), 'short')
  assert.equal(shortId(null), null)
})

test('triggerOfSource: dash → manuale, resto → auto', () => {
  assert.equal(triggerOfSource('dash'), 'manuale')
  assert.equal(triggerOfSource('dashboard'), 'manuale')
  assert.equal(triggerOfSource('wrangler'), 'auto')
  assert.equal(triggerOfSource('api'), 'auto')
  assert.equal(triggerOfSource(''), 'auto')
})

test('normalizeDeployment: tollera forme diverse (top-level e metadata)', () => {
  const a = normalizeDeployment({ id: 'dep1', created_on: '2026-07-01T00:00:00Z', source: 'wrangler', author_email: 'a@b.c', versions: [{ version_id: 'v9' }] })
  assert.deepEqual(a, { id: 'dep1', createdOn: '2026-07-01T00:00:00Z', source: 'wrangler', author: 'a@b.c', versionId: 'v9' })
  const b = normalizeDeployment({ id: 'dep2', metadata: { created_on: '2026-07-02T00:00:00Z', source: 'dash', author_email: 'x@y.z' } })
  assert.equal(b.createdOn, '2026-07-02T00:00:00Z')
  assert.equal(b.source, 'dash')
  assert.equal(b.versionId, 'dep2') // fallback all'id quando non ci sono versions
})

test('deploymentToBuild: forma "build" con provider cloudflare, sempre SUCCEEDED', () => {
  const dep = { id: 'dep1', createdOn: '2026-07-01T00:00:00Z', source: 'wrangler', author: 'a@b.c', versionId: 'abcdef1234' }
  const out = deploymentToBuild(dep, 'website', 'acct123')
  assert.equal(out.provider, 'cloudflare')
  assert.equal(out.status, 'SUCCEEDED')
  assert.equal(out.service, 'website')
  assert.equal(out.commit, 'abcdef12')
  assert.equal(out.trigger, 'auto')
  assert.equal(out.author, 'a@b.c')
  assert.match(out.deployUrl, /dash\.cloudflare\.com\/acct123\/workers.*website/)
})

test('summarizeAnalytics: somma richieste/errori, %, spark orario', () => {
  const out = summarizeAnalytics([
    { sum: { requests: 100, errors: 2 } },
    { sum: { requests: 300, errors: 8 } },
  ])
  assert.equal(out.requests, 400)
  assert.equal(out.errors, 10)
  assert.equal(out.errorPct, 2.5)
  assert.deepEqual(out.spark, [100, 300])
  assert.equal(summarizeAnalytics([]).requests, 0)
  assert.equal(summarizeAnalytics([]).errorPct, 0)
})
