import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleExpressionToMinutes, minutesToSchedule } from '../server/schedules.js'

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
