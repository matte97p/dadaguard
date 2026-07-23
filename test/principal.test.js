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

test('principalName: sessione GitHubActions → etichetta CI pulita', () => {
  assert.equal(principalName('arn:aws:sts::123:assumed-role/cato-prod-gha-cron-deploy/GitHubActions'), 'GitHub Actions')
})

test('principalName: sessione CodeBuild (uuid) → nome pipeline dal ruolo, non l’uuid', () => {
  assert.equal(
    principalName('arn:aws:sts::123:assumed-role/cato-production-backend-deploy/AWSCodeBuild-2e6fe04c-74d7-4830'),
    'backend-deploy',
  )
})

test('principalName: sessione custom codebuild-iac → pipeline pulita', () => {
  assert.equal(
    principalName('arn:aws:sts::123:assumed-role/cato-staging-codebuild-iac/codebuild-iac-132'),
    'codebuild-iac',
  )
})

test('principalName: sessione = id macchina/numerico → mostra il ruolo (prettified)', () => {
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
