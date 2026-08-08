import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBlockingAction, ruleSourceKind, summarizeFirewall } from '../server/waf.js'

test('isBlockingAction: ferma vs lascia passare, in tutte le grafie di Cloudflare', () => {
  for (const a of ['block', 'drop', 'challenge', 'managed_challenge', 'managedChallenge', 'js_challenge', 'JSChallenge']) {
    assert.equal(isBlockingAction(a), true, `${a} dovrebbe fermare`)
  }
  // `log` osserva e lascia passare: contarla fra le fermate farebbe sembrare un disastro un niente
  for (const a of ['log', 'allow', 'skip', '', null, undefined]) {
    assert.equal(isBlockingAction(a), false, `${a} non ferma`)
  }
})

test('ruleSourceKind: dice DOVE si aggiusta la regola', () => {
  assert.equal(ruleSourceKind('firewallCustom'), 'custom')
  assert.equal(ruleSourceKind('waf'), 'managed')
  assert.equal(ruleSourceKind('firewallManaged'), 'managed')
  assert.equal(ruleSourceKind('ratelimit'), 'ratelimit')
  assert.equal(ruleSourceKind('botManagement'), 'bot')
  assert.equal(ruleSourceKind('securityLevel'), 'securitylevel')
  assert.equal(ruleSourceKind('qualcosaltro'), 'other')
  assert.equal(ruleSourceKind(null), 'other')
})

const node = (action, source, ruleId, count, host, path) => ({
  count,
  dimensions: { action, source, ruleId, clientRequestHTTPHost: host, clientRequestPath: path },
})

test('summarizeFirewall: fermate e osservate sono due totali SEPARATI', () => {
  const out = summarizeFirewall([
    node('block', 'firewallCustom', 'r1', 1000, 'app.example.com', '/api/v1/tenders'),
    node('log', 'waf', 'r2', 50_000, 'app.example.com', '/'),
    node('managed_challenge', 'ratelimit', 'r3', 40, 'app.example.com', '/api/v1/search'),
  ])
  assert.equal(out.blocked, 1040) // block + managed_challenge
  assert.equal(out.logged, 50_000) // NON sommato: quelle richieste sono passate
  assert.equal(out.hosts[0].count, 1040) // per host si contano solo le fermate
})

test('summarizeFirewall: prima le regole che fermano, poi per volume', () => {
  const out = summarizeFirewall([
    node('log', 'waf', 'rumorosa', 999_999, 'a.example.com', '/'),
    node('block', 'firewallCustom', 'piccola-ma-morde', 12, 'a.example.com', '/checkout'),
  ])
  assert.equal(out.rules[0].ruleId, 'piccola-ma-morde')
  assert.equal(out.rules[0].blocking, true)
  assert.equal(out.rules[1].blocking, false)
})

test('summarizeFirewall: stessa regola su più percorsi = una riga, percorsi raccolti', () => {
  const out = summarizeFirewall([
    node('block', 'firewallCustom', 'r1', 10, 'app.example.com', '/api/v1/tenders'),
    node('block', 'firewallCustom', 'r1', 5, 'app.example.com', '/api/v1/tenders/draft'),
  ])
  assert.equal(out.rules.length, 1)
  assert.equal(out.rules[0].count, 15)
  assert.deepEqual(out.rules[0].paths, ['/api/v1/tenders', '/api/v1/tenders/draft'])
})

test('summarizeFirewall: query minima (senza host/percorso) non rompe niente', () => {
  const out = summarizeFirewall([{ count: 7, dimensions: { action: 'block', source: 'waf', ruleId: 'r9' } }])
  assert.equal(out.blocked, 7)
  assert.deepEqual(out.rules[0].paths, [])
  assert.deepEqual(out.hosts, [])
})

test('summarizeFirewall: nessun evento → tutti zero, niente errori', () => {
  const out = summarizeFirewall([])
  assert.deepEqual({ blocked: out.blocked, logged: out.logged, rules: out.rules, hosts: out.hosts }, { blocked: 0, logged: 0, rules: [], hosts: [] })
  assert.equal(summarizeFirewall().blocked, 0)
})
