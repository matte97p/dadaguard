import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSignals, countByLevel, inWindow } from '../web/nowSignals.js'

const NOW = Date.parse('2026-08-08T12:00:00Z')
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString()
// `t` finto: ritorna la chiave, così i test verificano QUALE frase esce, non la traduzione.
const t = (k) => k

test('inWindow: dentro, fuori, e senza data (che si TIENE)', () => {
  const opts = { now: NOW, hours: 24 }
  assert.equal(inWindow(hoursAgo(2), opts), true)
  assert.equal(inWindow(hoursAgo(30), opts), false)
  // un fatto senza data non si nasconde: non sapere QUANDO non è non sapere SE
  assert.equal(inWindow(null, opts), true)
})

test('un servizio giù è crit, uno degradato warn, uno sano non compare', () => {
  const services = [
    { name: 'backend', overall: 'down', cause: 'runtime', checks: { runtime: { summary: '0/2 task' } }, account: { key: 'prod', label: 'Production' } },
    { name: 'worker', overall: 'degraded', cause: 'secrets', checks: { secrets: { summary: '1 secret mancante' } }, account: { key: 'stg', label: 'Staging' } },
    { name: 'web', overall: 'up', account: { key: 'prod', label: 'Production' } },
  ]
  const out = buildSignals({ services, now: NOW, t })
  assert.equal(out.length, 2)
  assert.equal(out[0].level, 'crit')
  assert.equal(out[0].title, 'backend')
  assert.match(out[0].detail, /cause.runtime — 0\/2 task/)
  assert.equal(out[0].to, '/servizi')
  assert.equal(out[1].level, 'warn')
})

test('deploy: si tengono falliti, in corso e azioni a mano; i rilasci auto riusciti NO', () => {
  const deploys = {
    stg: {
      label: 'Staging',
      builds: [
        { id: 'b1', service: 'backend', status: 'SUCCEEDED', trigger: 'auto', startedAt: hoursAgo(1) },
        { id: 'b2', service: 'backend', status: 'FAILED', trigger: 'auto', failPhase: 'BUILD', failReason: 'exit 1', startedAt: hoursAgo(2) },
        { id: 'b3', service: 'chat', status: 'IN_PROGRESS', inProgress: true, trigger: 'auto', startedAt: hoursAgo(0.1) },
        { id: 'b4', service: 'web', status: 'SUCCEEDED', trigger: 'hotfix', forcedBy: 'matte97p', startedAt: hoursAgo(3) },
        { id: 'b5', service: 'api', status: 'SUCCEEDED', kind: 'restart', trigger: 'restart', forcedBy: 'mmatteo23', startedAt: hoursAgo(4) },
      ],
    },
  }
  const out = buildSignals({ deploys, now: NOW, t })
  const ids = out.map((s) => s.id)
  assert.ok(!ids.includes('dep:b1'), 'un rilascio automatico riuscito non è una notizia')
  assert.equal(out.find((s) => s.id === 'dep:b2').level, 'bad')
  assert.equal(out.find((s) => s.id === 'dep:b3').level, 'info')
  assert.equal(out.find((s) => s.id === 'dep:b4').level, 'warn') // hotfix: fuori dalla CI
  assert.equal(out.find((s) => s.id === 'dep:b5').level, 'info') // riavvio riuscito: da sapere
  assert.equal(out.find((s) => s.id === 'dep:b4').to, '/deploy?service=web')
})

test('un riavvio RESPINTO non si racconta come una build fallita', () => {
  const deploys = {
    prod: {
      label: 'Production',
      builds: [
        { id: 'r1', service: 'garanzia', kind: 'restart', trigger: 'restart', status: 'FAILED', forcedBy: 'mmatteo23', failReason: 'AccessDenied', startedAt: hoursAgo(1) },
      ],
    },
  }
  const [s] = buildSignals({ deploys, now: NOW, t })
  assert.equal(s.level, 'bad')
  assert.match(s.detail, /now\.restartDenied/)
  assert.doesNotMatch(s.detail, /deployFailed/)
})

test('deploy fuori finestra: escluso', () => {
  const deploys = { stg: { label: 'Staging', builds: [{ id: 'old', service: 'backend', status: 'FAILED', startedAt: hoursAgo(48) }] } }
  assert.equal(buildSignals({ deploys, now: NOW, hours: 24, t }).length, 0)
  assert.equal(buildSignals({ deploys, now: NOW, hours: 72, t }).length, 1)
})

test('WAF: una zona che ha fermato traffico; una pulita o in errore no', () => {
  const waf = {
    zones: [
      { zone: 'a.com', zoneId: 'z1', blocked: 1743, logged: 20000, rules: [{ blocking: true, paths: ['/api/v1/tenders'] }] },
      { zone: 'b.com', zoneId: 'z2', blocked: 0, logged: 12, rules: [] },
      { zone: 'c.com', zoneId: 'z3', error: 'scope mancante' },
    ],
  }
  const out = buildSignals({ waf, now: NOW, t })
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'waf')
  assert.equal(out[0].accountKey, 'cloudflare')
  assert.match(out[0].detail, /\/api\/v1\/tenders/)
})

test('budget: sforato e "sforerà" compaiono, quelli a posto no', () => {
  const budgets = {
    accounts: {
      mgmt: {
        label: 'Management',
        budgets: [
          { name: 'org', level: 'over', actualPct: 110 },
          { name: 'llms', level: 'willOver', forecastPct: 123 },
          { name: 'stg', level: 'warn', actualPct: 85 },
          { name: 'ok', level: 'ok', actualPct: 20 },
        ],
      },
    },
    anomalies: [],
  }
  const out = buildSignals({ budgets, now: NOW, t })
  assert.deepEqual(
    out.map((s) => [s.title, s.level]),
    [
      ['org', 'bad'],
      ['llms', 'warn'],
    ],
  )
})

test('anomalie: grosse warn, piccole info, già marcate come attese sempre info', () => {
  const budgets = {
    accounts: {},
    anomalies: [
      { id: 'big', service: 'Bedrock', impact: 412, impactPct: 229, start: hoursAgo(6) },
      { id: 'small', service: 'Lambda', impact: 8, impactPct: 449, start: hoursAgo(5) },
      { id: 'known', service: 'S3', impact: 900, impactPct: 300, feedback: 'YES', start: hoursAgo(4) },
    ],
  }
  const byId = Object.fromEntries(buildSignals({ budgets, now: NOW, t }).map((s) => [s.id, s.level]))
  assert.equal(byId['anom:big'], 'warn')
  assert.equal(byId['anom:small'], 'info')
  assert.equal(byId['anom:known'], 'info')
})

test('ordine: per gravità, e a pari gravità gli stati in corso prima degli eventi datati', () => {
  const services = [{ name: 'giù', overall: 'down', account: { key: 'p' } }]
  const deploys = {
    p: {
      builds: [
        { id: 'vecchia', service: 'x', status: 'FAILED', startedAt: hoursAgo(6) },
        { id: 'recente', service: 'y', status: 'FAILED', startedAt: hoursAgo(1) },
      ],
    },
  }
  const budgets = { accounts: { p: { budgets: [{ name: 'sforato', level: 'over' }] } }, anomalies: [] }
  const out = buildSignals({ services, deploys, budgets, now: NOW, t, nameOf: (s) => s.name })
  assert.equal(out[0].title, 'giù') // crit
  // poi i `bad`: il budget (stato, senza data) prima delle build, e fra le build la più recente
  assert.deepEqual(out.slice(1, 4).map((s) => s.title), ['sforato', 'y', 'x'])
})

test('countByLevel: conta solo i livelli noti', () => {
  const n = countByLevel([{ level: 'crit' }, { level: 'warn' }, { level: 'warn' }, { level: 'boh' }])
  assert.deepEqual(n, { crit: 1, bad: 0, warn: 2, info: 0 })
})

test('nessuna fonte: nessun segnale, e non esplode', () => {
  assert.deepEqual(buildSignals(), [])
  assert.deepEqual(buildSignals({ services: null, deploys: null, waf: null, budgets: null }), [])
})
