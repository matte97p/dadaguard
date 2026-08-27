import { test } from 'node:test'
import assert from 'node:assert/strict'
import { principalName, canonicalActor, actorKind, isHumanActor } from '../server/util/principal.js'

test('principalName: IAM user → nome', () => {
  assert.equal(principalName('arn:aws:iam::123456789012:user/alex'), 'alex')
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

// actorKind: la distinzione che mancava fra «una persona ha toccato la produzione» e «l'automazione ha
// fatto il suo lavoro». Gli ARN sono quelli VERI, presi da CloudTrail di questo stack (nomi sostituiti).
test('actorKind: la sessione dice se dietro c’è una persona', () => {
  assert.equal(actorKind('arn:aws:sts::1:assumed-role/AWSReservedSSO_AdministratorAccess_0000/Persona'), 'human')
  assert.equal(actorKind('arn:aws:sts::1:assumed-role/teleport-restart-production/persona'), 'human')
  assert.equal(actorKind('arn:aws:iam::1:user/persona'), 'human')
})

test('actorKind: CodeBuild e GitHub Actions sono CI, non persone che forzano', () => {
  assert.equal(actorKind('arn:aws:sts::1:assumed-role/acme-production-backend-codebuild/AWSCodeBuild-e0ae6391-d8a0-4818-afab-d6fea5eaab83'), 'ci')
  assert.equal(actorKind('arn:aws:sts::1:assumed-role/acme-production-gha-deploy/GitHubActions'), 'ci')
  assert.equal(actorKind('arn:aws:sts::1:assumed-role/acme-staging-codebuild-iac/codebuild-iac-9'), 'ci')
})

test('actorKind: una lambda assume il PROPRIO ruolo (sessione = nome del ruolo) → servizio', () => {
  assert.equal(actorKind('arn:aws:sts::1:assumed-role/acme-production-doppler-ssm-sync/acme-production-doppler-ssm-sync'), 'service')
  assert.equal(actorKind('arn:aws:sts::1:assumed-role/AWSServiceRoleForECS/ecs-service'), 'service')
})

test('actorKind: senza ARN è `unknown`, e unknown NON è una persona', () => {
  assert.equal(actorKind(null), 'unknown')
  assert.equal(actorKind(''), 'unknown')
  assert.equal(actorKind('arn:aws:sts::1:federated-user/qualcuno'), 'human')
  // Attribuire a un umano un'azione di cui non si sa l'autore è il modo più rapido di accusare a torto.
  assert.equal(isHumanActor(null), false)
  assert.equal(isHumanActor('arn:aws:sts::1:assumed-role/acme-gha-deploy/GitHubActions'), false)
  assert.equal(isHumanActor('arn:aws:sts::1:assumed-role/AWSReservedSSO_Ruolo_0000/persona'), true)
})
