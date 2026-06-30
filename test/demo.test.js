import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demoStatus, demoCosts, demoQuotas, demoLogs, demoEvents } from '../server/demo.js'

test('demoStatus: forma valida + ogni check ha uno status', () => {
  const s = demoStatus('it')
  assert.equal(s.mode, 'demo')
  assert.equal(s.capabilities.watchlist, false)
  assert.ok(s.services.length >= 8)
  for (const svc of s.services) {
    assert.ok(svc.name && svc.account?.key && svc.overall, `servizio incompleto: ${svc.name}`)
    assert.ok(Object.keys(svc.checks).length > 0)
    for (const c of Object.values(svc.checks)) assert.ok(c.status, `check senza status in ${svc.name}`)
  }
})

test('demoStatus: copre tutti gli stati chiave (up/degraded/down/disabled)', () => {
  const states = new Set(demoStatus('en').services.map((x) => x.overall))
  for (const st of ['up', 'degraded', 'down', 'disabled']) {
    assert.ok(states.has(st), `la flotta demo non copre lo stato ${st}`)
  }
})

test('demoStatus: bilingue it/en', () => {
  const it = demoStatus('it').services.find((s) => s.name === 'nightly-report').checks.runtime.summary
  const en = demoStatus('en').services.find((s) => s.name === 'nightly-report').checks.runtime.summary
  assert.notEqual(it, en)
})

test('demo drawer: forme coerenti', () => {
  assert.ok(demoCosts().prod.items.length > 0)
  assert.ok(demoQuotas().accounts[0].quotas.length > 0)
  assert.ok(demoLogs().events.length > 0)
  assert.ok(demoEvents().events.length > 0)
})
