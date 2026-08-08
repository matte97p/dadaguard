import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isForcedRestart, restartRow, startEntry, viaTeleportRole, isHotfixRole, serviceFromEcs } from '../server/manualActions.js'
import { resolveTrigger, mapBuild } from '../server/deploys.js'

// Evento CloudTrail sintetico: la forma è quella vera (CloudTrailEvent è una STRINGA JSON).
const ctEvent = (rec, { EventId = 'e1', EventTime = '2026-08-08T02:00:00Z' } = {}) => ({
  EventId,
  EventTime,
  CloudTrailEvent: JSON.stringify(rec),
})

const updateService = (req, extra = {}) =>
  ctEvent({
    eventName: 'UpdateService',
    requestParameters: req,
    userIdentity: { arn: 'arn:aws:sts::521:assumed-role/teleport-restart-production/matte97p' },
    ...extra,
  })

test('isForcedRestart: solo forceNewDeployment SENZA taskDefinition', () => {
  assert.equal(isForcedRestart({ cluster: 'cato-production', service: 'backend', forceNewDeployment: true }), true)
  // il passo finale di una build: registra la revision e aggiorna → NON è un riavvio a mano
  assert.equal(isForcedRestart({ service: 'backend', forceNewDeployment: true, taskDefinition: 'backend:412' }), false)
  assert.equal(isForcedRestart({ service: 'backend', desiredCount: 3 }), false)
  assert.equal(isForcedRestart({}), false)
})

test('restartRow: riga con chi ha premuto, cluster e "stessa immagine"', () => {
  const row = restartRow(updateService({ cluster: 'cato-production', service: 'backend', forceNewDeployment: true }))
  assert.equal(row.kind, 'restart')
  assert.equal(row.provider, 'ecs')
  assert.equal(row.service, 'backend')
  assert.equal(row.cluster, 'cato-production')
  assert.equal(row.status, 'SUCCEEDED')
  assert.equal(row.trigger, 'restart')
  assert.equal(row.forcedBy, 'matte97p')
  assert.equal(row.viaTeleport, true)
  assert.equal(row.commit, null)
  assert.equal(row.durationMs, null)
})

test('restartRow: null se non è un riavvio forzato (niente doppioni dei rilasci normali)', () => {
  assert.equal(restartRow(updateService({ service: 'backend', forceNewDeployment: true, taskDefinition: 'backend:412' })), null)
  assert.equal(restartRow({ CloudTrailEvent: 'non-json' }), null)
  assert.equal(restartRow({}), null)
})

test('restartRow: un tentativo RESPINTO si vede, con il motivo', () => {
  const row = restartRow(
    updateService(
      { cluster: 'cato-production', service: 'backend', forceNewDeployment: true },
      { errorCode: 'AccessDenied', errorMessage: 'not authorized to perform ecs:UpdateService' },
    ),
  )
  assert.equal(row.status, 'FAILED')
  assert.match(row.failReason, /^AccessDenied: not authorized/)
})

test('startEntry: chiave = ARN della build, e riconosce l’hotfix dal ruolo', () => {
  const e = ctEvent({
    eventName: 'StartBuild',
    requestParameters: { projectName: 'cato-production-backend-deploy' },
    responseElements: { build: { arn: 'arn:aws:codebuild:eu-central-1:521:build/x:1', id: 'x:1' } },
    userIdentity: { arn: 'arn:aws:sts::521:assumed-role/teleport-hotfix-production/matte97p' },
  })
  const [key, val] = startEntry(e)
  assert.equal(key, 'arn:aws:codebuild:eu-central-1:521:build/x:1')
  assert.deepEqual(val, { forcedBy: 'matte97p', viaTeleport: true, hotfix: true })
})

test('startEntry: tentativo respinto o senza build → nessuna attribuzione', () => {
  assert.equal(startEntry(ctEvent({ eventName: 'StartBuild', errorCode: 'AccessDenied' })), null)
  assert.equal(startEntry(ctEvent({ eventName: 'StartBuild', responseElements: {} })), null)
})

test('viaTeleportRole / isHotfixRole: distinguono i due ruoli, e ignorano il resto', () => {
  const hotfix = 'arn:aws:sts::521:assumed-role/teleport-hotfix-production/matte97p'
  const restart = 'arn:aws:sts::521:assumed-role/teleport-restart-staging/matte97p'
  const sso = 'arn:aws:sts::521:assumed-role/AWSReservedSSO_AdministratorAccess_x/matteo@get-cato.com'
  assert.equal(isHotfixRole(hotfix), true)
  assert.equal(isHotfixRole(restart), false)
  assert.equal(isHotfixRole(sso), false)
  assert.equal(viaTeleportRole(restart), true)
  assert.equal(viaTeleportRole(sso), false)
  assert.equal(viaTeleportRole(null), false)
})

test('serviceFromEcs: toglie il prefisso ambiente, così build e riavvio finiscono nello stesso gruppo', () => {
  assert.equal(serviceFromEcs('backend'), 'backend')
  assert.equal(serviceFromEcs('cato-production-backend'), 'backend')
  assert.equal(serviceFromEcs(''), '')
})

test('resolveTrigger: auto vince sempre; senza CloudTrail resta manuale', () => {
  assert.equal(resolveTrigger('cato-production-gha-deploy/GitHubActions', null), 'auto')
  // anche se per assurdo CloudTrail dicesse hotfix, un initiator della CI resta auto
  assert.equal(resolveTrigger('cato-production-gha-deploy/GitHubActions', { hotfix: true }), 'auto')
  assert.equal(resolveTrigger('matte97p', null), 'manuale')
  assert.equal(resolveTrigger('matte97p', { hotfix: false }), 'manuale')
  assert.equal(resolveTrigger('matte97p', { hotfix: true }), 'hotfix')
})

test('mapBuild: lo starter porta chi ha premuto, che NON è l’autore del commit', () => {
  const out = mapBuild(
    {
      id: 'cato-production-backend-deploy:abc',
      arn: 'arn:aws:codebuild:eu-central-1:521:build/x:1',
      projectName: 'cato-production-backend-deploy',
      buildStatus: 'SUCCEEDED',
      initiator: 'matte97p',
      exportedEnvironmentVariables: [{ name: 'DEPLOYER', value: 'ggiacometti@get-cato.com' }],
    },
    { forcedBy: 'matte97p', viaTeleport: true, hotfix: true },
  )
  assert.equal(out.trigger, 'hotfix')
  assert.equal(out.forcedBy, 'matte97p')
  assert.equal(out.viaTeleport, true)
  assert.equal(out.author, 'ggiacometti@get-cato.com')
  // senza starter il comportamento è quello di prima
  const plain = mapBuild({ projectName: 'cato-production-backend-deploy', buildStatus: 'SUCCEEDED', initiator: 'matte97p' })
  assert.equal(plain.trigger, 'manuale')
  assert.equal(plain.forcedBy, null)
})
