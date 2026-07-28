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
