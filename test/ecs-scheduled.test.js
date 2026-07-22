import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEcsRun } from '../server/runtime/ecsScheduled.js'

// Esito di un cron ECS dai due segnali di log durevoli: è partito? è fallito (traceback/errore)?
test('classifyEcsRun: non partito → missed (dead-man)', () => {
  assert.equal(classifyEcsRun({ ran: false, failed: false }), 'missed')
  assert.equal(classifyEcsRun({ ran: false, failed: true }), 'missed') // ran=false vince
})

test('classifyEcsRun: partito ma con errori nei log → failed', () => {
  assert.equal(classifyEcsRun({ ran: true, failed: true }), 'failed')
})

test('classifyEcsRun: partito e pulito → ok', () => {
  assert.equal(classifyEcsRun({ ran: true, failed: false }), 'ok')
})
