import { test } from 'node:test'
import assert from 'node:assert/strict'
import { principalName } from '../server/util/principal.js'

test('principalName: IAM user → nome', () => {
  assert.equal(principalName('arn:aws:iam::123456789012:user/matteo'), 'matteo')
})

test('principalName: assumed-role SSO → sessione (la persona)', () => {
  assert.equal(
    principalName('arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/matteo@get-cato.com'),
    'matteo@get-cato.com',
  )
})

test('principalName: assumed-role CI → nome sessione', () => {
  assert.equal(principalName('arn:aws:sts::123:assumed-role/cato-prod-deploy/GitHubActions'), 'GitHubActions')
})

test('principalName: sessione = id macchina/numerico → mostra il ruolo', () => {
  assert.equal(principalName('arn:aws:sts::123:assumed-role/SomeRole/i-0abc123def'), 'SomeRole')
  assert.equal(principalName('arn:aws:sts::123:assumed-role/SomeRole/1699999999'), 'SomeRole')
})

test('principalName: role/<name>', () => {
  assert.equal(principalName('arn:aws:iam::123:role/deployer'), 'deployer')
})

test('principalName: null/vuoto → null', () => {
  assert.equal(principalName(null), null)
  assert.equal(principalName(''), null)
  assert.equal(principalName(undefined), null)
})
