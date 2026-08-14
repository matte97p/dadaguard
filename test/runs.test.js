import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  familyOfTaskDef,
  runIdOf,
  runsFromStreams,
  runFromTask,
  mergeRuns,
  classifyRun,
  runDuration,
  pairLambdaRuns,
  windowForRuns,
  pickRecentStreams,
} from '../server/runs.js'
import { summarize, sortCrons } from '../server/runsOverview.js'
import { ecsCron, lambdaCron, withNextRun, cronKey } from '../server/crons.js'

// Le esecuzioni non si leggono da un'unica API: ECS le dimentica dopo un'ora, Lambda non le elenca
// affatto. Questi test bloccano la parte che decide COS'È una run e COM'È andata — cioè tutto quello
// che non è una chiamata AWS.

test('familyOfTaskDef: ARN, family:rev, spazzatura', () => {
  assert.equal(familyOfTaskDef('arn:aws:ecs:eu-west-1:1234:task-definition/demo-cron-crawler:12'), 'demo-cron-crawler')
  assert.equal(familyOfTaskDef('demo-cron-crawler:12'), 'demo-cron-crawler')
  assert.equal(familyOfTaskDef(null), null)
})

test('runIdOf: ultimo segmento di ARN task e di nome stream', () => {
  assert.equal(runIdOf('arn:aws:ecs:eu-west-1:1234:task/demo-cluster/abc123'), 'abc123')
  assert.equal(runIdOf('cron/crawler/abc123'), 'abc123')
  assert.equal(runIdOf(''), null)
})

test('runsFromStreams: uno stream = una run, ordinate dalla più recente', () => {
  const runs = runsFromStreams(
    [
      { logStreamName: 'cron/app/aaa', firstEventTimestamp: 1000, lastEventTimestamp: 2000 },
      { logStreamName: 'cron/app/bbb', firstEventTimestamp: 5000, lastEventTimestamp: 9000 },
    ],
    { streamPrefix: 'cron', container: 'app' },
  )
  assert.deepEqual(
    runs.map((r) => r.id),
    ['bbb', 'aaa'],
  )
  assert.equal(runs[0].startedAt, 5000)
  assert.equal(runs[0].endedAt, 9000)
  assert.equal(runs[0].running, false) // il log non sa dire "in corso": lo dice l'API ECS
})

test('runsFromStreams: il sidecar non raddoppia la run, e la finestra taglia', () => {
  const streams = [
    { logStreamName: 'cron/app/aaa', firstEventTimestamp: 5000, lastEventTimestamp: 6000 },
    { logStreamName: 'cron/sidecar/aaa', firstEventTimestamp: 5000, lastEventTimestamp: 6000 },
    { logStreamName: 'cron/app/old', firstEventTimestamp: 10, lastEventTimestamp: 20 },
  ]
  const runs = runsFromStreams(streams, { streamPrefix: 'cron', container: 'app', since: 1000 })
  assert.deepEqual(
    runs.map((r) => r.id),
    ['aaa'],
  )
})

test('runFromTask: exit code del container principale, e startedAt che ricade su createdAt', () => {
  const task = {
    taskArn: 'arn:aws:ecs:eu-west-1:1234:task/demo/xyz',
    lastStatus: 'STOPPED',
    createdAt: new Date(1000),
    startedAt: new Date(2000),
    stoppedAt: new Date(9000),
    stopCode: 'EssentialContainerExited',
    stoppedReason: 'Essential container in task exited',
    containers: [
      { name: 'sidecar', exitCode: 0 },
      { name: 'app', exitCode: 137, reason: 'OutOfMemoryError: Container killed due to memory usage' },
    ],
  }
  const run = runFromTask(task, { container: 'app' })
  assert.equal(run.id, 'xyz')
  assert.equal(run.exitCode, 137)
  assert.equal(run.running, false)
  assert.equal(run.startedAt, 2000)

  // Task appena lanciato: nessuno `startedAt` ancora, ma la riga deve avere un orario.
  const pending = runFromTask({ taskArn: 'a/b/pending', lastStatus: 'PROVISIONING', createdAt: new Date(1000), containers: [] })
  assert.equal(pending.startedAt, 1000)
  assert.equal(pending.running, true)
})

test('mergeRuns: l’API vince sui suoi campi, il log porta lo stream e lo storico', () => {
  const logRuns = [
    { id: 'aaa', startedAt: 1100, endedAt: 2000, stream: 'cron/app/aaa', running: false, source: 'log' },
    { id: 'old', startedAt: 10, endedAt: 20, stream: 'cron/app/old', running: false, source: 'log' },
  ]
  const apiRuns = [{ id: 'aaa', startedAt: 1000, endedAt: 2100, running: false, exitCode: 0, source: 'api' }]
  const merged = mergeRuns(logRuns, apiRuns)
  const aaa = merged.find((r) => r.id === 'aaa')
  assert.equal(aaa.startedAt, 1000) // timestamp veri: quelli dell'API
  assert.equal(aaa.exitCode, 0)
  assert.equal(aaa.stream, 'cron/app/aaa') // ...ma lo stream non si perde, o la run non è apribile
  assert.equal(aaa.source, 'both')
  assert.ok(merged.find((r) => r.id === 'old')) // la run che l'API ha dimenticato resta
})

test('mergeRuns: una run VIVA nota solo all’API entra in lista', () => {
  const merged = mergeRuns([], [{ id: 'live', startedAt: 5000, endedAt: null, running: true, source: 'api' }])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].running, true)
})

test('classifyRun: i segnali di fallimento, e il silenzio che NON è un ok', () => {
  assert.equal(classifyRun({ running: true }), 'running')
  assert.equal(classifyRun({ exitCode: 0, endedAt: 9 }), 'ok')
  assert.equal(classifyRun({ exitCode: 1, endedAt: 9 }), 'failed')
  assert.equal(classifyRun({ exitCode: 0, failed: true, endedAt: 9 }), 'failed') // exit 0 e traceback nei log
  assert.equal(classifyRun({ stopCode: 'TaskFailedToStart', endedAt: 9 }), 'failed')
  assert.equal(classifyRun({ exitCode: null, stopReason: 'OutOfMemoryError: Container killed', endedAt: 9 }), 'failed')
  assert.equal(classifyRun({ timedOut: true, endedAt: 9 }), 'failed')
  // Run senza fine e senza modo di saperlo: 'unknown', mai 'ok' per omissione.
  assert.equal(classifyRun({ running: false, endedAt: null }), 'unknown')
})

test('runDuration: quella vera se finita, quella maturata se in corso', () => {
  assert.equal(runDuration({ startedAt: 1000, endedAt: 4000, running: false }), 3000)
  assert.equal(runDuration({ startedAt: 1000, endedAt: null, running: true }, 6000), 5000)
  assert.equal(runDuration({ startedAt: null }), null)
  assert.equal(runDuration({ startedAt: 1000, endedAt: null, running: false }), null)
})

// --- Lambda: la lista delle invocazioni ESISTE solo nei log, quindi questo è il pezzo critico ---

const START = (id) => `START RequestId: ${id} Version: $LATEST`
const REPORT = (id, ms) => `REPORT RequestId: ${id}\tDuration: ${ms} ms\tBilled Duration: ${Math.ceil(ms)} ms\tMemory Size: 512 MB\tMax Memory Used: 118 MB\t`

test('pairLambdaRuns: START+REPORT = una run, con durata e memoria', () => {
  const id = '3f9c1a20-5d7e-4b81-9c02-6ad4e7f13b58'
  const runs = pairLambdaRuns(
    [
      { ts: 1000, message: START(id), stream: 's1' },
      { ts: 5200, message: REPORT(id, 4187.42), stream: 's1' },
    ],
    { now: 10_000 },
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].outcome, 'ok')
  assert.equal(runs[0].durationMs, 4187.42)
  assert.equal(runs[0].maxMemoryMb, 118)
  assert.equal(runs[0].running, false)
})

test('pairLambdaRuns: un traceback va alla run APERTA nello stesso stream, non a quella dopo', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  const runs = pairLambdaRuns(
    [
      { ts: 1000, message: START(a), stream: 's1' },
      { ts: 1500, message: 'Traceback (most recent call last):', stream: 's1' },
      { ts: 2000, message: REPORT(a, 1000), stream: 's1' },
      { ts: 3000, message: START(b), stream: 's1' },
      { ts: 4000, message: REPORT(b, 1000), stream: 's1' },
    ],
    { now: 10_000 },
  )
  const byId = Object.fromEntries(runs.map((r) => [r.id, r]))
  assert.equal(byId[a].outcome, 'failed')
  assert.equal(byId[b].outcome, 'ok') // l'errore della precedente non contagia la successiva
})

test('pairLambdaRuns: invocazioni concorrenti su stream diversi non si mescolano', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  const runs = pairLambdaRuns(
    [
      { ts: 1000, message: START(a), stream: 's1' },
      { ts: 1100, message: START(b), stream: 's2' },
      { ts: 1200, message: '[ERROR] boom', stream: 's2' },
      { ts: 2000, message: REPORT(a, 1000), stream: 's1' },
      { ts: 2100, message: REPORT(b, 1000), stream: 's2' },
    ],
    { now: 10_000 },
  )
  const byId = Object.fromEntries(runs.map((r) => [r.id, r]))
  assert.equal(byId[a].outcome, 'ok')
  assert.equal(byId[b].outcome, 'failed')
})

test('pairLambdaRuns: senza REPORT è "in corso" solo finché può esserlo (timeout + grazia)', () => {
  const id = '33333333-3333-4333-8333-333333333333'
  const events = [{ ts: 1000, message: START(id), stream: 's1' }]
  // Dentro il timeout: sta girando.
  assert.equal(pairLambdaRuns(events, { now: 60_000, timeoutSec: 300 })[0].outcome, 'running')
  // Oltre timeout + grazia: il REPORT non arriverà mai → 'unknown', non un "in corso" eterno.
  const stale = pairLambdaRuns(events, { now: 1000 + 300_000 + 61_000, timeoutSec: 300 })[0]
  assert.equal(stale.running, false)
  assert.equal(stale.outcome, 'unknown')
})

test('pairLambdaRuns: il timeout della piattaforma è un fallimento, col suo request id', () => {
  const id = '44444444-4444-4444-8444-444444444444'
  const runs = pairLambdaRuns(
    [
      { ts: 1000, message: START(id), stream: 's1' },
      { ts: 301_000, message: `${id} Task timed out after 300.02 seconds`, stream: 's1' },
      { ts: 301_010, message: REPORT(id, 300_020), stream: 's1' },
    ],
    { now: 400_000, timeoutSec: 300 },
  )
  assert.equal(runs[0].timedOut, true)
  assert.equal(runs[0].outcome, 'failed')
})

test('pairLambdaRuns: REPORT senza START (finestra tagliata) ricostruisce l’inizio dalla durata', () => {
  const id = '55555555-5555-4555-8555-555555555555'
  const runs = pairLambdaRuns([{ ts: 10_000, message: REPORT(id, 2000), stream: 's1' }], { now: 20_000 })
  assert.equal(runs[0].startedAt, 8000)
  assert.equal(runs[0].outcome, 'ok')
})

// --- Quanto leggere, e su quali stream: le due misure che tengono la pagina sotto la quota AWS ---

test('windowForRuns: la finestra la decide la CADENZA, col tetto di quella chiesta', () => {
  // Cron ogni 5 minuti, 6 run chieste → mezz'ora abbondante basta: niente scansioni da 24h.
  assert.equal(windowForRuns(1440, { scheduleMinutes: 5, limit: 6 }), 35)
  // Giornaliero: la cadenza chiederebbe 7 giorni, ma il tetto è la finestra chiesta.
  assert.equal(windowForRuns(1440, { scheduleMinutes: 1440, limit: 6 }), 1440)
  assert.equal(windowForRuns(10_080, { scheduleMinutes: 1440, limit: 6 }), 10_080)
  // Cadenza ignota → si assume giornaliero (non si inventa una finestra corta che nasconde le run).
  assert.equal(windowForRuns(1440, { limit: 6 }), 1440)
  // Minimo un quarto d'ora: un cron al minuto con 6 minuti di finestra sarebbe rumore.
  assert.equal(windowForRuns(1440, { scheduleMinutes: 1, limit: 2 }), 15)
  // Finestra chiesta piccolissima: comanda lei, non la cadenza.
  assert.equal(windowForRuns(20, { scheduleMinutes: 1440, limit: 6 }), 20)
})

test('pickRecentStreams: si restringe SOLO se gli stream coprono la finestra', () => {
  const s = (name, last) => ({ logStreamName: name, lastEventTimestamp: last })
  // Meno di quanti chiesti = il gruppo non ne ha altri → si può restringere.
  assert.equal(pickRecentStreams([s('a', 5000), s('b', 9000)], { since: 1000, wanted: 20 }).restrict, true)
  // Pieni, ma il più vecchio ha smesso di scrivere prima della finestra → copre tutto, si restringe.
  const pieniVecchi = Array.from({ length: 20 }, (_, i) => s(`s${i}`, i === 0 ? 500 : 9000))
  assert.equal(pickRecentStreams(pieniVecchi, { since: 1000, wanted: 20 }).restrict, true)
  // Pieni e TUTTI attivi dentro la finestra: ce ne possono essere altri non elencati → NON si restringe,
  // meglio lento che una run che sparisce in silenzio.
  const pieniCaldi = Array.from({ length: 20 }, (_, i) => s(`s${i}`, 9000))
  assert.equal(pickRecentStreams(pieniCaldi, { since: 1000, wanted: 20 }).restrict, false)
  // Nessuno stream: niente su cui restringere.
  assert.deepEqual(pickRecentStreams([], { since: 1000 }), { names: [], restrict: false })
})

// --- Registro dei cron e riassunto per la lista ---

test('cronKey / ecsCron / lambdaCron: identità e stato dallo schedule', () => {
  assert.equal(cronKey('prod', 'crawler'), 'prod/crawler')
  const ecs = ecsCron(
    { name: 'crawler', cluster: 'arn:cluster', taskDefArn: 'arn:aws:ecs:eu-west-1:1:task-definition/demo-crawler:3', expr: 'cron(0 3 * * ? *)', minutes: 1440, state: 'ENABLED', tz: 'Europe/Rome' },
    'prod',
    'eu-west-1',
  )
  assert.equal(ecs.key, 'prod/crawler')
  assert.equal(ecs.type, 'ecs-scheduled')
  assert.equal(ecs.family, 'demo-crawler')
  assert.equal(ecs.enabled, true)

  const lam = lambdaCron('digest', { expr: 'rate(15 minutes)', minutes: 15, state: 'DISABLED' }, 'staging', 'eu-west-1')
  assert.equal(lam.type, 'lambda')
  assert.equal(lam.function, 'digest')
  assert.equal(lam.enabled, false)
})

test('withNextRun: un cron spento non ha una prossima partenza', () => {
  const base = { scheduleExpr: 'cron(0 3 * * ? *)', scheduleTz: 'UTC' }
  assert.ok(withNextRun({ ...base, enabled: true }, Date.UTC(2026, 0, 1, 0, 0)).nextRunAt > 0)
  assert.equal(withNextRun({ ...base, enabled: false }).nextRunAt, null)
})

test('summarize: conta le run vive e prende l’esito dell’ultima FINITA', () => {
  const s = summarize(
    { key: 'prod/x', name: 'x' },
    [
      { startedAt: 900, running: true, outcome: 'running' },
      { startedAt: 500, running: false, outcome: 'failed' },
      { startedAt: 100, running: false, outcome: 'ok' },
    ],
  )
  assert.equal(s.running, 1)
  assert.equal(s.lastOutcome, 'failed') // non 'running': l'ultima FINITA è quella che dice com'è andata
  assert.equal(s.lastRunAt, 900)
  assert.equal(s.failedShown, 1)
})

test('sortCrons: prima chi gira adesso, poi chi ha appena fallito, poi per ultima run', () => {
  const lista = [
    { name: 'ok-vecchio', running: 0, lastOutcome: 'ok', lastRunAt: 100 },
    { name: 'fallito', running: 0, lastOutcome: 'failed', lastRunAt: 200 },
    { name: 'in-corso', running: 1, lastOutcome: 'ok', lastRunAt: 50 },
    { name: 'ok-nuovo', running: 0, lastOutcome: 'ok', lastRunAt: 300 },
  ].sort(sortCrons)
  assert.deepEqual(
    lista.map((c) => c.name),
    ['in-corso', 'fallito', 'ok-nuovo', 'ok-vecchio'],
  )
})
