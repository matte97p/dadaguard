import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAutoscalingAlarm, run } from '../server/checks/alarms.js'

// Un allarme su un ALB non porta il nome del servizio ECS: le sue dimensioni sono `LoadBalancer` e
// `TargetGroup`. Il ponte è la convenzione di nome del target group, `<cluster>-<servizio>`.
const allarmeAlb = (tg, nome = 'cato-production-alb-5xx') => ({
  AlarmName: nome,
  Dimensions: [
    { Name: 'LoadBalancer', Value: 'app/cato-production-alb/da88ba4cbb5da209' },
    { Name: 'TargetGroup', Value: `targetgroup/${tg}/aef1b2e1adb1c9f9` },
  ],
})

const ecs = (service, cluster = 'cato-production') => ({ aws: { type: 'ecs', cluster, service } })
const ctx = (alarms) => ({ alarms, t: (_k, v) => JSON.stringify(v) })

test('allarme ALB: correlato al servizio ECS via nome del target group', async () => {
  const r = await run(ecs('backend'), ctx([allarmeAlb('cato-production-backend')]))
  assert.ok(r, 'la riga deve comparire')
  assert.equal(r.status, 'degraded')
  assert.match(r.summary, /cato-production-alb-5xx/)
})

test('allarme ALB: NON si attacca agli altri servizi dello stesso ALB', async () => {
  const c = ctx([allarmeAlb('cato-production-backend')])
  assert.equal(await run(ecs('agentic-chat'), c), null)
  assert.equal(await run(ecs('garanzia'), c), null)
})

test('allarme ALB: un secondo target group dello stesso servizio conta comunque', async () => {
  // `backend` sta dietro due gruppi: quello pubblico e `-int` sull'ALB interno.
  const r = await run(ecs('backend'), ctx([allarmeAlb('cato-production-backend-int', 'latenza-int')]))
  assert.ok(r)
  assert.match(r.summary, /latenza-int/)
})

test('allarme ALB: cluster diverso non correla (staging non parla per production)', async () => {
  const c = ctx([allarmeAlb('cato-production-backend')])
  assert.equal(await run(ecs('backend', 'cato-staging'), c), null)
})

test('gli allarmi di autoscaling restano esclusi', () => {
  assert.equal(isAutoscalingAlarm({ AlarmName: 'TargetTracking-service/x-AlarmLow-123' }), true)
  assert.equal(
    isAutoscalingAlarm({ AlarmName: 'qualunque', AlarmActions: ['arn:aws:autoscaling:...:scalingPolicy:abc'] }),
    true,
  )
  assert.equal(isAutoscalingAlarm({ AlarmName: 'cato-production-alb-5xx', AlarmActions: ['arn:aws:sns:...:topic'] }), false)
})

test('la correlazione per dimensione diretta continua a funzionare', async () => {
  const diretto = { AlarmName: 'ecs-cpu', Dimensions: [{ Name: 'ServiceName', Value: 'backend' }] }
  const r = await run(ecs('backend'), ctx([diretto]))
  assert.ok(r)
  assert.match(r.summary, /ecs-cpu/)
})
