import { test } from 'node:test'
import assert from 'node:assert/strict'
import { secchi, disponibilita, intervalliAllarmi, cronologia, eventiDaBuild, eventiDaGuasti, kpiDeploy, confronto, servizioDiAllarme, ambienteDiConto, inizioGiorno, segnaliEcs } from '../server/storico.js'
import { storicoFlotta } from '../server/storicoAws.js'
import { demoHistory } from '../server/demo.js'

// Un'ora fissa a metà giornata: «oggi» e i secchi non devono dipendere da quando gira il test.
const ORA = new Date(2026, 5, 10, 14, 0, 0).getTime()
const min = (n) => n * 60_000
const voce = (nome, t, da, a) => ({ AlarmName: nome, HistoryItemType: 'StateUpdate', Timestamp: new Date(t).toISOString(), HistoryData: JSON.stringify({ oldState: { stateValue: da }, newState: { stateValue: a } }) })

test('secchi: 48 da mezz\'ora, un guasto di pochi minuti colora il suo secchio', () => {
  const s = secchi({ intervalli: [{ inizio: ORA - min(40), fine: ORA - min(35) }], ora: ORA, ore: 24 })
  assert.equal(s.length, 48)
  assert.equal(s[46].livello, 'crit')
  assert.equal(s.filter((x) => x.livello === 'crit').length, 1)
  assert.equal(disponibilita(s), 97.9)
})

test('secchi: un guasto ancora in corso arriva fino all\'ultimo secchio', () => {
  const s = secchi({ intervalli: [{ inizio: ORA - min(70), fine: null }], ora: ORA, ore: 24 })
  assert.deepEqual(s.slice(-3).map((x) => x.livello), ['crit', 'crit', 'crit'])
})

test('secchi: una build fallita è attenzione, non guasto, e non abbassa la disponibilità', () => {
  const s = secchi({ segnali: [{ ts: ORA - min(10), livello: 'warn', fonte: 'build' }], ora: ORA })
  assert.equal(s.at(-1).livello, 'warn')
  assert.deepEqual(s.at(-1).motivi, ['build'])
  assert.equal(disponibilita(s), 100)
})

test('intervalli: entrata e uscita, guasto già in corso a inizio finestra, guasto aperto', () => {
  const da = ORA - min(24 * 60)
  const iv = intervalliAllarmi(
    [voce('a', ORA - min(100), 'OK', 'ALARM'), voce('a', ORA - min(80), 'ALARM', 'OK'), voce('b', ORA - min(500), 'ALARM', 'OK'), voce('c', ORA - min(5), 'OK', 'ALARM')],
    { da, meta: { a: { Dimensions: [{ Name: 'ServiceName', Value: 'acme-production-backend' }] } } },
  )
  const per = Object.fromEntries(iv.map((x) => [x.allarme, x]))
  assert.equal(per.a.servizio, 'backend')
  assert.equal(per.a.fine - per.a.inizio, min(20))
  assert.equal(per.b.inizio, da)
  assert.equal(per.b.inizioNoto, false)
  assert.equal(per.c.fine, null)
})

test('servizio di un allarme: dalle dimensioni, null se non riconoscibile', () => {
  assert.equal(servizioDiAllarme({ Dimensions: [{ Name: 'FunctionName', Value: 'acme-staging-worker' }] }), 'worker')
  assert.equal(servizioDiAllarme({ Dimensions: [{ Name: 'QueueName', Value: 'x' }] }), null)
})

test('correlazione: rotto N minuti dopo l\'ultimo deploy riuscito dello stesso servizio', () => {
  const builds = [
    { id: 'b1', service: 'backend', status: 'SUCCEEDED', startedAt: ORA - min(60), commit: 'aaa' },
    { id: 'b2', service: 'backend', status: 'SUCCEEDED', startedAt: ORA - min(40), commit: 'bbb' },
    { id: 'b3', service: 'backend', status: 'FAILED', startedAt: ORA - min(30), commit: 'ccc' },
  ]
  const guasti = [{ allarme: 'x', servizio: 'backend', inizio: ORA - min(28), fine: null, inizioNoto: true }]
  const c = cronologia({ eventi: [...eventiDaBuild(builds, 'produzione'), ...eventiDaGuasti(guasti, 'produzione')], ora: ORA })
  const g = c.find((e) => e.tipo === 'guasto')
  assert.deepEqual(g.dopoDeploy, { id: 'b2', commit: 'bbb', minuti: 12 })
  assert.deepEqual(c.map((e) => e.ts), [...c.map((e) => e.ts)].sort((a, b) => a - b))
})

test('correlazione: niente oltre 30 minuti, su altro servizio, altro ambiente o inizio ignoto', () => {
  const ev = [...eventiDaBuild([{ id: 'b', service: 'backend', status: 'SUCCEEDED', startedAt: ORA - min(100) }], 'produzione')]
  const g = (extra) => ({ tipo: 'guasto', ambiente: 'produzione', servizio: 'backend', ts: ORA - min(60), inizioNoto: true, ...extra })
  const c = cronologia({ eventi: [...ev, g({}), g({ servizio: 'altro', ts: ORA - min(90) }), g({ ambiente: 'staging', ts: ORA - min(90) }), g({ inizioNoto: false, ts: ORA - min(90) })], ora: ORA })
  assert.ok(c.filter((e) => e.tipo === 'guasto').every((e) => !e.dopoDeploy))
})

test('cronologia: solo oggi, e i riavvii respinti non sono riavvii', () => {
  const ev = eventiDaBuild(
    [
      { id: 'r1', kind: 'restart', service: 'backend', status: 'SUCCEEDED', startedAt: ORA - min(5), forcedBy: 'sam' },
      { id: 'r2', kind: 'restart', service: 'backend', status: 'FAILED', startedAt: ORA - min(6) },
      { id: 'vecchio', service: 'backend', status: 'SUCCEEDED', startedAt: inizioGiorno(ORA) - min(1) },
    ],
    'produzione',
  )
  const c = cronologia({ eventi: ev, ora: ORA })
  assert.deepEqual(c.map((e) => e.id), ['r1'])
  assert.equal(c[0].tipo, 'riavvio')
})

test('kpi: riusciti e falliti oggi contro ieri, senza riavvii né build in corso', () => {
  const oggi0 = inizioGiorno(ORA)
  const b = (status, t, extra = {}) => ({ status, startedAt: t, ...extra })
  const k = kpiDeploy([b('SUCCEEDED', oggi0 + min(10)), b('SUCCEEDED', oggi0 + min(20)), b('FAILED', oggi0 - min(10)), b('SUCCEEDED', oggi0 - min(30)), b('SUCCEEDED', oggi0 + min(5), { kind: 'restart' }), b('IN_PROGRESS', oggi0 + min(1), { inProgress: true })], ORA)
  assert.deepEqual(k.riusciti, { oggi: 2, ieri: 1, delta: 1, pct: 100 })
  assert.deepEqual(k.falliti, { oggi: 0, ieri: 1, delta: -1, pct: -100 })
  assert.equal(confronto(3, 0).pct, null)
})

test('ambienti: Cloudflare è uno pseudo-conto, payer e security restano fuori', () => {
  assert.equal(ambienteDiConto('cloudflare', {}), 'cloudflare')
  assert.equal(ambienteDiConto('prod'), 'produzione')
  assert.equal(ambienteDiConto('management'), null)
})

test('eventi ECS: «steady state» non è un problema, «unable to place» sì', () => {
  const s = segnaliEcs([{ ts: ORA, message: 'has reached a steady state.' }, { ts: ORA, message: 'was unable to place a task' }])
  assert.equal(s.length, 1)
})

test('storicoFlotta: una fonte senza permesso diventa un errore suo, il resto risponde', async () => {
  const negato = async () => {
    const e = new Error('User is not authorized to perform: cloudwatch:DescribeAlarmHistory')
    e.name = 'AccessDenied'
    throw e
  }
  const out = await storicoFlotta({
    accounts: { prod: { region: 'eu-west-1' }, management: {} },
    deploys: { prod: { builds: [] }, cloudflare: { provider: 'cloudflare', builds: [] } },
    ora: ORA,
    letture: { storiaAllarmi: negato, metadatiAllarmi: async () => ({}), eventiEcsAccount: async () => [], metricheGiorno: async () => null },
  })
  assert.deepEqual(Object.keys(out.ambienti).sort(), ['cloudflare', 'produzione'])
  assert.deepEqual(out.ambienti.produzione.errori, [{ fonte: 'allarmi', errore: 'permesso mancante' }])
  assert.equal(out.ambienti.produzione.secchi.length, 48)
  assert.equal(out.nota.approssimato, true)
})

test('demo: completa, con un guasto correlato al deploy', () => {
  const h = demoHistory()
  assert.deepEqual(Object.keys(h.ambienti).sort(), ['cloudflare', 'produzione', 'staging'])
  assert.ok(h.cronologia.some((e) => e.tipo === 'guasto' && e.dopoDeploy))
  assert.ok(h.ambienti.produzione.kpi.metriche.albP95ms.delta != null)
})
