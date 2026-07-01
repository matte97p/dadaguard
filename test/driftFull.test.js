import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactPlan, classifyPlan } from '../server/driftFull.js'

test('redactPlan: maschera il valore ma tiene la chiave e la struttura', () => {
  const out = redactPlan('        ~ "DB_PASSWORD" = "supersecret"')
  assert.match(out, /"DB_PASSWORD"/) // la chiave resta
  assert.doesNotMatch(out, /supersecret/) // il valore NON esce in chiaro
  assert.match(out, /\(redacted\)/)
})

test('redactPlan: redige ENTRAMBI i lati di un diff ->', () => {
  const out = redactPlan('      ~ url = "postgres://u:p@old/db" -> "postgres://u:p@new/db"')
  assert.doesNotMatch(out, /postgres/)
  assert.match(out, /\(redacted\) -> \(redacted\)/)
})

test('redactPlan: NON tocca tipi/nomi di risorsa (non sono segreti)', () => {
  const out = redactPlan('  ~ resource "aws_lambda_function" "api" {')
  assert.match(out, /"aws_lambda_function"/)
  assert.match(out, /"api"/)
})

test('classifyPlan: solo aggiunte = pending (non drift)', () => {
  assert.equal(classifyPlan('done', 2, 'Plan: 3 to add, 0 to change, 0 to destroy').kind, 'pending')
})

test('classifyPlan: change/destroy = drift', () => {
  assert.equal(classifyPlan('done', 2, 'Plan: 0 to add, 1 to change, 2 to destroy').kind, 'drift')
})
