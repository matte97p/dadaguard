// L'andamento dei servizi web (vista «Andamento» della pagina Servizi): una griglia sfasata sposta un
// picco di un'ora, una fascia senza richieste letta come «0 ms» disegna un servizio velocissimo, e un
// p90 fatto con la media dei p90 nasconde proprio il servizio lento. E le metriche si pagano: le query
// devono restare quattro per servizio, in poche chiamate, col tetto.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { ECSClient } from '@aws-sdk/client-ecs'
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2'
import {
  oreAndamento,
  grigliaAndamento,
  dimensioneTg,
  dimensioneLb,
  querieAndamento,
  blocchi,
  componiAndamento,
  payloadAndamento,
  taglia,
  andamentoServizi,
} from '../server/andamentoServizi.js'
import { quantileMisto, serieInsieme, kpiAndamento, righeAndamento, perServizioAndamento, unoSu, livelloErrori } from '../shared/serviziSerie.js'
import { fasceLarghe, riduci } from '../web/grafici.js'
import { demoAndamentoServizi } from '../server/demo.js'

const ORA = Date.UTC(2026, 9, 20, 15, 32, 10)
const MIN = 60_000

test('ore: si porta alla finestra ammessa più vicina per eccesso, il resto vale 24', () => {
  assert.equal(oreAndamento('24'), 24)
  assert.equal(oreAndamento('168'), 168)
  assert.equal(oreAndamento('720'), 720)
  assert.equal(oreAndamento('1'), 24)
  assert.equal(oreAndamento('100'), 168)
  assert.equal(oreAndamento('9999'), 720)
  assert.equal(oreAndamento('ciao'), 24)
  assert.equal(oreAndamento(undefined), 24)
})

test('griglia: 288, 168 e 120 fasce allineate al passo, l’ultima è l’ultima chiusa', () => {
  const g = grigliaAndamento(24, ORA)
  assert.equal(g.punti, 288)
  assert.equal(g.passoMs, 5 * MIN)
  assert.equal(g.inizio + g.punti * g.passoMs, Date.UTC(2026, 9, 20, 15, 30), 'la fascia 15:30-15:35 è ancora aperta e resta fuori')
  assert.equal(grigliaAndamento(168, ORA).punti, 168)
  const m = grigliaAndamento(720, ORA)
  assert.equal(m.punti, 120)
  assert.equal(m.passoMs % (300 * 1000), 0, 'oltre i 15 giorni CloudWatch vuole multipli di 300 s')
  assert.equal(m.inizio % m.passoMs, 0)
})

test('dimensioni: la coda dell’ARN, e un Network Load Balancer non vale', () => {
  assert.equal(dimensioneTg('arn:aws:elasticloadbalancing:eu-west-1:000000000000:targetgroup/api-tg/0123abcd'), 'targetgroup/api-tg/0123abcd')
  assert.equal(dimensioneLb('arn:aws:elasticloadbalancing:eu-west-1:000000000000:loadbalancer/app/pub/89ef'), 'app/pub/89ef')
  assert.equal(dimensioneLb('arn:aws:elasticloadbalancing:eu-west-1:000000000000:loadbalancer/net/nlb/89ef'), null)
  assert.equal(dimensioneTg(null), null)
})

test('query: quattro metriche per servizio, per target group o per ALB intero, in chiamate senza pagine', () => {
  const q = querieAndamento([{ lb: 'app/a/1', tg: 'targetgroup/t/2' }, { lb: 'app/b/3', tg: null }], 300)
  assert.equal(q.length, 8)
  assert.deepEqual(q.slice(0, 4).map((x) => x.Id), ['b0_p50', 'b0_p90', 'b0_errori', 'b0_richieste'])
  assert.deepEqual(q[0].MetricStat.Metric.Dimensions, [{ Name: 'LoadBalancer', Value: 'app/a/1' }, { Name: 'TargetGroup', Value: 'targetgroup/t/2' }])
  assert.deepEqual(q[4].MetricStat.Metric.Dimensions, [{ Name: 'LoadBalancer', Value: 'app/b/3' }])
  assert.deepEqual(q.map((x) => x.MetricStat.Stat).slice(0, 4), ['p50', 'p90', 'Sum', 'Sum'])
  // 288 punti x 350 query = 100.800 punti, il massimo di una risposta: oltre si paginerebbe.
  const tante = Array.from({ length: 800 }, (_, i) => ({ Id: `q${i}` }))
  assert.deepEqual(blocchi(tante, 288).map((b) => b.length), [350, 350, 100])
  assert.deepEqual(blocchi(tante, 120).map((b) => b.length), [500, 300])
})

test('composizione: conteggi assenti = zero, latenza in ms, niente latenza senza richieste', () => {
  const g = grigliaAndamento(24, ORA)
  const t = (k) => new Date(g.inizio + k * g.passoMs)
  const bersagli = [{ account: 'prod', servizio: 'api', lb: 'app/a/1', tg: 'targetgroup/t/2' }]
  const risultati = [
    { Id: 'b0_richieste', Timestamps: [t(0), t(1), t(287), t(300)], Values: [120, 0, 40, 9] },
    { Id: 'b0_errori', Timestamps: [t(0)], Values: [3] },
    { Id: 'b0_p50', Timestamps: [t(0), t(1), t(287)], Values: [0.1204, 0.5, 0.2] },
    { Id: 'b0_p90', Timestamps: [t(0), t(287)], Values: [0.4, 0.9] },
  ]
  const [s] = componiAndamento(bersagli, risultati, g)
  assert.equal(s.k, 'prod|api')
  assert.equal(s.richieste.length, 288)
  assert.deepEqual([s.richieste[0], s.richieste[2], s.richieste[287]], [120, 0, 40], 'la fascia fuori griglia non entra')
  assert.deepEqual([s.errori[0], s.errori[287]], [3, 0])
  assert.equal(s.p50[0], 120)
  assert.equal(s.p50[1], null, 'zero richieste: un tempo di risposta non c’è')
  assert.equal(s.p90[287], 900)
  assert.equal(s.p50[2], null)
  const p = payloadAndamento({ g, bersagli, risultati, trovati: 40 })
  assert.deepEqual(p.bersagli, { trovati: 40, mostrati: 1, tetto: 30 })
  assert.equal(p.metriche, 4)
})

test('tetto: ordine stabile per ambiente e nome, e quanti erano', () => {
  const b = ['web', 'api', 'zeta'].flatMap((s) => ['staging', 'prod'].map((account) => ({ account, servizio: s })))
  const { scelti, trovati } = taglia(b, 3)
  assert.equal(trovati, 6)
  assert.deepEqual(scelti.map((x) => `${x.account}/${x.servizio}`), ['prod/api', 'prod/web', 'prod/zeta'])
})

// Il giro vero con i client finti: due conti, un servizio senza load balancer, un ALB dichiarato, un
// NLB che non vale, un conto che non si legge. Nessuna chiamata di rete.
test('lettura: dai servizi ECS ai target group alle metriche, Id rimappati fra conti, errori per conto', async () => {
  const prima = { ecs: ECSClient.prototype.send, elb: ElasticLoadBalancingV2Client.prototype.send, cw: CloudWatchClient.prototype.send }
  const chiamate = []
  const arnTg = (n) => `arn:aws:elasticloadbalancing:eu-west-1:000000000000:targetgroup/${n}/1`
  const arnLb = (n, tipo = 'app') => `arn:aws:elasticloadbalancing:eu-west-1:000000000000:loadbalancer/${tipo}/${n}/1`
  ECSClient.prototype.send = async function (cmd) {
    chiamate.push(cmd.constructor.name)
    const tg = { api: arnTg('api'), web: arnTg('web'), interno: arnTg('interno') }
    return { services: cmd.input.services.map((s) => ({ serviceName: s, loadBalancers: tg[s] ? [{ targetGroupArn: tg[s] }] : [] })) }
  }
  ElasticLoadBalancingV2Client.prototype.send = async function (cmd) {
    chiamate.push(cmd.constructor.name)
    if (cmd.constructor.name === 'DescribeTargetGroupsCommand')
      return { TargetGroups: cmd.input.TargetGroupArns.map((a) => ({ TargetGroupArn: a, LoadBalancerArns: [a.includes('interno') ? arnLb('nlb', 'net') : arnLb('pub')] })) }
    return { LoadBalancers: (cmd.input.Names ?? []).map((n) => ({ LoadBalancerName: n, LoadBalancerArn: arnLb(n), Type: 'application' })) }
  }
  const query = []
  CloudWatchClient.prototype.send = async function (cmd) {
    chiamate.push(cmd.constructor.name)
    query.push(...cmd.input.MetricDataQueries)
    const t0 = cmd.input.StartTime
    return { MetricDataResults: cmd.input.MetricDataQueries.map((q) => ({ Id: q.Id, Timestamps: [t0], Values: [q.Id.endsWith('richieste') ? 100 : q.Id.endsWith('errori') ? 1 : 0.2] })) }
  }
  try {
    const accounts = {
      prod: { label: 'Production', profile: 'p', region: 'eu-west-1' },
      staging: { label: 'Staging', profile: 's', region: 'eu-west-1' },
      rotto: { label: 'Rotto', profile: 'r', region: 'eu-west-1' },
    }
    const services = [
      { name: 'api', account: 'prod', aws: { type: 'ecs', cluster: 'c', service: 'api' } },
      { name: 'worker', account: 'prod', aws: { type: 'ecs', cluster: 'c', service: 'worker' } },
      { name: 'interno', account: 'prod', aws: { type: 'ecs', cluster: 'c', service: 'interno' } },
      { name: 'web', account: 'staging', aws: { type: 'ecs', cluster: 'c', service: 'web' } },
      { name: 'public-lb', account: 'staging', aws: { type: 'alb', name: 'public-lb' } },
      { name: 'cron', account: 'staging', aws: { type: 'lambda', function: 'cron' } },
      { name: 'giu', account: 'rotto', aws: { type: 'ecs', cluster: 'x', service: 'giu' } },
    ]
    const ecsRotto = ECSClient.prototype.send
    ECSClient.prototype.send = async function (cmd) {
      if (cmd.input.cluster === 'x') throw new Error('AccessDenied')
      return ecsRotto.call(this, cmd)
    }
    const out = await andamentoServizi({ services, accounts, ore: 24, ora: ORA })
    assert.deepEqual(out.servizi.map((s) => s.k), ['prod|api', 'staging|public-lb', 'staging|web'])
    assert.equal(query.length, 12, 'quattro metriche per servizio, niente per il worker, il NLB e la lambda')
    assert.equal(chiamate.filter((c) => c === 'GetMetricDataCommand').length, 2, 'una chiamata per conto')
    assert.ok(out.servizi.every((s) => s.richieste[0] === 100 && s.p50[0] === 200), 'gli Id locali tornano al servizio giusto')
    assert.deepEqual(out.account.rotto, { label: 'Rotto', error: 'AccessDenied' })
    assert.equal(out.metriche, 12)

    const soloProd = await andamentoServizi({ services, accounts, ore: 24, ora: ORA, conti: ['prod'] })
    assert.deepEqual(soloProd.servizi.map((s) => s.k), ['prod|api'])
  } finally {
    ECSClient.prototype.send = prima.ecs
    ElasticLoadBalancingV2Client.prototype.send = prima.elb
    CloudWatchClient.prototype.send = prima.cw
  }
})

test('miscela: un pezzo solo dà i suoi percentili, il p90 di tutti cade nel servizio lento', () => {
  assert.equal(quantileMisto([{ p50: 120, p90: 400, w: 10 }], 0.5), 120)
  assert.equal(quantileMisto([{ p50: 120, p90: 400, w: 10 }], 0.9), 400)
  assert.equal(quantileMisto([{ p50: 120, p90: 400, w: 0 }], 0.5), null, 'senza richieste non c’è un tempo')
  // L'80% del traffico a 100-200 ms, il 20% a 2-3 s: la media pesata dei p90 direbbe 760 ms, la loro
  // mediana pesata 200 ms, ma una richiesta su dieci ci mette davvero due secondi.
  const pezzi = [
    { p50: 100, p90: 200, w: 800 },
    { p50: 2000, p90: 3000, w: 200 },
  ]
  const p90 = quantileMisto(pezzi, 0.9)
  assert.ok(Math.abs(p90 - 2000) < 20, `p90 della miscela ${p90}`)
  const p50 = quantileMisto(pezzi, 0.5)
  assert.ok(p50 > 100 && p50 < 200, `p50 della miscela ${p50}`)
})

const SERVIZI = [
  { k: 'prod|api', account: 'prod', servizio: 'api', richieste: [100, 0, 300], errori: [10, 0, 0], p50: [200, null, 220], p90: [600, null, 700] },
  { k: 'prod|web', account: 'prod', servizio: 'web', richieste: [1000, 0, 1000], errori: [1, 0, 0], p50: [50, null, 60], p90: [100, null, 120] },
  { k: 'staging|web', account: 'staging', servizio: 'web', richieste: [10, 0, 0], errori: [0, 0, 0], p50: [80, null, null], p90: [150, null, null] },
]

test('serie insieme: somme fascia per fascia, buco dove nessuno ha avuto richieste', () => {
  const s = serieInsieme(SERVIZI, 3)
  assert.deepEqual(s.richieste, [1110, 0, 1300])
  assert.deepEqual(s.errori, [11, 0, 0])
  assert.equal(s.p50[1], null)
  assert.equal(s.tasso[1], null)
  assert.ok(s.p50[0] >= 50 && s.p50[0] <= 80, 'di solito pesa il servizio con piu’ traffico')
  const k = kpiAndamento(SERVIZI)
  assert.equal(k.richieste, 2410)
  assert.equal(k.errori, 11)
  assert.equal(k.tasso, 11 / 2410)
  assert.deepEqual(kpiAndamento([]), { richieste: 0, errori: 0, tasso: null, p50: null, p90: null })
})

test('uno su N: una cifra significativa, zero senza errori, null senza richieste', () => {
  assert.equal(unoSu(4786, 2_992_363), 600)
  assert.equal(unoSu(1, 1234), 1000)
  assert.equal(unoSu(3, 1000), 300)
  assert.equal(unoSu(0, 1000), 0)
  assert.equal(unoSu(5, 0), null)
  assert.equal(livelloErrori(0.06), 'crit')
  assert.equal(livelloErrori(0.01), 'warn')
  assert.equal(livelloErrori(0.009), null)
  assert.equal(livelloErrori(null), null)
})

test('tabella e piccoli multipli: dal peggiore, dal più lento, una scala sola', () => {
  const r = righeAndamento(SERVIZI)
  assert.deepEqual(r.map((x) => x.k), ['prod|api', 'staging|web', 'prod|web'], 'api ha il 2,5% di errori; poi per momenti lenti')
  const m = perServizioAndamento(SERVIZI, { max: 2 })
  assert.deepEqual(m.righe.map((x) => x.k), ['prod|api', 'staging|web'])
  assert.deepEqual(m.dominio, [0, 220])
  assert.equal(m.altri, 1)
})

test('colonne larghe: la griglia segue i gruppi di riduci, l’ultima colonna finisce dove finiva la serie', () => {
  const g = { inizio: 0, passoMs: 5 * MIN, punti: 288 }
  const l = fasceLarghe(g, 4)
  assert.deepEqual(l, { inizio: 0, passoMs: 20 * MIN, punti: 72 })
  const m = fasceLarghe({ inizio: 0, passoMs: 1, punti: 7 }, 3)
  assert.equal(m.punti, riduci([1, 1, 1, 1, 1, 1, 1], 3).length)
  assert.equal(m.inizio + m.punti * m.passoMs, 7)
  assert.deepEqual(fasceLarghe(g, 1), g)
})

test('demo: deterministica, due ambienti, il picco di lentezza e la raffica di errori, lo stesso codice del vero', () => {
  const a = payloadAndamento(demoAndamentoServizi(24, ORA))
  const b = payloadAndamento(demoAndamentoServizi(24, ORA + 90_000))
  assert.deepEqual(a, b, 'stessa fascia, stessi numeri: un refresh non ridisegna il grafico')
  assert.deepEqual([...new Set(a.servizi.map((s) => s.account))].sort(), ['prod', 'staging'])
  assert.ok(a.servizi.length >= 5)
  const search = a.servizi.find((s) => s.k === 'prod|search-api')
  const normale = [...search.p50].filter(Boolean).sort((x, y) => x - y)[144]
  assert.ok(Math.max(...search.p50.filter(Boolean)) > 4 * normale, 'il picco di lentezza si vede')
  const checkout = a.servizi.find((s) => s.k === 'prod|checkout-api')
  const quote = checkout.errori.map((e, i) => (checkout.richieste[i] ? e / checkout.richieste[i] : 0))
  assert.ok(quote.filter((q) => q > 0.1).length >= 6, 'la raffica di 5xx dura una quarantina di minuti')
  for (const ore of [168, 720]) {
    const p = payloadAndamento(demoAndamentoServizi(ore, ORA))
    assert.ok(p.punti <= 300 && p.servizi.every((s) => s.richieste.length === p.punti))
  }
  assert.ok(JSON.stringify(a).length < 60_000, 'il payload resta piccolo')
})
