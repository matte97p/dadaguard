import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizzaAllarme,
  decidi,
  letturaStoria,
  testoAllarme,
  riassumiRighe,
  ripulisci,
  forma,
  finestraLog,
  filtroDaPattern,
  contoDaId,
  etichettaAmbiente,
  primaFrase,
  testoLog,
  gestisci,
  logGroupDi,
  zittito,
  ritmoDaSerie,
  durata,
  testoContesto,
} from '../server/notify/allarmi.js'
import { makeT } from '../server/i18n.js'

// L'evento come lo manda EventBridge (`CloudWatch Alarm State Change`), ridotto ai campi che servono.
const evento = ({ nome = 'acme-production-ecs-backend-memoria', stato = 'ALARM', prima = 'OK', motivo = 'Threshold Crossed', descrizione = 'ECS backend: one task above 97% of its memory. Fix: check the logs.', dimensioni = { ClusterName: 'acme-production', ServiceName: 'backend' }, namespace = 'AWS/ECS', metrica = 'MemoryUtilization', reasonData = null } = {}) => ({
  id: 'ev-1',
  source: 'aws.cloudwatch',
  'detail-type': 'CloudWatch Alarm State Change',
  account: '111111111111',
  region: 'eu-central-1',
  time: '2026-10-21T07:51:08Z',
  resources: [`arn:aws:cloudwatch:eu-central-1:111111111111:alarm:${nome}`],
  detail: {
    alarmName: nome,
    state: { value: stato, reason: motivo, timestamp: '2026-10-21T07:51:08.146+0000', ...(reasonData ? { reasonData: JSON.stringify(reasonData) } : {}) },
    previousState: { value: prima },
    configuration: { description: descrizione, metrics: [{ id: 'm1', metricStat: { metric: { namespace, name: metrica, dimensions: dimensioni }, period: 60, stat: 'Maximum' } }] },
  },
})

test('normalizzaAllarme: un cambio di stato diventa l allarme che serve', () => {
  const a = normalizzaAllarme(JSON.stringify(evento({ reasonData: { evaluatedDatapoints: [{ timestamp: '2026-10-21T07:46:00Z' }, { timestamp: '2026-10-21T07:48:00Z' }] } })))
  assert.equal(a.nome, 'acme-production-ecs-backend-memoria')
  assert.equal(a.stato, 'ALARM')
  assert.equal(a.prima, 'OK')
  assert.equal(a.conto, '111111111111')
  assert.deepEqual(a.metriche[0].dimensioni, { ClusterName: 'acme-production', ServiceName: 'backend' })
  assert.equal(a.valutati.length, 2)
})

test('normalizzaAllarme: tutto il resto è null', () => {
  assert.equal(normalizzaAllarme('non json'), null)
  assert.equal(normalizzaAllarme({ source: 'aws.ecs', 'detail-type': 'ECS Deployment State Change' }), null)
  assert.equal(normalizzaAllarme({ ...evento(), detail: { alarmName: 'x', state: { value: 'BOH' } } }), null)
})

test('decidi: acceso, rientro, buco di dati', () => {
  assert.deepEqual(decidi(normalizzaAllarme(evento())), { tipo: 'acceso', emoji: '🚨' })
  assert.deepEqual(decidi(normalizzaAllarme(evento()), { severita: 'low' }), { tipo: 'acceso', emoji: '⚠️' })
  assert.deepEqual(decidi(normalizzaAllarme(evento({ stato: 'OK', prima: 'ALARM' })), { storia: { allarmeNatoSenzaDati: false } }), { tipo: 'rientro', emoji: '✅' })
  assert.deepEqual(decidi(normalizzaAllarme(evento({ stato: 'INSUFFICIENT_DATA' }))), { tipo: 'senzaDati', emoji: '⚠️' })
})

test('decidi: il primo OK di un allarme appena nato non è un rientro', () => {
  const a = normalizzaAllarme(evento({ stato: 'OK', prima: 'INSUFFICIENT_DATA' }))
  assert.equal(decidi(a, { storia: { primaDelBuco: null, allarmeNatoSenzaDati: false } }), null)
})

test('decidi: ALARM → buco → OK è un rientro vero', () => {
  const a = normalizzaAllarme(evento({ stato: 'OK', prima: 'INSUFFICIENT_DATA' }))
  assert.deepEqual(decidi(a, { storia: { primaDelBuco: 'ALARM', allarmeNatoSenzaDati: false } }), { tipo: 'rientro', emoji: '✅' })
})

test('decidi: un allarme che non ha mai visto dati è ℹ️, e il suo OK si tace', () => {
  const nato = normalizzaAllarme(evento({ prima: 'INSUFFICIENT_DATA', motivo: 'Threshold Crossed: no datapoints were received for 3 periods and 3 missing datapoints were treated as [Breaching].' }))
  assert.equal(decidi(nato).tipo, 'nuovo')
  const ok = normalizzaAllarme(evento({ stato: 'OK', prima: 'ALARM' }))
  assert.equal(decidi(ok, { storia: { allarmeNatoSenzaDati: true } }), null)
  // Con anche un solo punto nella finestra è un guasto vero.
  const vero = normalizzaAllarme(evento({ prima: 'INSUFFICIENT_DATA', motivo: 'no datapoints were received for 3 periods and 2 missing datapoints' }))
  assert.equal(decidi(vero).tipo, 'acceso')
})

test('decidi: gli allarmi di autoscaling non si dicono', () => {
  assert.equal(decidi(normalizzaAllarme(evento({ nome: 'TargetTracking-service/acme/backend-AlarmHigh-abc' }))), null)
})

test('letturaStoria: lo stato prima del buco e l ultimo ALARM nato senza dati', () => {
  const voce = (vecchio, nuovo, motivo = '') => ({ HistoryData: JSON.stringify({ oldState: { stateValue: vecchio }, newState: { stateValue: nuovo, stateReason: motivo } }) })
  assert.deepEqual(letturaStoria([voce('INSUFFICIENT_DATA', 'OK'), voce('ALARM', 'INSUFFICIENT_DATA'), voce('OK', 'ALARM')]), { primaDelBuco: 'ALARM', allarmeNatoSenzaDati: false })
  assert.deepEqual(letturaStoria([voce('INSUFFICIENT_DATA', 'ALARM', 'no datapoints were received for 2 periods and 2 missing datapoints')]), { primaDelBuco: null, allarmeNatoSenzaDati: true })
})

test('testoAllarme: la riga del canale, in inglese, senza trattini lunghi', () => {
  const t = makeT('en')
  const a = normalizzaAllarme(evento())
  const s = testoAllarme(a, decidi(a), { ambiente: 'production', t })
  assert.match(s, /^🚨 `ecs-backend-memoria` \[PROD\] alarm firing: ECS backend: one task above 97% of its memory\. Fix: check the logs\. · <https:\/\/eu-central-1\.console\.aws\.amazon\.com\/cloudwatch\/home\?region=eu-central-1#alarmsV2:alarm\/acme-production-ecs-backend-memoria\|alarm>$/)
  assert.doesNotMatch(s, /—/)
  const r = normalizzaAllarme(evento({ stato: 'OK', prima: 'ALARM' }))
  // Sul rientro solo la prima frase: il resto parla del guasto.
  assert.match(testoAllarme(r, { tipo: 'rientro', emoji: '✅' }, { ambiente: 'production', t }), /^✅ `ecs-backend-memoria` \[PROD\] back to normal: ECS backend: one task above 97% of its memory · /)
})

test('primaFrase', () => {
  assert.equal(primaFrase('Checks the dumps. If it fails, look.'), 'Checks the dumps')
  assert.equal(primaFrase('No full stop'), 'No full stop')
})

test('ripulisci: niente query string, email, token, jwt', () => {
  const s = ripulisci('GET /api/x?token=abc&u=1 by mario.rossi@example.com Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl key abcd1234efgh5678ijkl9012mnop3456qrst')
  assert.doesNotMatch(s, /token=abc|mario\.rossi|eyJhbGciOi|abcd1234efgh/)
  assert.match(s, /\?…/)
  assert.match(s, /\[email\]/)
  assert.match(s, /\[jwt\]/)
  assert.match(s, /\[token\]/)
})

test('ripulisci: query, parametri e credenziali non arrivano in chat', () => {
  const sql = ripulisci("ERROR (psycopg.errors.QueryCanceled) canceling statement due to statement timeout [SQL: SELECT * FROM tenders WHERE name = %(n)s] [parameters: {'n': 'Fornitura Comune di Roma'}] (Background on this error at: https://sqlalche.me/e/20/e3q8)")
  assert.equal(sql, 'ERROR (psycopg.errors.QueryCanceled) canceling statement due to statement timeout')
  const dsn = ripulisci('could not connect to postgresql://app:Sup3rS3cret@db.internal:5432/app password=hunter2 api_key: "abc"')
  assert.doesNotMatch(dsn, /Sup3rS3cret|hunter2|"abc"/)
  assert.match(dsn, /:\/\/\*\*\*@db\.internal/)
  // I valori lunghi fra apici sono dati, non il tipo di errore.
  assert.equal(ripulisci("KeyError: 'Fornitura di arredi per la scuola media'"), "KeyError: '…'")
  // Il markup di Slack si scappa.
  assert.equal(ripulisci('a <b> & c'), 'a &lt;b&gt; &amp; c')
})

test('forma: righe uguali a meno di numeri e id hanno la stessa forma', () => {
  assert.equal(forma('2026-10-21 07:51:16,669 Child process [32] died'), forma('2026-10-21 08:01:02,001 Child process [3409] died'))
  assert.equal(forma('job 3f2a9c1e-1111-2222-3333-444455556666 failed'), forma('job aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee failed'))
})

test('riassumiRighe: gruppi dal più numeroso, e le 5xx per rotta', () => {
  const righe = [
    { message: 'INFO: Child process [32] died', stream: 'backend/backend/b7dd03d3215f' },
    { message: 'ERROR timeout calling upstream 1', stream: 's' },
    { message: 'ERROR timeout calling upstream 2', stream: 's' },
    { message: 'INFO: 1.2.3.4:0 - "POST /api/run?x=1 HTTP/1.1" 504 Gateway Timeout', stream: 's' },
    { message: 'INFO: 1.2.3.4:0 - "POST /api/run HTTP/1.1" 504 Gateway Timeout', stream: 's' },
  ]
  const r = riassumiRighe(righe)
  assert.equal(r.errori[0].n, 2)
  assert.match(r.errori[0].esempio, /timeout calling upstream/)
  assert.equal(r.errori[1].n, 1)
  assert.deepEqual(r.rotte, [{ rotta: 'POST /api/run 504', n: 2 }])
})

test('riassumiRighe: un traceback concatenato dice la causa, una volta per catena', () => {
  const catena = [
    'Traceback (most recent call last):',
    '  File "/app/.venv/lib/python3.12/site-packages/starlette/_exception_handler.py", line 87, in _handle_exception',
    'asyncpg.exceptions.QueryCanceledError: canceling statement due to statement timeout',
    'The above exception was the direct cause of the following exception:',
    "sqlalchemy.exc.DBAPIError: (sqlalchemy.dialects.postgresql.asyncpg.Error) <class 'asyncpg.exceptions.QueryCanceledError'>: canceling statement due to statement timeout",
    "acme.clients.bi.BIQueryTimeoutError: (sqlalchemy.dialects.postgresql.asyncpg.Error) <class 'asyncpg.exceptions.QueryCanceledError'>: canceling statement due to statement timeout",
    '    ^^^^^^^^^^',
  ]
  const r = riassumiRighe([...catena, ...catena].map((message) => ({ message, stream: 's' })))
  assert.equal(r.errori.length, 1)
  assert.equal(r.errori[0].n, 2)
  assert.equal(r.errori[0].esempio, 'asyncpg.exceptions.QueryCanceledError: canceling statement due to statement timeout')
})

test('riassumiRighe: niente righe INFO del logging, e l esempio senza data e contesto', () => {
  const r = riassumiRighe([
    { message: '2026-03-10 09:01:45,649 - acme.chat - INFO - [7b577a0a:background:-:-] - Upstream closed (reason=idle_timeout)' },
    { message: '2026-03-10 09:05:09,787 - acme.server - WARNING - [a1b2c3d4:request:ab12:cd34] - BI query hit the statement timeout: POST /api/run' },
  ])
  assert.deepEqual(r.errori.map((g) => g.esempio), ['acme.server - WARNING - BI query hit the statement timeout: POST /api/run'])
})

test('testoLog: prima le rotte in 5xx, poi gli errori', () => {
  const finestra = { da: Date.parse('2026-10-21T07:44:00Z'), a: Date.parse('2026-10-21T07:52:08Z') }
  const riassunto = riassumiRighe([
    { message: 'ERROR timeout calling upstream', stream: 's' },
    { message: 'INFO: 1.2.3.4:0 - "POST /api/run HTTP/1.1" 504 Gateway Timeout', stream: 's' },
  ])
  const s = testoLog({ logGroup: 'g', finestra, riassunto, regione: 'eu-central-1', t: makeT('en') })
  assert.match(s, /UTC:\n• 1× 5xx responses on `POST \/api\/run 504`\n• 1× `ERROR timeout calling upstream`/)
})

test('testoLog: testata, righe col task, link', () => {
  const t = makeT('en')
  const finestra = { da: Date.parse('2026-10-21T07:44:00Z'), a: Date.parse('2026-10-21T07:52:08Z') }
  const s = testoLog({ logGroup: '/ecs/acme-production/backend', finestra, riassunto: riassumiRighe([{ message: 'Child process [32] died', stream: 'backend/backend/b7dd03d3215f' }]), regione: 'eu-central-1', t })
  assert.match(s, /^Logs from `\/ecs\/acme-production\/backend`, 07:44 to 07:52 UTC:\n• 1× `Child process \[32\] died` \(b7dd03\)\n<https:\/\/eu-central-1\.console\.aws\.amazon\.com\/cloudwatch\/home/)
  assert.match(testoLog({ logGroup: 'g', finestra, riassunto: { errori: [], rotte: [] }, regione: 'eu-central-1', t }), /no error lines in that window/)
})

test('finestraLog: dal primo punto valutato, meno un margine, a un minuto dopo', () => {
  const a = normalizzaAllarme(evento({ reasonData: { evaluatedDatapoints: [{ timestamp: '2026-10-21T07:46:00Z' }, { timestamp: '2026-10-21T07:48:00Z' }] } }))
  const f = finestraLog(a)
  assert.equal(new Date(f.da).toISOString(), '2026-10-21T07:44:00.000Z')
  assert.equal(new Date(f.a).toISOString(), '2026-10-21T07:52:08.146Z')
  // Senza punti, i quindici minuti prima.
  const g = finestraLog(normalizzaAllarme(evento()))
  assert.equal(new Date(g.da).toISOString(), '2026-10-21T07:36:08.146Z')
})

test('filtroDaPattern: le forme semplici sì, le altre no', () => {
  assert.equal(filtroDaPattern('"ERROR" "upload failed"'), '@message like "ERROR" and @message like "upload failed"')
  assert.equal(filtroDaPattern('Traceback'), '@message like "Traceback"')
  assert.equal(filtroDaPattern('{ $.level = "error" }'), null)
  assert.equal(filtroDaPattern('?ERROR ?WARN'), null)
  assert.equal(filtroDaPattern(''), null)
})

test('contoDaId ed etichettaAmbiente', () => {
  const accounts = { 'acme-production': { accountId: '111111111111' }, staging: { roleArn: 'arn:aws:iam::222222222222:role/dadaguard-readonly' } }
  assert.equal(contoDaId(accounts, '111111111111').chiave, 'acme-production')
  assert.equal(contoDaId(accounts, '222222222222').chiave, 'staging')
  assert.equal(contoDaId(accounts, '333333333333'), null)
  assert.equal(etichettaAmbiente('acme-production', 'x'), 'production')
  assert.equal(etichettaAmbiente(undefined, 'acme-staging-redis-001-cpu'), 'staging')
})

test('logGroupDi: dal metric filter, col suo pattern', async () => {
  const a = normalizzaAllarme(evento({ namespace: 'Acme/Jobs', metrica: 'UploadFailed', dimensioni: {} }))
  const logs = { send: async () => ({ metricFilters: [{ logGroupName: '/aws/lambda/acme-production-upload', filterPattern: '"upload failed"' }] }) }
  assert.deepEqual(await logGroupDi(a, { deps: { logs } }), { logGroup: '/aws/lambda/acme-production-upload', pattern: '"upload failed"' })
})

test('logGroupDi: da un servizio ECS nelle dimensioni', async () => {
  const a = normalizzaAllarme(evento())
  let chiesto
  const resolveLogGroup = async (s) => ((chiesto = s.aws), { logGroup: '/ecs/acme-production/backend' })
  assert.deepEqual(await logGroupDi(a, { deps: { logs: { send: async () => ({}) }, resolveLogGroup } }), { logGroup: '/ecs/acme-production/backend', pattern: null })
  assert.deepEqual(chiesto, { type: 'ecs', cluster: 'acme-production', service: 'backend' })
})

test('logGroupDi: un cron dal servizio il cui nome apre quello dell allarme', async () => {
  const a = normalizzaAllarme(evento({ nome: 'acme-production-cron-report-nessun-successo', namespace: 'Acme/Cron', metrica: 'Heartbeat', dimensioni: { Job: 'report' } }))
  const servizi = [
    { name: 'report', aws: { type: 'lambda', function: 'acme-production-cron-report' } },
    { name: 'rep', aws: { type: 'lambda', function: 'acme-production-cron-rep' } },
  ]
  const logs = { send: async () => ({ metricFilters: [] }) }
  const resolveLogGroup = async (s) => ({ logGroup: `/aws/lambda/${s.aws.function}` })
  assert.deepEqual(await logGroupDi(a, { servizi, deps: { logs, resolveLogGroup } }), { logGroup: '/aws/lambda/acme-production-cron-report', pattern: null })
})

// `gestisci` con tutto finto: cosa parte, dove, e il thread.
const finti = ({ tag = [], storia = [], allarme = { ActionsEnabled: true, AlarmActions: ['arn:aws:sns:eu-central-1:1:t'] }, ritmo = null, rilascio = null } = {}) => {
  const inviati = []
  return {
    inviati,
    deps: {
      servizi: { accounts: { 'acme-production': { accountId: '111111111111', roleArn: 'arn:aws:iam::111111111111:role/r' } }, services: [] },
      cw: { send: async (c) => (c.constructor.name === 'ListTagsForResourceCommand' ? { Tags: tag } : c.constructor.name === 'DescribeAlarmsCommand' ? { MetricAlarms: [allarme] } : { AlarmHistoryItems: storia }) },
      logGroupDi: async () => ({ logGroup: '/ecs/acme-production/backend', pattern: null }),
      leggiRighe: async () => [{ message: 'Child process [32] died', stream: 'backend/backend/b7dd03d3' }],
      ritmoMetrica: async () => ritmo,
      ultimoRilascio: async () => rilascio,
      chiamaSlack: async (_m, corpo) => (inviati.push({ via: 'bot', ...corpo }), { ts: '123.456' }),
      postSlack: async (hook, p) => (inviati.push({ via: 'hook', hook, ...p }), true),
    },
  }
}
const cfg = { lang: 'en', canale: 'CMAIN', canaleData: 'CDATA', botToken: 'xoxb', webhook: 'https://hooks.example/x', squadre: {}, publicUrl: null }

test('gestisci: acceso → riga nel canale principale e log nel thread', async () => {
  const f = finti()
  assert.equal(await gestisci(normalizzaAllarme(evento()), cfg, f.deps), true)
  assert.equal(f.inviati.length, 2)
  assert.equal(f.inviati[0].channel, 'CMAIN')
  assert.match(f.inviati[0].text, /^🚨 `ecs-backend-memoria` \[PROD\] alarm firing/)
  assert.equal(f.inviati[1].thread_ts, '123.456')
  assert.match(f.inviati[1].text, /Child process \[32\] died/)
})

test('gestisci: acceso → il contesto sotto il titolo', async () => {
  const a = normalizzaAllarme(evento())
  const f = finti({ ritmo: { ultime: 40, media: 5.5 }, rilascio: { servizio: 'api', quando: Date.parse(a.quando) - 15 * 3_600_000 } })
  await gestisci(a, cfg, f.deps)
  assert.match(f.inviati[0].text, /alarm firing.*\nLast 24h: 40 · average per 24h over the previous 7 days: 5\.5\nLast deploy of `api`: 15h before the alarm/)
})

test('gestisci: tag team=data → canale data', async () => {
  const f = finti({ tag: [{ Key: 'team', Value: 'data' }] })
  await gestisci(normalizzaAllarme(evento()), cfg, f.deps)
  assert.equal(f.inviati[0].channel, 'CDATA')
})

test('gestisci: senza tag decide la regola delle squadre sul nome', async () => {
  const f = finti()
  await gestisci(normalizzaAllarme(evento({ nome: 'acme-production-scraping-fasi-x' })), { ...cfg, squadre: { data: ['scraping-*'] } }, f.deps)
  assert.equal(f.inviati[0].channel, 'CDATA')
})

test('gestisci: rientro senza thread, primo OK di un allarme nuovo taciuto', async () => {
  const f = finti()
  await gestisci(normalizzaAllarme(evento({ stato: 'OK', prima: 'ALARM' })), cfg, f.deps)
  assert.equal(f.inviati.length, 1)
  assert.match(f.inviati[0].text, /^✅/)
  const g = finti()
  assert.equal(await gestisci(normalizzaAllarme(evento({ stato: 'OK', prima: 'INSUFFICIENT_DATA' })), cfg, g.deps), true)
  assert.equal(g.inviati.length, 0)
})

test('gestisci: senza bot si usa il webhook, coi log a capo', async () => {
  const f = finti()
  await gestisci(normalizzaAllarme(evento()), { ...cfg, botToken: null }, f.deps)
  assert.equal(f.inviati.length, 1)
  assert.equal(f.inviati[0].via, 'hook')
  assert.match(f.inviati[0].text, /alarm firing[^\n]*\nLogs from/)
})

test('gestisci: bot giù e nessun webhook → false, si riprova', async () => {
  const f = finti()
  f.deps.chiamaSlack = async () => {
    throw new Error('slack chat.postMessage: not_in_channel')
  }
  assert.equal(await gestisci(normalizzaAllarme(evento()), { ...cfg, webhook: null }, f.deps), false)
})

test('zittito: notifiche spente o nessuna azione', () => {
  assert.equal(zittito({ ActionsEnabled: false, AlarmActions: ['arn:aws:sns:x'] }), true)
  assert.equal(zittito({ ActionsEnabled: true, AlarmActions: [], OKActions: [] }), true)
  assert.equal(zittito({ ActionsEnabled: true, AlarmActions: ['arn:aws:sns:x'] }), false)
})

test('zittito: senza azioni ma col tag team parla, con le notifiche spente no', () => {
  assert.equal(zittito({ ActionsEnabled: true, AlarmActions: [] }, { team: 'data' }), false)
  assert.equal(zittito({ ActionsEnabled: true, AlarmActions: [] }, { team: ' ' }), true)
  assert.equal(zittito({ ActionsEnabled: false, AlarmActions: [] }, { team: 'data' }), true)
})

test('gestisci: un allarme zittito non si dice, e la coda lo cancella', async () => {
  const f = finti({ allarme: { ActionsEnabled: false, AlarmActions: ['arn:aws:sns:x'] } })
  assert.equal(await gestisci(normalizzaAllarme(evento()), cfg, f.deps), true)
  assert.equal(f.inviati.length, 0)
})

test('gestisci: senza azioni SNS ma col tag team si dice nel canale della squadra', async () => {
  const f = finti({ tag: [{ Key: 'team', Value: 'data' }], allarme: { ActionsEnabled: true, AlarmActions: [] } })
  assert.equal(await gestisci(normalizzaAllarme(evento()), cfg, f.deps), true)
  assert.equal(f.inviati[0].channel, 'CDATA')
})

test('ritmoDaSerie: le ultime 24 ore contro la media delle sette finestre prima, le ore vuote valgono zero', () => {
  const fine = Date.parse('2026-03-10T10:00:00Z')
  const h = (ore) => new Date(fine - ore * 3_600_000)
  // 1h e 23h prima della fine: nelle ultime 24 ore. 25h e 49h: la seconda e la terza finestra. 200h: fuori.
  const serie = { Timestamps: [h(1), h(23), h(25), h(49), h(200)], Values: [30, 10, 7, 7, 100] }
  assert.deepEqual(ritmoDaSerie(serie, fine), { ultime: 40, media: 2 })
  assert.deepEqual(ritmoDaSerie(undefined, fine), { ultime: 0, media: 0 })
})

test('durata: minuti, ore, giorni', () => {
  assert.equal(durata(3 * 60_000), '3 min')
  assert.equal(durata(15 * 3_600_000), '15h')
  assert.equal(durata(3 * 86_400_000), '3d')
})

test('testoContesto: ultimo errore, ritmo, rilascio', () => {
  const t = makeT('en')
  const quando = '2026-03-10T09:12:00Z'
  const righe = testoContesto({
    ultima: Date.parse('2026-03-10T09:09:00Z'),
    ritmo: { ultime: 40, media: 5.5 },
    rilascio: { servizio: 'api', quando: Date.parse('2026-03-09T17:05:00Z') },
    quando,
    t,
  })
  assert.deepEqual(righe, [
    'Last error in the logs: 09:09 UTC, 3 min before the alarm',
    'Last 24h: 40 · average per 24h over the previous 7 days: 5.5',
    'Last deploy of `api`: 16h before the alarm (09/03 17:05 UTC)',
  ])
  assert.deepEqual(testoContesto({ ultima: Date.parse('2026-03-10T09:11:30Z'), quando, t }), ['Last error in the logs: 09:11 UTC, still happening when the alarm fired'])
  assert.deepEqual(testoContesto({ quando, t }), [])
})
