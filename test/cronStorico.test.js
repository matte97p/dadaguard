// Lo storico dei cron (vista «Andamento» della pagina Cron). I guasti che questi test tengono fuori sono
// tutti di quelli che si leggono come dati veri: uno scatto delle 23:59 partito alle 00:01 contato come
// saltato, un cron nato la settimana scorsa con tre settimane di «saltate», le fasce oltre la retention
// dei log lette come «nessuna corsa», una corsa ECS di cui non si sa l'esito contata come riuscita, e
// una percentuale che dice 100% con un fallimento dentro.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs'
import { ECSClient } from '@aws-sdk/client-ecs'
import { espandiCron, cadenzaRate } from '../server/util/nextrun.js'
import {
  grigliaFuso,
  queryLambda,
  serieLambda,
  attesePerFascia,
  saltatePerConteggio,
  saltatePerScatto,
  rigaEcs,
  rigaLambda,
  rispostaStorico,
  streamDelJob,
  leggiStoricoCron,
  giorniStorico,
} from '../server/cronStorico.js'
import { griglia } from '../shared/tempiSerie.js'
import { quantilePesato, serieCron, kpiCron, righeTabella, perCron, rallentato, sommaFasce } from '../shared/cronSerie.js'
import { vistaIniziale } from '../web/rilasci.js'
import { demoStoricoCron } from '../server/demo.js'

const MIN = 60_000
const ORA = 60 * MIN
const G = 24 * ORA
// Martedi' 20 ottobre 2026, 15:30 a Roma (13:30 UTC, ora legale).
const ADESSO = Date.UTC(2026, 9, 20, 13, 30)

test('espandiCron: gli scatti nel fuso dello schedule, anche attraverso il cambio dell’ora', () => {
  // Il 25/10/2026 Roma torna all'ora solare: le 06:00 locali passano dalle 04:00 alle 05:00 UTC.
  const s = espandiCron('cron(0 6 * * ? *)', Date.UTC(2026, 9, 24, 0, 0), Date.UTC(2026, 9, 27, 0, 0), 'Europe/Rome')
  assert.deepEqual(s, [Date.UTC(2026, 9, 24, 4, 0), Date.UTC(2026, 9, 25, 5, 0), Date.UTC(2026, 9, 26, 5, 0)])
  // Feriali: venerdi' 23 e lunedi' 26, il fine settimana no.
  const f = espandiCron('cron(0 9 ? * MON-FRI *)', Date.UTC(2026, 9, 23, 0, 0), Date.UTC(2026, 9, 27, 0, 0))
  assert.deepEqual(f, [Date.UTC(2026, 9, 23, 9, 0), Date.UTC(2026, 9, 26, 9, 0)])
  assert.equal(espandiCron('cron(*/15 * * * ? *)', Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21)).length, 96)
  // Un fuso a mezz'ora: le 09:00 di Kolkata sono le 03:30 UTC.
  assert.deepEqual(espandiCron('cron(0 9 * * ? *)', Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21), 'Asia/Kolkata'), [Date.UTC(2026, 9, 20, 3, 30)])
  assert.equal(espandiCron('rate(1 hour)', 0, G), null)
  assert.equal(espandiCron('cron(0 0 L * ? *)', 0, G), null)
  assert.equal(cadenzaRate('rate(15 minutes)'), 15 * MIN)
  assert.equal(cadenzaRate('rate(1 day)'), G)
  assert.equal(cadenzaRate('cron(0 6 * * ? *)'), null)
})

test('grigliaFuso: le fasce sulla mezzanotte di chi guarda, non su quella del server', () => {
  const g = grigliaFuso({ giorni: 30, ora: ADESSO, tz: 'Europe/Rome' })
  assert.equal(g.punti, 30)
  assert.equal(g.passoMs, G)
  // Mezzanotte di Roma = 22:00 UTC del giorno prima.
  assert.equal(new Date(g.inizio).getUTCHours(), 22)
  assert.ok(ADESSO >= g.inizio + 29 * G && ADESSO < g.inizio + 30 * G, 'l’ultima fascia contiene adesso')
  const s = grigliaFuso({ giorni: 7, ora: ADESSO, tz: 'Europe/Rome' })
  assert.equal(s.punti, 28)
  assert.equal(s.inizio + s.punti * s.passoMs, Date.UTC(2026, 9, 20, 16, 0), 'le 15:30 di Roma stanno nella fascia 12-18')
  // Senza fuso valido si ricade sull'ora del server, come la pagina Tempi.
  assert.deepEqual(grigliaFuso({ giorni: 7, ora: ADESSO, tz: 'Marte/Olympus' }), griglia({ giorni: 7, ora: ADESSO }))
  assert.equal(giorniStorico('30'), 30)
  assert.equal(giorniStorico('90'), 7, 'fuori dai valori ammessi: la settimana')
})

test('queryLambda e serieLambda: sei metriche a funzione, i periodi giusti, i buchi al posto giusto', () => {
  const g = grigliaFuso({ giorni: 7, ora: ADESSO, tz: 'Europe/Rome' })
  const q = queryLambda(['a', 'b'], g)
  assert.equal(q.length, 12)
  assert.ok(q.every((x) => /^f[01][a-z]$/.test(x.Id)))
  assert.equal(q.find((x) => x.Id === 'f0n').MetricStat.Period, 21_600)
  assert.equal(q.find((x) => x.Id === 'f1x').MetricStat.Period, 7 * 86_400)
  assert.equal(q.find((x) => x.Id === 'f1s').MetricStat.Stat, 'p90')
  const t = (i) => new Date(g.inizio + i * g.passoMs)
  const s = serieLambda(
    [
      { Id: 'f0n', Timestamps: [t(27), t(3)], Values: [4, 2] },
      { Id: 'f0e', Timestamps: [t(27)], Values: [1] },
      { Id: 'f0m', Timestamps: [t(27)], Values: [1200.4] },
      { Id: 'f0w', Timestamps: [t(0)], Values: [1500] },
    ],
    2,
    g,
  )
  assert.equal(s[0].corse[27], 4)
  assert.equal(s[0].corse[3], 2)
  assert.equal(s[0].corse[10], 0, 'nessun punto di Invocations = nessuna corsa')
  assert.equal(s[0].fallite[27], 1)
  assert.equal(s[0].p50[27], 1200)
  assert.equal(s[0].p50[3], null, 'nessun punto di Duration = durata che non si sa')
  assert.deepEqual(s[0].finestra, { p50: 1500, p90: null })
  assert.equal(s[1].corse[27], 0)
})

test('saltate per conteggio: dalla prima corsa vista in poi, null dove il rate non si sa', () => {
  const g = { inizio: 0, passoMs: 6 * ORA, punti: 4 }
  // Un cron nato nella seconda fascia: la prima non e' «saltata».
  assert.deepEqual(saltatePerConteggio([6, 6, 6, 6], [0, 6, 4, 6]), [null, 0, 2, 0])
  // Mai partito: le saltate sono tutte, ed e' la risposta giusta.
  assert.deepEqual(saltatePerConteggio([1, 1, 1, null], [0, 0, 0, 0]), [1, 1, 1, null])
  const r = attesePerFascia({ scheduleExpr: 'rate(1 hour)' }, g, { ora: 4 * 6 * ORA - ORA })
  assert.deepEqual(r.attese, [6, 6, 6, null], 'la fascia in corso di un rate non si sa')
  assert.deepEqual(attesePerFascia({ scheduleExpr: 'rate(7 hours)' }, g, { ora: 30 * ORA }).attese, [null, null, null, null])
})

test('saltate per scatto: lo scatto delle 23:59 partito alle 00:01 non e’ saltato', () => {
  const g = { inizio: 0, passoMs: G, punti: 3 }
  const scatti = [G - MIN, 2 * G - MIN]
  // Il primo parte due minuti dopo, nella fascia dopo; il secondo non parte.
  const inizi = [G + MIN]
  const s = saltatePerScatto(scatti, inizi, [0, 1, 0], g)
  assert.deepEqual(s, [null, 1, 0], 'la fascia prima della prima corsa non conta; il secondo scatto si')
  // Fasce fuori dallo storico letto: null, non zero.
  assert.deepEqual(saltatePerScatto([G / 2, G + G / 2], [], [null, 0, 0], g, { coperto: [false, true, true] }), [null, 1, 0])
})

test('riga ECS senza esito: non letta, mai riuscita; le fasce prima della retention restano vuote', () => {
  const g = grigliaFuso({ giorni: 30, ora: ADESSO, tz: 'Europe/Rome' })
  const cron = { key: 'prod/job', name: 'job', type: 'ecs-scheduled', account: 'prod', enabled: true, scheduleExpr: 'cron(0 3 * * ? *)', scheduleTz: 'Europe/Rome' }
  const scatti = espandiCron(cron.scheduleExpr, g.inizio, ADESSO, cron.scheduleTz)
  // Ogni notte tranne due notti fa, durata 30 minuti; storico dei log solo per gli ultimi 10 giorni.
  const corse = scatti
    .filter((t) => t !== scatti.at(-2))
    .map((t) => ({ startedAt: t + 2 * MIN, endedAt: t + 32 * MIN }))
    .filter((r) => r.startedAt > ADESSO - 10 * G)
  const r = rigaEcs(cron, corse, g, { ora: ADESSO, copertoDa: ADESSO - 10 * G })
  assert.equal(r.esitoLetto, false)
  assert.deepEqual(r.nonLette, r.corse)
  assert.ok(r.riuscite.every((v) => v === 0 || v == null), 'nessuna corsa ECS e’ «riuscita» per omissione')
  assert.equal(r.corse[0], null, 'oltre la retention non si sa')
  assert.equal(r.corse[29], 1)
  assert.equal(sommaFasce([r], 'saltate', g.punti).reduce((a, b) => a + (b ?? 0), 0), 1)
  assert.equal(r.finestra.p50, 30 * MIN)
  assert.equal(r.ultima.esatta, true)
  assert.ok(r.copertoDa > g.inizio)
})

test('riga Lambda e risposta: riuscite = chiamate meno errori; un cron spento senza corse non compare', () => {
  const g = { inizio: ADESSO - 2 * G, passoMs: G, punti: 2 }
  const s = { corse: [3, 2], fallite: [1, 0], p50: [100, 200], p90: [150, 250], finestra: { p50: 150, p90: 240 } }
  const r = rigaLambda({ key: 'p/a', name: 'a', type: 'lambda', account: 'p', enabled: true, scheduleExpr: 'rate(12 hours)' }, s, g, { ora: ADESSO })
  assert.deepEqual(r.riuscite, [2, 2])
  assert.deepEqual(r.saltate, [0, null], 'la fascia in corso di un rate non si sa')
  assert.equal(r.finestra.n, 5)
  assert.equal(r.ultima.esatta, false)
  const spento = rigaLambda({ key: 'p/b', name: 'b', type: 'lambda', account: 'p', enabled: false, scheduleExpr: 'rate(1 hour)' }, { ...s, corse: [0, 0], fallite: [0, 0] }, g)
  const out = rispostaStorico({ giorni: 7, g, righe: [spento, r], account: {} })
  assert.deepEqual(out.crons.map((c) => c.k), ['p/a'])
})

test('stream di un job: dal piu’ recente, ci si ferma fuori dalla finestra; col tetto si dice fin dove si e’ letto', async () => {
  const pagine = {
    undefined: { logStreams: [{ lastEventTimestamp: 1000 }, { lastEventTimestamp: 900 }], nextToken: 'p2' },
    p2: { logStreams: [{ lastEventTimestamp: 800 }, { lastEventTimestamp: 400 }], nextToken: 'p3' },
    p3: { logStreams: [{ lastEventTimestamp: 300 }] },
  }
  const chiamate = []
  const logs = { send: async (cmd) => (chiamate.push(cmd.input.nextToken), pagine[cmd.input.nextToken]) }
  const fino = await streamDelJob(logs, '/ecs/job', { da: 500 })
  assert.equal(fino.streams.length, 4)
  assert.equal(chiamate.length, 2, 'la terza pagina e’ tutta fuori dalla finestra: non si chiede')
  assert.equal(fino.troncato, false)
  const tetto = await streamDelJob(logs, '/ecs/job', { da: 0, maxPagine: 1 })
  assert.equal(tetto.troncato, true)
  assert.equal(tetto.copertoDa, 900)
})

test('giro intero con i client finti: una GetMetricData per account, stream e retention per i job', async () => {
  const conti = { metriche: 0, stream: 0, gruppi: 0, taskdef: 0, esiti: 0 }
  const cron = (o) => ({ region: 'eu-west-1', enabled: true, scheduleTz: null, ...o, key: `${o.account}/${o.name}` })
  const crons = [
    cron({ name: 'digest', type: 'lambda', account: 'prod', function: 'digest', scheduleExpr: 'cron(0 6 * * ? *)' }),
    cron({ name: 'warmer', type: 'lambda', account: 'prod', function: 'warmer', scheduleExpr: 'rate(1 hour)' }),
    cron({ name: 'crawler', type: 'ecs-scheduled', account: 'prod', taskDefinition: 'arn:aws:ecs:eu-west-1:000000000000:task-definition/crawler:3', scheduleExpr: 'cron(0 3 * * ? *)' }),
  ]
  const g = grigliaFuso({ giorni: 7, ora: ADESSO, tz: 'Europe/Rome' })
  const prima = { cw: CloudWatchClient.prototype.send, logs: CloudWatchLogsClient.prototype.send, ecs: ECSClient.prototype.send }
  CloudWatchClient.prototype.send = async function (cmd) {
    conti.metriche++
    assert.equal(cmd.input.MetricDataQueries.length, 12)
    return { MetricDataResults: [{ Id: 'f0n', Timestamps: [new Date(g.inizio + 27 * g.passoMs)], Values: [1] }] }
  }
  CloudWatchLogsClient.prototype.send = async function (cmd) {
    if (cmd.constructor.name === 'DescribeLogGroupsCommand') return conti.gruppi++, { logGroups: [{ logGroupName: '/ecs/crawler', retentionInDays: 3 }] }
    // L'esito della corsa dal suo log: c'e' una riga d'errore, quindi e' fallita.
    if (cmd.constructor.name === 'FilterLogEventsCommand') {
      assert.deepEqual(cmd.input.logStreamNames, ['cron/job/abc'])
      return conti.esiti++, { events: [{ message: 'Traceback (most recent call last):' }] }
    }
    conti.stream++
    return { logStreams: [{ logStreamName: 'cron/job/abc', firstEventTimestamp: ADESSO - ORA, lastEventTimestamp: ADESSO - 30 * MIN }] }
  }
  ECSClient.prototype.send = async function () {
    conti.taskdef++
    return { taskDefinition: { containerDefinitions: [{ name: 'job', logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/crawler', 'awslogs-stream-prefix': 'cron' } } }] }, tags: [] }
  }
  try {
    const out = await leggiStoricoCron({ prod: { label: 'Production', region: 'eu-west-1' } }, { giorni: 7, tz: 'Europe/Rome', ora: ADESSO, leggiCron: async () => ({ crons, problems: [] }) })
    assert.deepEqual(conti, { metriche: 1, stream: 1, gruppi: 1, taskdef: 1, esiti: 1 })
    const per = Object.fromEntries(out.crons.map((c) => [c.nome, c]))
    assert.equal(per.digest.corse[27], 1)
    assert.equal(per.crawler.corse.at(-1), 1)
    assert.equal(per.crawler.corse[0], null, 'oltre i tre giorni di retention non si sa')
    assert.equal(per.crawler.fallite.at(-1), 1, 'l’esito del job ECS viene dal suo log')
    assert.equal(per.crawler.nonLette.at(-1), 0)
    assert.equal(per.crawler.esitoLetto, true)
    assert.equal(out.account.prod.label, 'Production')
  } finally {
    CloudWatchClient.prototype.send = prima.cw
    CloudWatchLogsClient.prototype.send = prima.logs
    ECSClient.prototype.send = prima.ecs
  }
})

test('metriche sulla finestra rifiutate: si rilegge senza, e la durata della finestra si stima dalle fasce', async () => {
  const g = grigliaFuso({ giorni: 7, ora: ADESSO, tz: 'Europe/Rome' })
  const chiamate = []
  const prima = CloudWatchClient.prototype.send
  CloudWatchClient.prototype.send = async function (cmd) {
    const q = cmd.input.MetricDataQueries
    chiamate.push(q.length)
    if (q.some((x) => x.MetricStat.Period > g.passoMs / 1000)) throw Object.assign(new Error('period'), { name: 'ValidationError' })
    const t = (i) => new Date(g.inizio + i * g.passoMs)
    return {
      MetricDataResults: [
        { Id: 'f0n', Timestamps: [t(20), t(21)], Values: [3, 1] },
        { Id: 'f0m', Timestamps: [t(20), t(21)], Values: [1000, 9000] },
        { Id: 'f0s', Timestamps: [t(20), t(21)], Values: [2000, 9500] },
      ],
    }
  }
  try {
    const cron = { key: 'p/a', name: 'a', type: 'lambda', account: 'p', function: 'a', enabled: true, scheduleExpr: 'rate(1 hour)', region: 'eu-west-1' }
    const out = await leggiStoricoCron({ p: { label: 'P' } }, { giorni: 7, tz: 'Europe/Rome', ora: ADESSO, leggiCron: async () => ({ crons: [cron], problems: [] }) })
    assert.deepEqual(chiamate, [6, 4])
    const r = out.crons[0]
    assert.equal(r.errore, null)
    assert.deepEqual(r.finestra, { p50: 1000, p90: 9500, n: 4 }, 'la fascia da tre corse pesa tre volte')
  } finally {
    CloudWatchClient.prototype.send = prima
  }
})

test('serie e numeri della pagina: le corse senza esito contano come partite, mai come riuscite, e mai 100% con un fallimento', () => {
  const g = { inizio: 0, passoMs: G, punti: 2 }
  const lambda = { k: 'a', nome: 'a', esitoLetto: true, corse: [500, 500], riuscite: [499, 500], fallite: [1, 0], nonLette: [0, 0], saltate: [0, 0], p50: [1000, 3000], p90: [2000, 4000], finestra: { p50: 2000, p90: 3500 } }
  const ecs = { k: 'b', nome: 'b', esitoLetto: false, corse: [1, null], riuscite: [0, null], fallite: [0, null], nonLette: [1, null], saltate: [1, null], p50: [600_000, null], p90: [600_000, null], finestra: { p50: 600_000, p90: 600_000 } }
  const k = kpiCron([lambda, ecs])
  assert.equal(k.corse, 1001)
  assert.equal(k.nonLette, 1)
  assert.equal(k.noti, 1002, 'tutte le volte che doveva partire: corse piu’ saltate')
  assert.equal(k.saltate, 1)
  assert.equal(k.riuscite, 999, 'la corsa ECS non e’ fra le riuscite')
  assert.equal(k.quotaBene, 99, '1000 su 1002 non e’ «sempre»')
  assert.equal(k.tassoFallite, 1 / 1000, 'le fallite sono sulle corse con esito letto')
  // Con un cron solo la durata e' quella esatta della finestra.
  assert.deepEqual(kpiCron([lambda]).durata, { p50: 2000, p90: 3500 })
  const s = serieCron([lambda, ecs], g)
  assert.deepEqual(s.nonLette, [1, 0])
  assert.deepEqual(sommaFasce([ecs], 'corse', 2), [1, null], 'una fascia che nessuno conosce resta null')
  assert.equal(s.p50[0], 1000, 'la fascia di 500 corse pesa piu’ di quella da una')
  assert.equal(quantilePesato([{ v: 1, w: 1 }, { v: 9, w: 3 }], 0.5), 9)
  assert.equal(quantilePesato([], 0.5), null)
  // Un job con una corsa e una saltata: meta' delle volte con un problema noto, e nessuna fallita
  // inventata (il tasso delle fallite non si sa).
  assert.equal(kpiCron([ecs]).quotaBene, 50)
  assert.equal(kpiCron([ecs]).tassoFallite, null)
  assert.equal(kpiCron([]).quotaBene, null)
})

test('tabella e piccoli multipli: dal peggiore, stessa scala per tutti, il rallentamento detto', () => {
  const r = (nome, o) => ({ k: nome, nome, esitoLetto: true, corse: [1, 1, 1, 1], riuscite: [1, 1, 1, 1], fallite: [0, 0, 0, 0], nonLette: [0, 0, 0, 0], saltate: [0, 0, 0, 0], p50: [60_000, 60_000, 60_000, 60_000], finestra: { p50: 60_000 }, ...o })
  const righe = [r('a'), r('b', { fallite: [0, 1, 0, 0] }), r('c', { saltate: [0, 0, 2, 0] }), r('lento', { p50: [60_000, 60_000, 60_000, 200_000], finestra: { p50: 90_000 } })]
  assert.deepEqual(righeTabella(righe).map((x) => x.nome), ['c', 'b', 'lento', 'a'])
  assert.deepEqual(rallentato(righe[3]), { prima: 60_000, dopo: 200_000 })
  assert.equal(rallentato(r('veloce', { p50: [1000, 1000, 1000, 3000] })), null, 'da uno a tre secondi non e’ una notizia')
  const m = perCron(righe, { max: 2 })
  assert.equal(m.righe[0].nome, 'lento')
  assert.deepEqual(m.dominio, [0, 200_000])
  assert.equal(m.altri, 2)
  const ecs = righeTabella([r('job', { esitoLetto: false, saltate: [null, null, null, null] })])[0]
  assert.equal(ecs.tot.fallite, null, 'un job ECS non ha fallite: ha esito non letto')
  assert.equal(ecs.tot.saltate, null)
})

test('vista iniziale: andamento, tranne i link che portano un cron o una ricerca', () => {
  assert.equal(vistaIniziale('', null), 'elenco')
  assert.equal(vistaIniziale('', 'andamento'), 'andamento')
  assert.equal(vistaIniziale('?cron=prod/job', 'andamento'), 'elenco')
  assert.equal(vistaIniziale('?q=crawler', null), 'elenco')
  assert.equal(vistaIniziale('?vista=andamento&cron=prod/job', null), 'andamento')
  assert.equal(vistaIniziale('', 'elenco'), 'elenco')
  assert.equal(vistaIniziale('', 'boh'), 'elenco')
})

test('demo: deterministica, passa dalle funzioni vere, con fallite, saltate e un job rallentato', () => {
  const a = demoStoricoCron(30, ADESSO, 'Europe/Rome')
  const b = demoStoricoCron(30, ADESSO, 'Europe/Rome')
  assert.deepEqual({ ...a, generatedAt: 0 }, { ...b, generatedAt: 0 })
  const k = kpiCron(a.crons)
  assert.ok(k.fallite > 0 && k.saltate >= 2 && k.nonLette > 0)
  assert.ok(!a.crons.some((c) => c.nome === 'invoice-retry'), 'lo spento senza corse non compare')
  const lento = righeTabella(a.crons).find((r) => r.k === 'prod/catalog-crawler')
  assert.ok(lento.lento, 'il crawler di produzione e’ rallentato')
  assert.ok(new Set(a.crons.map((c) => c.tipo)).size === 2)
  // La settimana e il mese raccontano gli stessi giorni: le fallite della settimana ci sono nel mese.
  const s = kpiCron(demoStoricoCron(7, ADESSO, 'Europe/Rome').crons)
  assert.ok(s.fallite <= k.fallite && s.saltate <= k.saltate)
})

test('esito delle corse ECS dal log: una lettura per corsa finita, poi dalla memoria; le corse fresche aspettano', async () => {
  const { conEsito } = await import('../server/cronStorico.js')
  const letture = []
  const cerca = async (_logs, p) => (letture.push(p.logStreamNames[0]), p.logStreamNames[0] === 'ko')
  const corse = [
    { stream: 'ok', startedAt: ADESSO - 2 * ORA, endedAt: ADESSO - ORA },
    { stream: 'ko', startedAt: ADESSO - 3 * ORA, endedAt: ADESSO - 2 * ORA },
    { stream: 'fresca', startedAt: ADESSO - 10 * MIN, endedAt: ADESSO - 2 * MIN },
    { stream: 'oltre-il-tetto', startedAt: ADESSO - 5 * ORA, endedAt: ADESSO - 4 * ORA },
  ]
  const a = await conEsito(null, '/ecs/esiti', corse, ADESSO, { cerca, tetto: 2 })
  assert.deepEqual(a.map((r) => r.esito ?? null), ['ok', 'ko', null, null], 'la fresca puo’ ancora scrivere il traceback; la quarta e’ oltre il tetto')
  const b = await conEsito(null, '/ecs/esiti', corse, ADESSO, { cerca, tetto: 2 })
  assert.deepEqual(b.map((r) => r.esito ?? null), ['ok', 'ko', null, 'ok'])
  assert.deepEqual(letture, ['ok', 'ko', 'oltre-il-tetto'], 'quelle gia’ lette non si rileggono')
})
