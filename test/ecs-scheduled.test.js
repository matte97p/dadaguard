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

// --- runOutcome: le due strade, e la pagina vuota che non è una risposta ---
import { DescribeLogStreamsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { runOutcome } from '../server/runtime/ecsScheduled.js'

// Client CloudWatch finto: `pagine` è la sequenza di risposte che FilterLogEvents restituirà.
function fakeLogs({ streams, streamsError, pagine }) {
  let i = 0
  const chiamate = { describe: 0, filter: 0 }
  return {
    chiamate,
    async send(cmd) {
      if (cmd instanceof DescribeLogStreamsCommand) {
        chiamate.describe++
        if (streamsError) throw streamsError
        return { logStreams: streams }
      }
      if (cmd instanceof FilterLogEventsCommand) {
        chiamate.filter++
        return pagine[Math.min(i++, pagine.length - 1)]
      }
      throw new Error('comando inatteso')
    },
  }
}
const denied = Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' })
const start = Date.UTC(2026, 6, 27, 0, 0)
const dentro = [{ logStreamName: 'fam/c/ultima', lastEventTimestamp: start + 3600_000 }]

test('runOutcome: il match a pagina 2 NON deve sfuggire (era il falso verde)', async () => {
  const logs = fakeLogs({ streams: dentro, pagine: [{ events: [], nextToken: 'p2' }, { events: [{ message: 'Traceback' }] }] })
  assert.deepEqual(await runOutcome(logs, '/gruppo', start), { ran: true, failed: true })
})

test('runOutcome: pagine tutte vuote e token finito → nessun errore trovato', async () => {
  const logs = fakeLogs({ streams: dentro, pagine: [{ events: [], nextToken: 'p2' }, { events: [] }] })
  assert.deepEqual(await runOutcome(logs, '/gruppo', start), { ran: true, failed: false })
})

test('runOutcome: budget di pagine esaurito → "non trovato", mai un fallimento inventato', async () => {
  const logs = fakeLogs({ streams: dentro, pagine: [{ events: [], nextToken: 'sempre' }] })
  const out = await runOutcome(logs, '/gruppo', start)
  assert.deepEqual(out, { ran: true, failed: false })
  assert.ok(logs.chiamate.filter <= 15, `pagine ${logs.chiamate.filter}: deve fermarsi al tetto`)
})

test('runOutcome: senza logs:DescribeLogStreams ripiega sul gruppo intero (e continua a funzionare)', async () => {
  const logs = fakeLogs({ streamsError: denied, pagine: [{ events: [{ message: 'INFO ...' }] }] })
  assert.deepEqual(await runOutcome(logs, '/gruppo', start), { ran: true, failed: true })
  assert.equal(logs.chiamate.describe, 1)
})

test('runOutcome: ultima run fuori finestra → missed, senza cercare errori', async () => {
  const fuori = [{ logStreamName: 'fam/c/vecchia', lastEventTimestamp: start - 3600_000 }]
  const logs = fakeLogs({ streams: fuori, pagine: [{ events: [{ message: 'Traceback' }] }] })
  assert.deepEqual(await runOutcome(logs, '/gruppo', start), { ran: false, failed: false })
  assert.equal(logs.chiamate.filter, 0)
})

test('runOutcome: un errore che NON è "accesso negato" non va mascherato', async () => {
  const boom = Object.assign(new Error('kaboom'), { name: 'ThrottlingException' })
  const logs = fakeLogs({ streamsError: boom, pagine: [] })
  await assert.rejects(() => runOutcome(logs, '/gruppo', start), /kaboom/)
})
