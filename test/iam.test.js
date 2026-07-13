import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStatements, resourceCovers, matchStatements } from '../server/iam.js'

test('resourceCovers: "*" → hit ampio (broad)', () => {
  assert.deepEqual(resourceCovers('*', 'avvista'), { hit: true, broad: true })
})

test('resourceCovers: ARN che nomina la risorsa → hit puntuale', () => {
  assert.deepEqual(resourceCovers('arn:aws:rds:eu-central-1:1:db:avvista', 'avvista'), { hit: true, broad: false })
})

test('resourceCovers: ARN non correlato → nessun hit', () => {
  assert.deepEqual(resourceCovers('arn:aws:s3:::altro-bucket', 'avvista'), { hit: false, broad: false })
  assert.deepEqual(resourceCovers('*', ''), { hit: false, broad: false }) // needle vuoto
})

test('matchStatements: policy con Resource:"*" (es. AdministratorAccess) → hit broad', () => {
  const stmts = parseStatements({ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] })
  const m = matchStatements(stmts, 'avvista')
  assert.equal(m.hit, true)
  assert.equal(m.broad, true) // il match passa solo da "*" → accesso ampio
  assert.deepEqual(m.actions, ['*'])
})

test('matchStatements: match puntuale (ARN nominato) → non broad', () => {
  const stmts = parseStatements({
    Statement: [{ Effect: 'Allow', Action: ['rds-db:connect'], Resource: ['arn:aws:rds-db:eu-central-1:1:dbuser:avvista/app'] }],
  })
  const m = matchStatements(stmts, 'avvista')
  assert.equal(m.hit, true)
  assert.equal(m.broad, false)
  assert.deepEqual(m.actions, ['rds-db:connect'])
})

test('matchStatements: mix puntuale + wildcard → non broad (almeno uno nomina la risorsa)', () => {
  const stmts = parseStatements({
    Statement: [
      { Effect: 'Allow', Action: 's3:*', Resource: '*' },
      { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::avvista-dumps/*' },
    ],
  })
  const m = matchStatements(stmts, 'avvista')
  assert.equal(m.hit, true)
  assert.equal(m.broad, false)
})

test('matchStatements: nessuno statement tocca la risorsa → no hit', () => {
  const stmts = parseStatements({ Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: 'arn:aws:s3:::altro/*' }] })
  assert.equal(matchStatements(stmts, 'avvista').hit, false)
})

test('matchStatements: gli statement Deny non contano (parseStatements filtra Allow)', () => {
  const stmts = parseStatements({ Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }] })
  assert.equal(matchStatements(stmts, 'avvista').hit, false)
})
