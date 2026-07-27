import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEcsRun, pickLastRun } from '../server/runtime/ecsScheduled.js'

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

// --- pickLastRun: quale esecuzione guardare ---
// Su RunTask ogni esecuzione ha il suo log stream, quindi «l'ultima run» = lo stream più recente.
// Serviva perché cercare l'errore su TUTTO il gruppo con FilterLogEvents(limit:1) restituiva pagine
// vuote pur essendoci i match: un cron con tre traceback nell'ultima run risultava VERDE in produzione.
const ora = Date.UTC(2026, 6, 27, 12, 0)
const finestra = ora - 14 * 3600 * 1000 // startTime del check

test('pickLastRun: nessuno stream (mai girato) → missed', () => {
  assert.deepEqual(pickLastRun([], finestra), { stream: null, ran: false })
  assert.deepEqual(pickLastRun(undefined, finestra), { stream: null, ran: false })
})

test('pickLastRun: prende lo stream più recente anche se l API li restituisce in ordine sparso', () => {
  const streams = [
    { logStreamName: 'fam/c/vecchio', lastEventTimestamp: ora - 26 * 3600 * 1000 },
    { logStreamName: 'fam/c/ultimo', lastEventTimestamp: ora - 11 * 3600 * 1000 },
    { logStreamName: 'fam/c/mezzo', lastEventTimestamp: ora - 20 * 3600 * 1000 },
  ]
  assert.deepEqual(pickLastRun(streams, finestra), { stream: 'fam/c/ultimo', ran: true })
})

test('pickLastRun: ultima run FUORI dalla finestra attesa → non è partita (dead-man)', () => {
  const streams = [{ logStreamName: 'fam/c/vecchio', lastEventTimestamp: ora - 30 * 3600 * 1000 }]
  assert.deepEqual(pickLastRun(streams, finestra), { stream: 'fam/c/vecchio', ran: false })
})

test('pickLastRun: stream creati ma senza eventi vengono ignorati', () => {
  const streams = [
    { logStreamName: 'fam/c/vuoto' }, // creato e mai scritto: nessun lastEventTimestamp
    { logStreamName: 'fam/c/buono', lastEventTimestamp: ora - 2 * 3600 * 1000 },
  ]
  assert.deepEqual(pickLastRun(streams, finestra), { stream: 'fam/c/buono', ran: true })
  assert.deepEqual(pickLastRun([{ logStreamName: 'fam/c/vuoto' }], finestra), { stream: null, ran: false })
})
