import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseToml, wranglerTokenFrom } from '../server/cfToken.js'

test('parseToml: coppie di primo livello, ignora sezioni/commenti', () => {
  const out = parseToml(`
# commento
oauth_token = "abc123"
expiration_time = "2030-01-01T00:00:00Z"
[extra]
nested = "x"
`)
  assert.equal(out.oauth_token, 'abc123')
  assert.equal(out.expiration_time, '2030-01-01T00:00:00Z')
  assert.equal(out.nested, 'x') // parser piatto: prende anche le chiavi sotto sezione (ok per il file wrangler)
})

test('wranglerTokenFrom: valido se non scaduto', () => {
  const now = new Date('2026-01-01T00:00:00Z').getTime()
  assert.equal(wranglerTokenFrom({ oauth_token: 't', expiration_time: '2026-06-01T00:00:00Z' }, now), 't')
})

test('wranglerTokenFrom: scaduto → null', () => {
  const now = new Date('2026-06-02T00:00:00Z').getTime()
  assert.equal(wranglerTokenFrom({ oauth_token: 't', expiration_time: '2026-06-01T00:00:00Z' }, now), null)
})

test('wranglerTokenFrom: senza token → null; senza scadenza → valido', () => {
  assert.equal(wranglerTokenFrom({}), null)
  assert.equal(wranglerTokenFrom({ oauth_token: 't' }), 't')
})
