import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAutoscalingAlarm, run } from '../server/checks/alarms.js'

// Un allarme su un ALB non porta il nome del servizio ECS: le sue dimensioni sono `LoadBalancer` e
// `TargetGroup`. Il ponte è la convenzione di nome del target group, `<cluster>-<servizio>`.
const allarmeAlb = (tg, nome = 'acme-production-alb-5xx') => ({
  AlarmName: nome,
  Dimensions: [
    { Name: 'LoadBalancer', Value: 'app/acme-production-alb/da88ba4cbb5da209' },
    { Name: 'TargetGroup', Value: `targetgroup/${tg}/aef1b2e1adb1c9f9` },
  ],
})

const ecs = (service, cluster = 'acme-production') => ({ aws: { type: 'ecs', cluster, service } })
const ctx = (alarms) => ({ alarms, t: (_k, v) => JSON.stringify(v) })

test('allarme ALB: correlato al servizio ECS via nome del target group', async () => {
  const r = await run(ecs('backend'), ctx([allarmeAlb('acme-production-backend')]))
  assert.ok(r, 'la riga deve comparire')
  assert.equal(r.status, 'degraded')
  assert.match(r.summary, /acme-production-alb-5xx/)
})

test('allarme ALB: NON si attacca agli altri servizi dello stesso ALB', async () => {
  const c = ctx([allarmeAlb('acme-production-backend')])
  assert.equal(await run(ecs('agentic-chat'), c), null)
  assert.equal(await run(ecs('garanzia'), c), null)
})

test('allarme ALB: un secondo target group dello stesso servizio conta comunque', async () => {
  // `backend` sta dietro due gruppi: quello pubblico e `-int` sull'ALB interno.
  const r = await run(ecs('backend'), ctx([allarmeAlb('acme-production-backend-int', 'latenza-int')]))
  assert.ok(r)
  assert.match(r.summary, /latenza-int/)
})

test('allarme ALB: cluster diverso non correla (staging non parla per production)', async () => {
  const c = ctx([allarmeAlb('acme-production-backend')])
  assert.equal(await run(ecs('backend', 'acme-staging'), c), null)
})

test('gli allarmi di autoscaling restano esclusi', () => {
  assert.equal(isAutoscalingAlarm({ AlarmName: 'TargetTracking-service/x-AlarmLow-123' }), true)
  assert.equal(
    isAutoscalingAlarm({ AlarmName: 'qualunque', AlarmActions: ['arn:aws:autoscaling:...:scalingPolicy:abc'] }),
    true,
  )
  assert.equal(isAutoscalingAlarm({ AlarmName: 'acme-production-alb-5xx', AlarmActions: ['arn:aws:sns:...:topic'] }), false)
})

test('la correlazione per dimensione diretta continua a funzionare', async () => {
  const diretto = { AlarmName: 'ecs-cpu', Dimensions: [{ Name: 'ServiceName', Value: 'backend' }] }
  const r = await run(ecs('backend'), ctx([diretto]))
  assert.ok(r)
  assert.match(r.summary, /ecs-cpu/)
})

// Un servizio può avere cinque allarmi attivi insieme (5xx + latenza + target + CPU + memoria): la riga
// ne nomina tre e dice quanti restano. Il `, +N` era scritto a mano qui dentro, ora è la funzione
// condivisa — e questo test guarda la riga VERA, non l'helper.
test('più allarmi del tetto: tre nomi e «+N», non un elenco infinito né un silenzio', async () => {
  const cinque = ['a', 'b', 'c', 'd', 'e'].map((n) => allarmeAlb('acme-production-backend', `alb-${n}`))
  const t = (_k, v) => `${v.n}|${v.list}`
  const r = await run(ecs('backend'), { alarms: cinque, t })
  assert.equal(r.summary, '5|alb-a, alb-b, alb-c, +2')
})

test('allarmi sotto il tetto: nessun «+0» appiccicato in fondo', async () => {
  const due = ['a', 'b'].map((n) => allarmeAlb('acme-production-backend', `alb-${n}`))
  const r = await run(ecs('backend'), { alarms: due, t: (_k, v) => v.list })
  assert.equal(r.summary, 'alb-a, alb-b')
})
