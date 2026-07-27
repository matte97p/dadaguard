import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DescribeLogStreamsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { runOutcome, pickLastRun } from '../server/runtime/ecsScheduled.js'
import { imageTag } from '../server/runtime/ecs.js'
import { displayTag } from '../server/checks/version.js'
import { missedWindow, nextRun, prevRun } from '../server/util/nextrun.js'
import { scheduleExpressionToMinutes } from '../server/schedules.js'

// TEST DI CONTRATTO — rigiocano risposte AWS **vere**, registrate una volta (sanificate) da
// `scripts/record-aws-fixtures.mjs`, senza rete e senza credenziali.
//
// Gli altri test provano la nostra logica su dati scritti da noi, e per questo non hanno trovato i
// tre guasti del 27/07/2026: stavano tutti nell'INCONTRO con AWS, non nella logica. Qui la forma vera
// entra nel repo, e ognuno di quei tre casi è un test che li impedisce di tornare in silenzio.
//
// Se AWS cambia una di queste forme, questi test cadono: è esattamente il loro scopo. Per aggiornarli
// si ri-registra (lo script è documentato in testa) e si guarda cosa è cambiato.
const file = (nome) => JSON.parse(readFileSync(new URL(`./fixtures/aws/${nome}.json`, import.meta.url), 'utf8'))
const fixture = (nome) => file(nome).payload
const richiesta = (nome) => file(nome)._richiesta ?? {}

// Client CloudWatch finto che serve le risposte REGISTRATE, nell'ordine in cui AWS le ha date.
function logsDaFixture(pagine, streams) {
  let i = 0
  return {
    async send(cmd) {
      if (cmd instanceof DescribeLogStreamsCommand) {
        if (!streams) throw Object.assign(new Error('non autorizzato'), { name: 'AccessDeniedException' })
        return streams
      }
      if (cmd instanceof FilterLogEventsCommand) return pagine[Math.min(i++, pagine.length - 1)]
      throw new Error('comando inatteso')
    },
  }
}

// ── Guasto 1: la pagina vuota che non è una risposta ────────────────────────────────────────────
// FilterLogEvents(limit:1) su un log group distribuisce uno scan budget tra gli stream e può tornare
// `events: []` CON un `nextToken` pur essendoci i match. Il check leggeva quella pagina come "nessun
// errore" e mostrava VERDE un cron di produzione con tre traceback nell'ultima esecuzione.
test('contratto: pagina 1 vuota CON nextToken — la forma esiste, registrata da AWS', () => {
  const p1 = fixture('filter-log-events-page1')
  assert.deepEqual(p1.events, [], 'la fixture deve contenere proprio la pagina vuota')
  assert.ok(p1.nextToken, 'e il token che dice "lo scan non è finito"')
})

test('contratto: il fallimento si trova a pagina 2, non fermandosi alla prima', async () => {
  const p1 = fixture('filter-log-events-page1')
  const p2 = fixture('filter-log-events-page2')
  assert.match(p2.events[0].message, /Traceback/, 'la pagina 2 contiene il traceback vero')

  // senza DescribeLogStreams (ruolo read-only): strada B, inseguendo le pagine
  const out = await runOutcome(logsDaFixture([p1, p2], null), '/gruppo', Date.now() - 1000 * 60 * 60)
  assert.equal(out.failed, true, 'con la paginazione il fallimento si vede')
})

test('contratto: fermarsi alla prima pagina è il bug — un cron fallito passerebbe per verde', async () => {
  const p1 = fixture('filter-log-events-page1')
  // simula il comportamento vecchio: UNA sola chiamata, nessun token inseguito
  const unaSolaPagina = (p1.events ?? []).length > 0
  assert.equal(unaSolaPagina, false, 'la vecchia logica leggeva "nessun errore" da questa pagina')
})

// ── Guasto 2: il fuso dello schedule ───────────────────────────────────────────────────────────
// EventBridge Scheduler dichiara ScheduleExpressionTimezone. Valutata in UTC, `cron(0 17 …)` punta
// due ore dopo (in estate) l'esecuzione vera: la finestra del dead-man partiva DOPO la run e la
// mancava, dando per fermo un cron che girava ogni giorno lavorativo.
test('contratto: GetSchedule porta un fuso, e non è UTC', () => {
  const s = fixture('get-schedule-timezone')
  assert.equal(s.ScheduleExpression, 'cron(0 17 ? * MON-FRI *)')
  assert.equal(s.ScheduleExpressionTimezone, 'Europe/Rome')
  assert.equal(s.State, 'ENABLED')
})

test('contratto: con il fuso vero il fire precedente è due ore prima (in estate)', () => {
  const s = fixture('get-schedule-timezone')
  const lunedi = Date.UTC(2026, 6, 27, 12, 4) // lunedì 27/07, mattina
  const conFuso = prevRun(s.ScheduleExpression, lunedi, s.ScheduleExpressionTimezone)
  const senzaFuso = prevRun(s.ScheduleExpression, lunedi)
  assert.equal(conFuso, Date.UTC(2026, 6, 24, 15, 0), 'venerdì 17:00 a Roma = 15:00Z')
  assert.equal(senzaFuso - conFuso, 2 * 3600 * 1000, 'ignorare il fuso sposta di due ore')
})

test('contratto: la finestra col fuso COPRE l’esecuzione vera; senza fuso la manca', () => {
  const s = fixture('get-schedule-timezone')
  const m = fixture('get-metric-data-weekday-cron')
  const lunedi = Date.UTC(2026, 6, 27, 12, 4)
  // L'ultima invocazione REGISTRATA da CloudWatch prima di quel momento. Attenzione: i Timestamps
  // sono inizi di SECCHIO (vedi _richiesta.periodSeconds), quindi la run vera cade entro [t, t+period):
  // il confronto si fa sulla fine del secchio, altrimenti si sta misurando la griglia della query.
  const periodMs = (richiesta('get-metric-data-weekday-cron').periodSeconds ?? 300) * 1000
  const secchi = m.MetricDataResults[0].Timestamps.map((t) => Date.parse(t)).filter((t) => t < lunedi)
  const ultimaVera = Math.max(...secchi) + periodMs

  const conFuso = missedWindow(s.ScheduleExpression, lunedi, s.ScheduleExpressionTimezone)
  const senzaFuso = missedWindow(s.ScheduleExpression, lunedi)
  assert.ok(lunedi - conFuso.windowMin * 60000 <= ultimaVera, 'col fuso la finestra contiene la run vera')
  assert.ok(lunedi - senzaFuso.windowMin * 60000 > ultimaVera, 'senza fuso resta fuori: il falso rosso')
})

test('contratto: un cron lun-ven ha buchi nel fine settimana (la cadenza NON è costante)', () => {
  const m = fixture('get-metric-data-weekday-cron')
  const giorni = m.MetricDataResults[0].Timestamps.map((t) => new Date(t).getUTCDay())
  assert.ok(giorni.length >= 3, 'servono abbastanza punti per vedere lo schema')
  assert.ok(!giorni.includes(0) && !giorni.includes(6), 'nessuna invocazione di sabato o domenica')
  // ...ed è per questo che dedurre "ogni 24h" e cercare in 29h è sbagliato di lunedì
  const istanti = m.MetricDataResults[0].Timestamps.map((t) => Date.parse(t)).sort((a, b) => a - b)
  const buchi = istanti.slice(1).map((t, i) => t - istanti[i])
  const buchoMax = Math.max(...buchi)
  assert.ok(buchoMax > 29 * 3600 * 1000, `il buco più largo è ${Math.round(buchoMax / 3600000)}h: la finestra dedotta (29h) non lo copre`)
})

test('contratto: rate()/espressioni non calcolabili → nessuna stima inventata', () => {
  assert.equal(missedWindow('rate(4 hours)', Date.now(), 'Europe/Rome'), null)
  assert.equal(nextRun('rate(1 hour)', Date.now()), null)
})

// ── Guasto 3: i valori grezzi della task definition ────────────────────────────────────────────
test('contratto: DescribeTaskDefinition — log group dal primo container, non dedotto dal nome', () => {
  const td = fixture('describe-task-definition')
  const group = td.taskDefinition.containerDefinitions[0].logConfiguration.options['awslogs-group']
  assert.ok(group.startsWith('/ecs/'), `log group inatteso: ${group}`)
  assert.ok(td.taskDefinition.revision > 0)
})

test('contratto: il tag immagine è nudo (senza ":") e accorciato se è uno sha', () => {
  const td = fixture('describe-task-definition')
  const tag = imageTag(td.taskDefinition.containerDefinitions[0].image)
  assert.ok(tag && !tag.startsWith(':'), `il ":" davanti rompeva il confronto con la versione attesa: ${tag}`)
  // uno sha di commit completo (40 cifre) in card va accorciato, altrimenti sfonda il bordo
  assert.equal(displayTag('0e89c2198d288ec96ee8822b14f82c868c83ff20').length, 8)
  assert.equal(displayTag(tag), tag, 'un tag già corto resta intero')
})

// ── La forma su cui si regge "com’è andata l’ultima run" ───────────────────────────────────────
test('contratto: DescribeLogStreams — uno stream per esecuzione, il più recente è l’ultima run', () => {
  const s = fixture('describe-log-streams')
  assert.ok(s.logStreams.length >= 1)
  for (const st of s.logStreams) {
    assert.ok(st.logStreamName.split('/').length >= 2, 'nome nella forma <famiglia>/<container>/<taskId>')
    assert.equal(typeof st.lastEventTimestamp, 'number')
  }
  const scelto = pickLastRun(s.logStreams, 0)
  const atteso = s.logStreams.reduce((a, b) => (b.lastEventTimestamp > a.lastEventTimestamp ? b : a))
  assert.equal(scelto.stream, atteso.logStreamName)
  assert.equal(scelto.ran, true)
})

test('contratto: con DescribeLogStreams basta cercare nell’ultimo stream (2 chiamate)', async () => {
  const streams = fixture('describe-log-streams')
  const p2 = fixture('filter-log-events-page2') // lo stream più recente contiene il traceback
  const out = await runOutcome(logsDaFixture([p2], streams), '/gruppo', 0)
  assert.deepEqual(out, { ran: true, failed: true })
})

test('contratto: scheduleExpressionToMinutes legge l’espressione registrata', () => {
  const s = fixture('get-schedule-timezone')
  const min = scheduleExpressionToMinutes(s.ScheduleExpression)
  assert.ok(min === null || min > 0, `minuti inattesi: ${min}`)
})
