// "Task attivi" e "target sani" non sono la stessa cosa, e la differenza è esattamente dove si
// nasconde il guasto: un servizio può avere tutti i container su e zero bersagli sani (health check
// che fallisce, porta sbagliata, draining) — il load balancer non gli manda traffico, cioè per chi lo
// usa è GIÙ, mentre il conteggio dei task lo mostrava verde.
//
// Per i microservizi INTERNI (dietro un ALB interno) è anche l'unico segnale di liveness ottenibile:
// una sonda HTTP da fuori non arriverà mai in quella VPC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTargetHealth } from '../server/runtime/ecs.js'
import { albStatus, countTargets, expectedHealthyFloor, targetsSummary } from '../server/runtime/alb.js'

// Comodità per scrivere i casi come li racconta AWS: stato + motivo, non la forma della risposta.
const target = (id, State, Reason = null) => ({ Target: { Id: id }, TargetHealth: { State, ...(Reason ? { Reason } : {}) } })

test('zero target sani con task voluti: GIÙ, anche se i container girano', () => {
  const out = applyTargetHealth({ status: 'up', desiredCount: 2 }, { total: 2, healthy: 0 })
  assert.deepEqual(out, { status: 'down', changed: true })
})

test('alcuni sani su molti: ATTENZIONE, non verde', () => {
  const out = applyTargetHealth({ status: 'up', desiredCount: 3 }, { total: 3, healthy: 1 })
  assert.deepEqual(out, { status: 'degraded', changed: true })
})

test('tutti sani: lo stato dei task resta quello che è', () => {
  assert.deepEqual(applyTargetHealth({ status: 'up', desiredCount: 2 }, { total: 2, healthy: 2 }), { status: 'up', changed: false })
  // e non "promuove" uno stato peggiore: se i task sono giù, restano giù
  assert.deepEqual(applyTargetHealth({ status: 'down', desiredCount: 2 }, { total: 2, healthy: 2 }), { status: 'down', changed: false })
})

test('durante un deploy non si giudica: sarebbe un falso allarme a ogni rilascio', () => {
  // I target vecchi vanno in draining e i nuovi si registrano: metà non sani è NORMALE lì.
  const out = applyTargetHealth({ status: 'up', desiredCount: 2, deploying: true }, { total: 4, healthy: 2 })
  assert.deepEqual(out, { status: 'up', changed: false })
})

test('nessun load balancer o nessun dato: il segnale non si applica', () => {
  assert.deepEqual(applyTargetHealth({ status: 'up', desiredCount: 1 }, null), { status: 'up', changed: false })
  assert.deepEqual(applyTargetHealth({ status: 'up', desiredCount: 1 }, { total: 0, healthy: 0 }), { status: 'up', changed: false })
})

test('servizio scalato a zero: nessun target sano NON è un guasto', () => {
  // desiredCount 0 = spento di proposito (idle): il rosso qui sarebbe una bugia.
  const out = applyTargetHealth({ status: 'idle', desiredCount: 0 }, { total: 0, healthy: 0 })
  assert.deepEqual(out, { status: 'idle', changed: false })
})

// --- albStatus: quanti target sani sono «tutto a posto» ---
// Il caso che ha costretto a introdurlo: il target group del WRITER di un Postgres in replica. Lì
// l'health check passa solo sul primario, quindi lo standby registrato è `unhealthy` per costruzione e
// lo stato di regime è 1 sano su 2. Prima Dadaguard lo chiamava ATTENZIONE ogni giorno, per sempre.
test('albStatus: senza atteso, sani < totali è ATTENZIONE (comportamento di prima)', () => {
  assert.equal(albStatus(2, 2), 'up')
  assert.equal(albStatus(1, 2), 'degraded')
  assert.equal(albStatus(6, 7), 'degraded')
})

test('albStatus: con atteso 1, un solo sano su due è la normalità', () => {
  assert.equal(albStatus(1, 2, 1), 'up')
  assert.equal(albStatus(2, 2, 1), 'up', 'più sani del previsto non è un guasto')
})

test('albStatus: zero sani resta GIÙ, anche se ne bastava uno', () => {
  assert.equal(albStatus(0, 2, 1), 'down', 'la soglia si sposta, il rosso no')
  assert.equal(albStatus(0, 2), 'down')
})

test('albStatus: atteso più alto dei registrati vale «tutti», non un guasto inventato', () => {
  // Config vecchia o cluster ridimensionato: 2 sani su 2 con atteso 3 è a posto.
  assert.equal(albStatus(2, 2, 3), 'up')
  assert.equal(albStatus(1, 2, 3), 'degraded')
})

test('albStatus: nessun target registrato resta «non lo so»', () => {
  assert.equal(albStatus(0, 0, 1), 'unknown')
})

// --- countTargets: chi entra e chi esce non è chi è rotto ---
// Il caso che ha costretto a introdurlo: 15/08/2026 04:56, un ALB interno di staging, «2 target su 8
// non sani: 10.0.106.240 (Target.DeregistrationInProgress), 10.0.88.24 (Target.DeregistrationInProgress)».
// Erano le copie vecchie di due servizi che finivano le richieste aperte a fine rilascio: il deploy si
// è chiuso 50 secondi dopo. Un ATTENZIONE a ogni deploy insegna a ignorare il canale.
test('countTargets: draining e initial non sono guasti, e non contano nel totale', () => {
  const out = countTargets([
    target('10.0.1.1', 'healthy'),
    target('10.0.1.2', 'healthy'),
    target('10.0.106.240', 'draining', 'Target.DeregistrationInProgress'),
    target('10.0.88.24', 'draining', 'Target.DeregistrationInProgress'),
  ])
  assert.deepEqual(out, { healthy: 2, total: 2, transitioning: 2, registered: 4, bad: [] })
  // e il verdetto che ne esce è VERDE: prima era 2 sani su 4, cioè giallo
  assert.equal(albStatus(out.healthy, out.total, null, out.transitioning), 'up')
})

test('countTargets: `unhealthy.draining` è draining, non un guasto', () => {
  // Il terzo stato di deregistrazione dell'enum ELBv2: il container ha già smesso di rispondere
  // all'health check (SIGTERM ricevuto) mentre finisce le connessioni aperte. Stesso motivo AWS del
  // caso di sopra, quindi dimenticarlo rimetteva in piedi lo stesso falso allarme.
  const out = countTargets([
    target('10.0.1.1', 'healthy'),
    target('10.0.88.24', 'unhealthy.draining', 'Target.DeregistrationInProgress'),
  ])
  assert.deepEqual(out, { healthy: 1, total: 1, transitioning: 1, registered: 2, bad: [] })
  assert.equal(albStatus(out.healthy, out.total, null, out.transitioning), 'up')
})

test('countTargets: la copia nuova che si sta registrando non è un guasto', () => {
  const out = countTargets([target('10.0.1.1', 'healthy'), target('10.0.1.9', 'initial', 'Elb.RegistrationInProgress')])
  assert.deepEqual(out, { healthy: 1, total: 1, transitioning: 1, registered: 2, bad: [] })
  assert.equal(albStatus(out.healthy, out.total, null, out.transitioning), 'up')
})

test('countTargets: un target davvero rotto resta rotto, con il suo motivo', () => {
  const out = countTargets([
    target('10.0.1.1', 'healthy'),
    target('10.0.1.2', 'unhealthy', 'Target.FailedHealthChecks'),
    target('10.0.106.240', 'draining', 'Target.DeregistrationInProgress'),
  ])
  assert.deepEqual(out, {
    healthy: 1,
    total: 2,
    transitioning: 1,
    registered: 3,
    bad: [{ id: '10.0.1.2', reason: 'Target.FailedHealthChecks' }],
  })
  assert.equal(albStatus(out.healthy, out.total, null, out.transitioning), 'degraded', 'il draining tace, il guasto no')
})

test('countTargets: `unused` NON è transizione, è configurazione da guardare', () => {
  // `Target.NotInUse` (target group non collegato a nessun LB, o AZ non abilitata) non si risolve da sé.
  const out = countTargets([target('10.0.1.1', 'unused', 'Target.NotInUse')])
  assert.deepEqual(out, {
    healthy: 0,
    total: 1,
    transitioning: 0,
    registered: 1,
    bad: [{ id: '10.0.1.1', reason: 'Target.NotInUse' }],
  })
})

test('countTargets: risposta vuota o assente non inventa niente', () => {
  assert.deepEqual(countTargets([]), { healthy: 0, total: 0, transitioning: 0, registered: 0, bad: [] })
  assert.deepEqual(countTargets(undefined), { healthy: 0, total: 0, transitioning: 0, registered: 0, bad: [] })
})

// --- tutti i target in transizione: nessuno serve traffico ---
// È il buco che si apre escludendo la transizione dai conteggi: se ESCONO tutti, `total` va a zero e
// senza una regola sua il load balancer «senza target» sembrerebbe a posto, mentre risponde 503.
test('albStatus: tutti i target in transizione è GIALLO, non «non lo so»', () => {
  assert.equal(albStatus(0, 0, null, 2), 'degraded', 'nessuno serve traffico: si dice')
  assert.equal(albStatus(0, 0, null, 0), 'unknown', 'nessun target iscritto: davvero non lo sappiamo')
})

test('applyTargetHealth: zero target sani perché stanno drenando tutti resta GIÙ', () => {
  // Deploy già dichiarato finito da ECS (`deploying: false`) e vecchie copie ancora in draining: il
  // servizio non riceve traffico, e prima di `registered` questa riga tornava verde.
  const out = applyTargetHealth(
    { status: 'up', desiredCount: 2 },
    { total: 0, healthy: 0, transitioning: 2, registered: 2 },
  )
  assert.deepEqual(out, { status: 'down', changed: true })
})

test('applyTargetHealth: durante il rilascio invece tace, come prima', () => {
  const out = applyTargetHealth(
    { status: 'up', desiredCount: 2, deploying: true },
    { total: 0, healthy: 0, transitioning: 2, registered: 2 },
  )
  assert.deepEqual(out, { status: 'up', changed: false })
})

// --- expectedHealthy si misura sui target ISCRITTI ---
test('expectedHealthyFloor: la transizione non abbassa il pavimento dichiarato', () => {
  // Quattro iscritti, tre in draining: `atteso` resta 2, quindi un solo sano non è «tutto a posto».
  assert.equal(expectedHealthyFloor(2, 4), 2)
  assert.equal(albStatus(1, 1, 2, 3), 'up', 'lo stato guarda i serventi')
  assert.equal(expectedHealthyFloor(2, 1), 1, 'più alto degli iscritti vale «tutti»')
  assert.equal(expectedHealthyFloor(null, 3), 3, 'senza dichiarazione: tutti')
})

// --- la frase della card ---
// La composizione è il punto dove si sbaglia il ramo, e sbagliarlo qui vuol dire dire «nessun target
// collegato» mentre ne stanno drenando otto: chi legge va a cercare una configurazione rotta.
const tFinto = (k, p = {}) => `${k}(${Object.entries(p).map(([a, b]) => `${a}=${b}`).join(',')})`

test('targetsSummary: caso normale, con la coda della transizione', () => {
  assert.equal(
    targetsSummary({ healthy: 2, total: 2, transitioning: 1, registered: 3, atteso: 3 }, tFinto),
    'alb.targets(healthy=2,total=2)alb.transitioning(n=1)',
  )
})

test('targetsSummary: nessun target iscritto e tutti in transizione sono frasi diverse', () => {
  assert.equal(targetsSummary({ healthy: 0, total: 0, transitioning: 0, registered: 0, atteso: 0 }, tFinto), 'alb.notarget()')
  assert.equal(
    targetsSummary({ healthy: 0, total: 0, transitioning: 2, registered: 2, atteso: 2 }, tFinto),
    'alb.alltransitioning(n=2)',
  )
})

test('targetsSummary: «attesi n» compare quando il pavimento è sotto gli ISCRITTI', () => {
  assert.equal(
    targetsSummary({ healthy: 1, total: 2, transitioning: 0, registered: 2, atteso: 1 }, tFinto),
    'alb.targets(healthy=1,total=2)alb.expected(n=1)',
  )
})
