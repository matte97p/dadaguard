import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alarmiSenzaServizio, haNotificaPropria, isAutoscalingAlarm, run } from '../server/checks/alarms.js'
import { makeT } from '../server/i18n.js'

// Un allarme su un ALB non porta il nome del servizio ECS: le sue dimensioni sono `LoadBalancer` e
// `TargetGroup`. Il ponte è la convenzione di nome del target group, `<cluster>-<servizio>`.
const allarmeAlb = (tg, nome = 'acme-production-alb-5xx') => ({
  AlarmName: nome,
  Dimensions: [
    { Name: 'LoadBalancer', Value: 'app/acme-production-alb/da88ba4cbb5da209' },
    { Name: 'TargetGroup', Value: `targetgroup/${tg}/aef1b2e1adb1c9f9` },
  ],
})

const ecs = (service, cluster = 'acme-production') => ({ aws: { type: 'ecs', cluster, service } })
const ctx = (alarms) => ({ alarms, t: (_k, v) => JSON.stringify(v) })

test('allarme ALB: correlato al servizio ECS via nome del target group', async () => {
  const r = await run(ecs('backend'), ctx([allarmeAlb('acme-production-backend')]))
  assert.ok(r, 'la riga deve comparire')
  assert.equal(r.status, 'degraded')
  assert.match(r.summary, /acme-production-alb-5xx/)
})

test('allarme ALB: NON si attacca agli altri servizi dello stesso ALB', async () => {
  const c = ctx([allarmeAlb('acme-production-backend')])
  assert.equal(await run(ecs('agentic-chat'), c), null)
  assert.equal(await run(ecs('garanzia'), c), null)
})

test('allarme ALB: un secondo target group dello stesso servizio conta comunque', async () => {
  // `backend` sta dietro due gruppi: quello pubblico e `-int` sull'ALB interno.
  const r = await run(ecs('backend'), ctx([allarmeAlb('acme-production-backend-int', 'latenza-int')]))
  assert.ok(r)
  assert.match(r.summary, /latenza-int/)
})

test('allarme ALB: cluster diverso non correla (staging non parla per production)', async () => {
  const c = ctx([allarmeAlb('acme-production-backend')])
  assert.equal(await run(ecs('backend', 'acme-staging'), c), null)
})

test('gli allarmi di autoscaling restano esclusi', () => {
  assert.equal(isAutoscalingAlarm({ AlarmName: 'TargetTracking-service/x-AlarmLow-123' }), true)
  assert.equal(
    isAutoscalingAlarm({ AlarmName: 'qualunque', AlarmActions: ['arn:aws:autoscaling:...:scalingPolicy:abc'] }),
    true,
  )
  assert.equal(isAutoscalingAlarm({ AlarmName: 'acme-production-alb-5xx', AlarmActions: ['arn:aws:sns:...:topic'] }), false)
})

test('la correlazione per dimensione diretta continua a funzionare', async () => {
  const diretto = { AlarmName: 'ecs-cpu', Dimensions: [{ Name: 'ServiceName', Value: 'backend' }] }
  const r = await run(ecs('backend'), ctx([diretto]))
  assert.ok(r)
  assert.match(r.summary, /ecs-cpu/)
})

// Un servizio può avere cinque allarmi attivi insieme (5xx + latenza + target + CPU + memoria): la riga
// ne nomina tre e dice quanti restano. Il `, +N` era scritto a mano qui dentro, ora è la funzione
// condivisa — e questo test guarda la riga VERA, non l'helper.
test('più allarmi del tetto: tre nomi e «+N», non un elenco infinito né un silenzio', async () => {
  const cinque = ['a', 'b', 'c', 'd', 'e'].map((n) => allarmeAlb('acme-production-backend', `alb-${n}`))
  const t = (_k, v) => `${v.n}|${v.list}`
  const r = await run(ecs('backend'), { alarms: cinque, t })
  assert.equal(r.summary, '5|alb-a, alb-b, alb-c, +2')
})

test('allarmi sotto il tetto: nessun «+0» appiccicato in fondo', async () => {
  const due = ['a', 'b'].map((n) => allarmeAlb('acme-production-backend', `alb-${n}`))
  const r = await run(ecs('backend'), { alarms: due, t: (_k, v) => v.list })
  assert.equal(r.summary, 'alb-a, alb-b')
})

// ── Gli allarmi che non sono di nessuno ───────────────────────────────────────────────────────────
// ⚠️ Un allarme nato da un METRIC FILTER su un log group non ha dimensioni: la sua metrica conta
// righe di log, non lo stato di una risorsa. La correlazione per dimensione quindi non lo trova, e
// prima del 01/09/2026 veniva scaricato e buttato via, cioe' suonava e non compariva da nessuna
// parte. Queste prove tengono aperta quella strada.
const allarmeSenzaDimensioni = (nome = 'audit-sessioni-negate') => ({ AlarmName: nome, Dimensions: [] })
const allarmeEcs = (service) => ({ AlarmName: `${service}-cpu`, Dimensions: [{ Name: 'ServiceName', Value: service }] })

test('senza servizio: un allarme senza dimensioni non e\' di nessuno, e resta in elenco', () => {
  const orfani = alarmiSenzaServizio([allarmeSenzaDimensioni()], [ecs('backend')])
  assert.equal(orfani.length, 1)
  assert.equal(orfani[0].AlarmName, 'audit-sessioni-negate')
})

test('senza servizio: quello che UN servizio riconosce come suo non e\' orfano', () => {
  const orfani = alarmiSenzaServizio([allarmeEcs('backend')], [ecs('backend'), ecs('frontend')])
  assert.deepEqual(orfani, [])
})

test('senza servizio: basta che lo riconosca UNO dei servizi, non il primo', () => {
  const orfani = alarmiSenzaServizio([allarmeEcs('frontend')], [ecs('backend'), ecs('frontend')])
  assert.deepEqual(orfani, [])
})

test('senza servizio: anche un allarme su ALB trova il suo padrone, e non finisce fra gli orfani', () => {
  const orfani = alarmiSenzaServizio([allarmeAlb('acme-production-backend')], [ecs('backend')])
  assert.deepEqual(orfani, [])
})

test('senza servizio: nessun servizio configurato vuol dire che sono tutti orfani, non nessuno', () => {
  // ⚠️ Il verso in cui sbagliare: senza servizi da confrontare l elenco NON e\' vuoto. Un allarme che
  // suona su un account dove non monitoriamo niente e\' proprio quello che nessun altro mostrerebbe.
  const orfani = alarmiSenzaServizio([allarmeEcs('backend')], [])
  assert.equal(orfani.length, 1)
})

// ── Gli allarmi che hanno gia' chi li dice ────────────────────────────────────────────────────────
// Visto l'08/10/2026: `acme-production-alb-5xx` detto su Slack dal suo notifier (allarme → SNS →
// Lambda) alle 14:52 e richiuso alle 15:01, e alle 15:01 un nostro «1 allarme attivo» doppione e gia'
// scaduto. La card li mostra ancora; e' Slack che non deve sentirli due volte.
const conSns = (a) => ({ ...a, AlarmActions: ['arn:aws:sns:eu-central-1:123456789012:acme-production-alb-alarms'] })

test('notifica propria: un topic SNS fra le AlarmActions, in qualunque partizione', () => {
  assert.equal(haNotificaPropria(conSns(allarmeAlb('acme-production-backend'))), true)
  assert.equal(haNotificaPropria({ AlarmActions: ['arn:aws-cn:sns:cn-north-1:123456789012:t'] }), true)
  assert.equal(haNotificaPropria(allarmeAlb('acme-production-backend')), false, 'nessuna azione: lo diciamo noi')
  assert.equal(haNotificaPropria({ AlarmActions: ['arn:aws:lambda:eu-central-1:123456789012:function:x'] }), false)
  // Conta lo scatto: un SNS solo sul rientro non dice a nessuno che l'allarme e' partito.
  assert.equal(haNotificaPropria({ OKActions: ['arn:aws:sns:eu-central-1:123456789012:t'] }), false)
})

test('tutti gia\' detti: la riga resta gialla, con la nota, e si dichiara notificata altrove', async () => {
  const r = await run(ecs('backend'), { alarms: [conSns(allarmeAlb('acme-production-backend'))], t: makeT('it') })
  assert.equal(r.status, 'degraded', 'la card resta gialla finche\' l\'allarme suona')
  assert.equal(r.notificatoAltrove, true)
  assert.equal(r.summary, '1 allarme attivo: acme-production-alb-5xx · già notificato su Slack dal suo allarme')
})

test('misti: il check conta per Slack, e la frase in chat nomina solo quelli senza notifier', async () => {
  const alarms = [conSns(allarmeAlb('acme-production-backend')), allarmeAlb('acme-production-backend', 'latenza')]
  const r = await run(ecs('backend'), { alarms, t: makeT('it') })
  assert.equal(r.notificatoAltrove, undefined)
  assert.equal(r.alert, '1 allarme attivo: latenza')
  assert.match(r.summary, /^2 allarmi attivi: acme-production-alb-5xx, latenza · 1 già notificato su Slack/)
})

test('nessuno con notifier: la riga di sempre, senza nota e senza campi in piu\'', async () => {
  const r = await run(ecs('backend'), { alarms: [allarmeAlb('acme-production-backend')], t: makeT('en') })
  assert.deepEqual(r, { key: 'alarms', status: 'degraded', summary: '1 alarm firing: acme-production-alb-5xx' })
})
