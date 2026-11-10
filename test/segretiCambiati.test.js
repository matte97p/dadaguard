import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parametriSsm, rilascioJob } from '../server/runtime/segretiCambiati.js'
import { statoRilascio } from '../shared/rilascio.js'

const td = (secrets, extra = []) => ({
  containerDefinitions: [{ name: 'job', secrets }, ...extra],
})

test('parametriSsm: nomi e ARN, per regione, senza Secrets Manager', () => {
  const gruppi = parametriSsm(
    td(
      [
        { name: 'DB_PASSWORD', valueFrom: '/demo/job/DB_PASSWORD' },
        { name: 'TOKEN', valueFrom: 'arn:aws:ssm:eu-west-1:111111111111:parameter/demo/job/TOKEN' },
        { name: 'FLAT', valueFrom: 'arn:aws:ssm:eu-west-1:111111111111:parameter/FLAT_KEY' },
        { name: 'ALTRO', valueFrom: 'arn:aws:ssm:us-east-1:111111111111:parameter/demo/other/KEY' },
        { name: 'SM', valueFrom: 'arn:aws:secretsmanager:eu-west-1:111111111111:secret:demo-abc123' },
      ],
      [{ name: 'sidecar', secrets: [{ name: 'DB_PASSWORD', valueFrom: '/demo/job/DB_PASSWORD' }] }],
    ),
    'eu-west-1',
  )
  assert.deepEqual(gruppi, [
    { regione: 'eu-west-1', nomi: ['/demo/job/DB_PASSWORD', '/demo/job/TOKEN', 'FLAT_KEY'] },
    { regione: 'us-east-1', nomi: ['/demo/other/KEY'] },
  ])
})

test('parametriSsm: nessun segreto, nessuna task definition', () => {
  assert.deepEqual(parametriSsm(td([])), [])
  assert.deepEqual(parametriSsm({ containerDefinitions: [{ name: 'job' }] }), [])
  assert.deepEqual(parametriSsm(null), [])
})

test('rilascioJob: la piu recente fra revision e segreto', () => {
  const rev = '2026-01-10T08:00:00Z'
  const revMs = new Date(rev).getTime()
  assert.equal(rilascioJob(rev, null), revMs)
  assert.equal(rilascioJob(rev, revMs - 1000), revMs)
  assert.equal(rilascioJob(rev, revMs + 1000), revMs + 1000)
  assert.equal(rilascioJob(null, 5), 5)
  assert.equal(rilascioJob(null, null), null)
})

test('un segreto riscritto dopo il fallimento rende il job rilasciato, uno di prima no', () => {
  const rev = new Date('2026-01-01T00:00:00Z')
  const fallita = new Date('2026-01-05T03:00:00Z').getTime()
  const dopo = new Date('2026-01-05T15:00:00Z').getTime()
  assert.equal(statoRilascio({ rilascio: rilascioJob(rev, dopo), ultimaFallita: fallita }), 'rilasciato')
  assert.equal(statoRilascio({ rilascio: rilascioJob(rev, fallita - 1), ultimaFallita: fallita }), null)
})
