import { test } from 'node:test'
import assert from 'node:assert/strict'
import { principalName, canonicalActor} from '../server/util/principal.js'

test('principalName: IAM user → nome', () => {
  assert.equal(principalName('arn:aws:iam::123456789012:user/matteo'), 'matteo')
})

test('principalName: assumed-role SSO → sessione (la persona)', () => {
  assert.equal(
    principalName('arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Ruolo_0000/sam@example.com'),
    'sam@example.com',
  )
})

test('principalName: sessione GitHubActions → etichetta CI pulita', () => {
  assert.equal(principalName('arn:aws:sts::123:assumed-role/acme-prod-gha-cron-deploy/GitHubActions'), 'GitHub Actions')
})

test('principalName: sessione CodeBuild (uuid) → nome pipeline dal ruolo, non l’uuid', () => {
  assert.equal(
    principalName('arn:aws:sts::123:assumed-role/acme-production-backend-deploy/AWSCodeBuild-2e6fe04c-74d7-4830'),
    'backend-deploy',
  )
})

test('principalName: sessione custom codebuild-iac → pipeline pulita', () => {
  assert.equal(
    principalName('arn:aws:sts::123:assumed-role/acme-staging-codebuild-iac/codebuild-iac-132'),
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

test('canonicalActor: la mappa alias unisce due identità git della stessa persona', () => {
  // Da noi la stessa persona committa come `alex@example.com` e
  // `alex.rossi@mail.example.org`: il pannello mostrava due nomi e sembravano due colleghi.
  const people = { 'alex.rossi@mail.example.org': 'alex' }
  assert.equal(canonicalActor('alex.rossi@mail.example.org', people), 'alex')
  assert.equal(canonicalActor('alex@example.com', people), 'alex') // già canonico
})

test('canonicalActor: la chiave vale anche sulla forma accorciata, senza maiuscole', () => {
  assert.equal(canonicalActor('Alex.Rossi@mail.example.org', { 'alex.rossi@mail.example.org': 'ar' }), 'ar')
  assert.equal(canonicalActor('mario.rossi@example.com', { 'mario.rossi': 'mrossi' }), 'mrossi')
})

test('canonicalActor: senza alias si comporta come prima, e regge il vuoto', () => {
  assert.equal(canonicalActor('12345678+dev@users.noreply.github.com'), 'dev')
  assert.equal(canonicalActor('alex@example.com', null), 'alex')
  assert.equal(canonicalActor(''), null)
  assert.equal(canonicalActor(undefined, { a: 'b' }), null)
})
