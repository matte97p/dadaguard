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
import { albStatus, countTargets } from '../server/runtime/alb.js'

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
  assert.deepEqual(out, { healthy: 2, total: 2, transitioning: 2, bad: [] })
  // e il verdetto che ne esce è VERDE: prima era 2 sani su 4, cioè giallo
  assert.equal(albStatus(out.healthy, out.total), 'up')
})

test('countTargets: la copia nuova che si sta registrando non è un guasto', () => {
  const out = countTargets([target('10.0.1.1', 'healthy'), target('10.0.1.9', 'initial', 'Elb.RegistrationInProgress')])
  assert.deepEqual(out, { healthy: 1, total: 1, transitioning: 1, bad: [] })
  assert.equal(albStatus(out.healthy, out.total), 'up')
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
    bad: [{ id: '10.0.1.2', reason: 'Target.FailedHealthChecks' }],
  })
  assert.equal(albStatus(out.healthy, out.total), 'degraded', 'il draining tace, il guasto no')
})

test('countTargets: un draining che non finisce più non deve diventare invisibile', () => {
  // Se il draining resta appeso (WebSocket o SSE che non chiudono) i target sani calano davvero,
  // e quello si vede lo stesso: qui la copia nuova non c'è, quindi zero sani su zero.
  const out = countTargets([target('10.0.106.240', 'draining', 'Target.DeregistrationInProgress')])
  assert.deepEqual(out, { healthy: 0, total: 0, transitioning: 1, bad: [] })
  assert.equal(albStatus(out.healthy, out.total), 'unknown', 'non «giù»: durante un rilascio è normale')
})

test('countTargets: `unused` NON è transizione, è configurazione da guardare', () => {
  // `Target.NotInUse` (target group non collegato a nessun LB, o AZ non abilitata) non si risolve da sé.
  const out = countTargets([target('10.0.1.1', 'unused', 'Target.NotInUse')])
  assert.deepEqual(out, { healthy: 0, total: 1, transitioning: 0, bad: [{ id: '10.0.1.1', reason: 'Target.NotInUse' }] })
})

test('countTargets: risposta vuota o assente non inventa niente', () => {
  assert.deepEqual(countTargets([]), { healthy: 0, total: 0, transitioning: 0, bad: [] })
  assert.deepEqual(countTargets(undefined), { healthy: 0, total: 0, transitioning: 0, bad: [] })
})
