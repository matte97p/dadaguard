import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeOverall, endpointFromHealth, urlForService } from '../server/status.js'
import * as alarms from '../server/checks/alarms.js'
const { isAutoscalingAlarm } = alarms

// --- Endpoint pubblico del servizio: origine dell'healthUrl (mostrato solo "dove possibile") ---

test('endpointFromHealth: origine dell’healthUrl (path/query scartati)', () => {
  assert.equal(endpointFromHealth('https://api.example.com/health'), 'https://api.example.com')
  assert.equal(endpointFromHealth('https://app.example.com:8443/api/health?x=1'), 'https://app.example.com:8443')
})

test('endpointFromHealth: assente o malformato → null (niente endpoint)', () => {
  assert.equal(endpointFromHealth(null), null)
  assert.equal(endpointFromHealth(undefined), null)
  assert.equal(endpointFromHealth('non-un-url'), null)
})

test('urlForService: `account/nome` vince su `nome`, poi fallback, poi null', () => {
  const urls = { backend: 'https://stg-api', 'production/backend': 'https://api' }
  assert.equal(urlForService(urls, 'production', 'backend'), 'https://api') // scoped vince
  assert.equal(urlForService(urls, 'staging', 'backend'), 'https://stg-api') // fallback al nome
  assert.equal(urlForService(urls, 'staging', 'frontend'), null) // non mappato
  assert.equal(urlForService(null, 'staging', 'backend'), null) // nessuna mappa
})

// --- Badge parlante: computeOverall dice colore (overall) + colpevole (cause/causes) ---

test('computeOverall: tutto up → nessuna causa', () => {
  const r = computeOverall({
    liveness: { key: 'liveness', status: 'up' },
    runtime: { key: 'runtime', status: 'up' },
  })
  assert.equal(r.overall, 'up')
  assert.equal(r.cause, null)
  assert.deepEqual(r.causes, [])
})

test('computeOverall: un check degraded → il badge punta a quel check', () => {
  const r = computeOverall({
    runtime: { key: 'runtime', status: 'up' },
    alarms: { key: 'alarms', status: 'degraded' },
  })
  assert.equal(r.overall, 'degraded')
  assert.equal(r.cause, 'alarms')
  assert.deepEqual(r.causes, ['alarms'])
})

test('computeOverall: down batte degraded; causa = il check down', () => {
  const r = computeOverall({
    liveness: { key: 'liveness', status: 'down' },
    alarms: { key: 'alarms', status: 'degraded' },
  })
  assert.equal(r.overall, 'down')
  assert.equal(r.cause, 'liveness')
  assert.deepEqual(r.causes, ['liveness'])
})

test('computeOverall: più check allo stesso livello → causa primaria per priorità', () => {
  const r = computeOverall({
    version: { key: 'version', status: 'degraded' },
    runtime: { key: 'runtime', status: 'degraded' },
  })
  assert.equal(r.overall, 'degraded')
  assert.equal(r.cause, 'runtime') // runtime ha priorità su version
  assert.deepEqual(new Set(r.causes), new Set(['version', 'runtime']))
})

// --- Filtro allarmi di autoscaling: rumore atteso, non guasto ---

test('isAutoscalingAlarm: TargetTracking AlarmLow/High = rumore di autoscaling', () => {
  assert.equal(
    isAutoscalingAlarm({ AlarmName: 'TargetTracking-service/cato-staging/backend-AlarmLow-abc' }),
    true,
  )
  assert.equal(
    isAutoscalingAlarm({ AlarmName: 'TargetTracking-service/cato-staging/backend-AlarmHigh-xyz' }),
    true,
  )
})

test('isAutoscalingAlarm: azione = scaling policy → autoscaling anche senza nome standard', () => {
  assert.equal(
    isAutoscalingAlarm({
      AlarmName: 'qualcosa',
      AlarmActions: [
        'arn:aws:autoscaling:eu-central-1:1:scalingPolicy:uuid:resource/ecs/service/c/s:policyName/p',
      ],
    }),
    true,
  )
})

test('isAutoscalingAlarm: allarme di salute vero (5xx, SNS) → NON filtrato', () => {
  assert.equal(
    isAutoscalingAlarm({
      AlarmName: 'backend-5xx-high',
      AlarmActions: ['arn:aws:sns:eu-central-1:1:alerts'],
    }),
    false,
  )
})

// --- Correlazione allarme→servizio ECS: solo per ServiceName, mai per cluster condiviso ---

const dim = (cluster, service) => [
  { Name: 'ClusterName', Value: cluster },
  { Name: 'ServiceName', Value: service },
]

test('alarms.run: ECS — allarme di un ALTRO servizio dello stesso cluster NON si attacca', async () => {
  const service = { aws: { type: 'ecs', cluster: 'cato-staging', service: 'backend' } }
  const ctx = {
    t: (k) => k,
    alarms: [{ AlarmName: 'agentic-chat-5xx', Dimensions: dim('cato-staging', 'agentic-chat') }],
  }
  assert.equal(await alarms.run(service, ctx), null) // nessun allarme PER backend
})

test('alarms.run: ECS — il proprio allarme (ServiceName) si attacca', async () => {
  const service = { aws: { type: 'ecs', cluster: 'cato-staging', service: 'backend' } }
  const ctx = {
    t: (k) => k,
    alarms: [{ AlarmName: 'backend-5xx', Dimensions: dim('cato-staging', 'backend') }],
  }
  const r = await alarms.run(service, ctx)
  assert.equal(r.status, 'degraded')
  assert.equal(r.key, 'alarms')
})
