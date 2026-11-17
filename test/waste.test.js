import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isIdle, isIdleInstance, motivoRiserva, TAG_RISERVA } from '../server/waste.js'

test('isIdle: risorsa vecchia e sotto soglia → idle', () => {
  assert.equal(isIdle({ ageDays: 30, metric: 0.5, threshold: 2 }), true) // EC2 CPU 0.5% < 2%
  assert.equal(isIdle({ ageDays: 30, metric: 0, threshold: 0 }), true) // DB 0 connessioni
})

test('isIdle: sopra soglia → non idle', () => {
  assert.equal(isIdle({ ageDays: 30, metric: 5, threshold: 2 }), false) // CPU 5% > 2%
  assert.equal(isIdle({ ageDays: 30, metric: 1, threshold: 0 }), false) // DB con connessioni
})

test('isIdle: risorsa troppo giovane → mai segnalata (dati insufficienti)', () => {
  assert.equal(isIdle({ ageDays: 1, metric: 0, threshold: 2 }), false)
  assert.equal(isIdle({ ageDays: 2.9, metric: 0, threshold: 0 }), false)
})

test('isIdleInstance: poca CPU e poca rete → ferma', () => {
  assert.equal(isIdleInstance({ ageDays: 30, cpuAvg: 0.3, netMbDay: 15 }), true)
})

test('isIdleInstance: poca CPU ma tanta rete (un proxy al lavoro) → non ferma', () => {
  assert.equal(isIdleInstance({ ageDays: 30, cpuAvg: 0.3, netMbDay: 4000 }), false)
})

test('isIdleInstance: CPU alta → non ferma, qualunque sia la rete', () => {
  assert.equal(isIdleInstance({ ageDays: 30, cpuAvg: 40, netMbDay: 0 }), false)
})

test('isIdleInstance: troppo giovane → mai ferma', () => {
  assert.equal(isIdleInstance({ ageDays: 1, cpuAvg: 0, netMbDay: 0 }), false)
})

test('motivoRiserva: legge il tag con il motivo, anche vuoto; null senza tag', () => {
  assert.equal(motivoRiserva([{ Key: TAG_RISERVA, Value: ' failover del worker ' }]), 'failover del worker')
  assert.equal(motivoRiserva([{ Key: TAG_RISERVA, Value: '' }]), '')
  assert.equal(motivoRiserva([{ Key: 'Name', Value: 'web-1' }]), null)
  assert.equal(motivoRiserva(undefined), null)
})
