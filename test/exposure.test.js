import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyExposure, probeExposure, publicUrlFromHeaders } from '../server/exposure.js'

test('classifyExposure: redirect verso cloudflareaccess.com → protetta (up)', () => {
  const r = classifyExposure({ status: 302, location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' })
  assert.equal(r.status, 'up')
})

test('classifyExposure: redirect /cdn-cgi/access sullo stesso host → protetta (up)', () => {
  const r = classifyExposure({ status: 302, location: 'https://dadaguard.example.com/cdn-cgi/access/login' })
  assert.equal(r.status, 'up')
})

test('classifyExposure: 200 secco → ESPOSTA (down)', () => {
  assert.equal(classifyExposure({ status: 200 }).status, 'down')
})

test('classifyExposure: redirect verso altro (non-Access) → unknown', () => {
  assert.equal(classifyExposure({ status: 302, location: 'https://example.com/altrove' }).status, 'unknown')
})

test('classifyExposure: errore di rete o 5xx → unknown', () => {
  assert.equal(classifyExposure({ error: 'ECONNREFUSED' }).status, 'unknown')
  assert.equal(classifyExposure({ status: 503 }).status, 'unknown')
})

test('probeExposure: senza URL pubblico → null (segnale non applicabile)', async () => {
  assert.equal(await probeExposure(null), null)
  assert.equal(await probeExposure(''), null)
})

test('probeExposure: usa il fetch iniettato e classifica il 302 come protetta', async () => {
  const fakeFetch = async () => ({ status: 302, headers: { get: (h) => (h === 'location' ? 'https://t.cloudflareaccess.com/login' : null) } })
  const r = await probeExposure('https://dadaguard.example.com', (k) => k, { fetchImpl: fakeFetch })
  assert.equal(r.status, 'up')
})

test('probeExposure: 200 dal fetch iniettato → esposta', async () => {
  const fakeFetch = async () => ({ status: 200, headers: { get: () => null } })
  const r = await probeExposure('https://dadaguard.example.com', (k) => k, { fetchImpl: fakeFetch })
  assert.equal(r.status, 'down')
})

test('probeExposure: URL malformato → unknown, non lancia', async () => {
  const r = await probeExposure('non-un-url', (k) => k)
  assert.equal(r.status, 'unknown')
})

test('publicUrlFromHeaders: ricava da x-forwarded-host + proto (zero-config)', () => {
  assert.equal(
    publicUrlFromHeaders({ 'x-forwarded-host': 'dadaguard.get-cato.com', 'x-forwarded-proto': 'https' }),
    'https://dadaguard.get-cato.com',
  )
})

test('publicUrlFromHeaders: ripiega su host, default https', () => {
  assert.equal(publicUrlFromHeaders({ host: 'dadaguard.example.com' }), 'https://dadaguard.example.com')
})

test('publicUrlFromHeaders: override (config/env) vince sempre', () => {
  assert.equal(publicUrlFromHeaders({ host: 'x' }, 'https://forced.example.com'), 'https://forced.example.com')
})

test('publicUrlFromHeaders: prende il primo host in liste separate da virgola', () => {
  assert.equal(
    publicUrlFromHeaders({ 'x-forwarded-host': 'a.example.com, b.example.com', 'x-forwarded-proto': 'https, http' }),
    'https://a.example.com',
  )
})

test('publicUrlFromHeaders: senza header né override → null', () => {
  assert.equal(publicUrlFromHeaders({}), null)
})
