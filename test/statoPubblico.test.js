import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statoServizio, corrisponde, statoComponente, componentiDaConfig, statoPubblico } from '../server/statoPubblico.js'

// Nomi inventati: il repo è pubblico.
const svc = (name, account, checks) => ({
  name,
  account: { key: account, label: account.toUpperCase() },
  checks: Object.fromEntries(Object.entries(checks).map(([k, status]) => [k, { key: k, status, summary: `segreto ${k}` }])),
  links: { console: 'https://console.example.com/x' },
})

test('statoServizio: conta solo i segnali che un cliente sente', () => {
  assert.equal(statoServizio(svc('vetrina', 'prod', { liveness: 'up', runtime: 'up' })), 'operational')
  assert.equal(statoServizio(svc('vetrina', 'prod', { liveness: 'up', drift: 'down', version: 'degraded' })), 'operational')
  assert.equal(statoServizio(svc('vetrina', 'prod', { liveness: 'up', alarms: 'degraded' })), 'degraded')
  assert.equal(statoServizio(svc('vetrina', 'prod', { liveness: 'down', runtime: 'up' })), 'outage')
  assert.equal(statoServizio(svc('vetrina', 'prod', { runtime: 'idle' })), 'operational')
})

test('statoServizio: senza segnali pubblici è unknown, non verde', () => {
  assert.equal(statoServizio(svc('vetrina', 'prod', { drift: 'up', secrets: 'up' })), 'unknown')
  assert.equal(statoServizio({}), 'unknown')
  assert.equal(statoServizio(svc('vetrina', 'prod', { liveness: 'unknown' })), 'unknown')
})

test('corrisponde: nome secco o account/nome', () => {
  const s = svc('cassa', 'prod', {})
  assert.equal(corrisponde(s, 'cassa'), true)
  assert.equal(corrisponde(s, 'prod/cassa'), true)
  assert.equal(corrisponde(s, 'prova/cassa'), false)
  assert.equal(corrisponde(s, 'cass'), false)
})

test('statoComponente: il peggiore fra i servizi trovati', () => {
  const servizi = [
    svc('cassa', 'prod', { liveness: 'up' }),
    svc('magazzino', 'prod', { runtime: 'degraded' }),
    svc('cassa', 'prova', { liveness: 'down' }),
  ]
  assert.equal(statoComponente(servizi, ['prod/cassa']), 'operational')
  assert.equal(statoComponente(servizi, ['prod/cassa', 'prod/magazzino']), 'degraded')
  assert.equal(statoComponente(servizi, ['cassa']), 'outage') // il nome secco prende anche l'altro account
  assert.equal(statoComponente(servizi, ['prod/inesistente']), 'unknown')
})

test('statoComponente: uno sconosciuto non spegne il verde di un sano', () => {
  const servizi = [svc('cassa', 'prod', { liveness: 'up' }), svc('coda', 'prod', { drift: 'up' })]
  assert.equal(statoComponente(servizi, ['prod/cassa', 'prod/coda']), 'operational')
})

test('componentiDaConfig: scarta id non validi e liste vuote', () => {
  const { componenti, scartati } = componentiDaConfig({
    web: ['prod/cassa'],
    'Con Spazi': ['prod/cassa'],
    vuoto: [],
    numeri: [1, 2],
    api: ['prod/cassa', '', 'prod/magazzino'],
  })
  assert.deepEqual(componenti, [
    { id: 'web', riferimenti: ['prod/cassa'] },
    { id: 'api', riferimenti: ['prod/cassa', 'prod/magazzino'] },
  ])
  assert.deepEqual(scartati, ['Con Spazi', 'vuoto', 'numeri'])
  assert.deepEqual(componentiDaConfig(null), { componenti: [], scartati: [] })
  assert.deepEqual(componentiDaConfig(['web']), { componenti: [], scartati: [] })
})

test('statoPubblico: null senza componenti, così la rotta risponde 404', () => {
  assert.equal(statoPubblico({ services: [] }, null), null)
  assert.equal(statoPubblico({ services: [] }, {}), null)
})

test('statoPubblico: escono solo id e stato, nessun dato interno', () => {
  const status = {
    generatedAt: '2026-01-02T03:04:05.000Z',
    accounts: [{ key: 'prod', id: '111122223333' }],
    services: [svc('cassa', 'prod', { liveness: 'up', alarms: 'degraded' }), svc('magazzino', 'prod', { liveness: 'up' })],
  }
  const out = statoPubblico(status, { web: ['prod/cassa'], api: ['prod/magazzino'] })
  assert.deepEqual(out, {
    generatedAt: '2026-01-02T03:04:05.000Z',
    components: [
      { id: 'web', state: 'degraded' },
      { id: 'api', state: 'operational' },
    ],
  })
  const testo = JSON.stringify(out)
  for (const interno of ['cassa', 'magazzino', 'prod', '111122223333', 'segreto', 'console', 'alarms']) {
    assert.equal(testo.includes(interno), false, `«${interno}» non deve uscire`)
  }
})
