import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scheduleExpressionToMinutes,
  minutesToSchedule,
  classifyScheduleTarget,
} from '../server/schedules.js'

test('scheduleExpressionToMinutes: rate() è esatto', () => {
  assert.equal(scheduleExpressionToMinutes('rate(15 minutes)'), 15)
  assert.equal(scheduleExpressionToMinutes('rate(1 minute)'), 1)
  assert.equal(scheduleExpressionToMinutes('rate(1 hour)'), 60)
  assert.equal(scheduleExpressionToMinutes('rate(2 hours)'), 120)
  assert.equal(scheduleExpressionToMinutes('rate(1 day)'), 1440)
  assert.equal(scheduleExpressionToMinutes('rate(7 days)'), 10080)
})

test('scheduleExpressionToMinutes: cron() — stima best-effort (nel dubbio sovrastima)', () => {
  assert.equal(scheduleExpressionToMinutes('cron(*/5 * * * ? *)'), 5) // ogni 5 minuti
  assert.equal(scheduleExpressionToMinutes('cron(0 * * * ? *)'), 60) // minuto fisso → ogni ora
  assert.equal(scheduleExpressionToMinutes('cron(0 0/2 * * ? *)'), 120) // ogni 2 ore (start/step)
  assert.equal(scheduleExpressionToMinutes('cron(0 2 * * ? *)'), 1440) // giornaliera alle 2 → fallback
})

// Il caso preso in faccia il 25/08/2026 su un cron `…-production-cron-db-restore-test`: la prova di
// ripristino del database gira il PRIMO DI OGNI MESE e il pannello scriveva «ogni 1g», perché la
// cadenza si deduceva dai soli minuti/ore. La finestra del dead man's switch arriva da
// `missedWindow` (che legge l'espressione vera), quindi qui si corregge solo la frase, ma è la frase
// che un dev legge per capire se il cron è in ritardo.
test('scheduleExpressionToMinutes: cron() con giorno del mese, mese o giorno della settimana', () => {
  assert.equal(scheduleExpressionToMinutes('cron(0 5 1 * ? *)'), 43200) // il 1° del mese → mensile
  assert.equal(scheduleExpressionToMinutes('cron(30 4 15 * ? *)'), 43200) // il 15 del mese → mensile
  assert.equal(scheduleExpressionToMinutes('cron(0 5 1,15 * ? *)'), 21600) // due volte al mese
  assert.equal(scheduleExpressionToMinutes('cron(0 5 */3 * ? *)'), 4320) // ogni 3 giorni
  assert.equal(scheduleExpressionToMinutes('cron(0 5 1 */3 ? *)'), 129600) // ogni 3 mesi
  assert.equal(scheduleExpressionToMinutes('cron(0 5 1 JAN ? *)'), 525600) // giorno e mese fissi → annuale
  assert.equal(scheduleExpressionToMinutes('cron(0 17 ? * MON *)'), 10080) // un giorno a settimana
  assert.equal(scheduleExpressionToMinutes('cron(0 17 ? * MON-FRI *)'), 1440) // lun-ven → giornaliero
  assert.equal(scheduleExpressionToMinutes('cron(0 5 L * ? *)'), 1440) // `L` non si legge → fallback
})

test('scheduleExpressionToMinutes: input non valido → null', () => {
  assert.equal(scheduleExpressionToMinutes(''), null)
  assert.equal(scheduleExpressionToMinutes(null), null)
  assert.equal(scheduleExpressionToMinutes('non-una-espressione'), null)
})

test('minutesToSchedule: formato compatibile con runtime/lambda.js (parseSchedule)', () => {
  assert.equal(minutesToSchedule(15), '15m')
  assert.equal(minutesToSchedule(1440), '1440m')
  assert.equal(minutesToSchedule(0), null)
  assert.equal(minutesToSchedule(null), null)
})

// EventBridge Scheduler: distingue i target Lambda vs ECS RunTask (i nostri cron usano lo Scheduler,
// non le Rules → questa classificazione è ciò che li fa smettere di apparire "on-demand").
test('classifyScheduleTarget: target Lambda → { kind: lambda, name }', () => {
  const r = classifyScheduleTarget({
    Arn: 'arn:aws:lambda:eu-central-1:111:function:acme-staging-cron-release-recap',
  })
  assert.deepEqual(r, { kind: 'lambda', name: 'acme-staging-cron-release-recap' })
})

test('classifyScheduleTarget: target ECS RunTask → { kind: ecs, cluster, taskDefArn }', () => {
  const r = classifyScheduleTarget({
    Arn: 'arn:aws:ecs:eu-central-1:111:cluster/acme-production',
    EcsParameters: {
      TaskDefinitionArn: 'arn:aws:ecs:eu-central-1:111:task-definition/acme-production-cron-refresh-bi-mvs:3',
    },
  })
  assert.equal(r.kind, 'ecs')
  assert.equal(r.cluster, 'arn:aws:ecs:eu-central-1:111:cluster/acme-production')
  assert.equal(r.taskDefArn, 'arn:aws:ecs:eu-central-1:111:task-definition/acme-production-cron-refresh-bi-mvs:3')
})

test('classifyScheduleTarget: altro target (SQS) o vuoto → kind null', () => {
  assert.equal(classifyScheduleTarget({ Arn: 'arn:aws:sqs:eu-central-1:111:some-queue' }).kind, null)
  assert.equal(classifyScheduleTarget(undefined).kind, null)
})
