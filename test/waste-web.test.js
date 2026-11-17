import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contaSprechi } from '../web/pages/wasteKit.js'

const dati = {
  prod: {
    label: 'Prod',
    eips: [{ id: 'eipalloc-01', ip: '198.51.100.7' }],
    idleInstances: [{ id: 'i-0aaa', type: 't3.small', cpuAvg: 0.5, cpuMax: 2, netMbDay: 10 }],
    standbyInstances: [{ id: 'i-0bbb', type: 't3.small', cpuAvg: 0.2, cpuMax: 1, netMbDay: 5, standby: 'failover' }],
    standbyDatabases: [{ id: 'db-riserva', cpuAvg: 1, cpuMax: 3, standby: '' }],
  },
}

test('contaSprechi: le riserve dichiarate non entrano nel numero sulla scheda', () => {
  assert.equal(contaSprechi(dati), 2) // l'EIP e l'istanza ferma, non le due riserve
})

test('contaSprechi: solo riserve → zero sprechi', () => {
  assert.equal(contaSprechi({ prod: { label: 'Prod', standbyInstances: dati.prod.standbyInstances } }), 0)
})
