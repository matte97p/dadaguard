import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isForcedRestart, restartRow, startEntry, viaTeleportRole, isHotfixRole, serviceFromEcs , sgRow, execRow } from '../server/manualActions.js'
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
  assert.equal(isForcedRestart({ cluster: 'acme-production', service: 'backend', forceNewDeployment: true }), true)
  // il passo finale di una build: registra la revision e aggiorna → NON è un riavvio a mano
  assert.equal(isForcedRestart({ service: 'backend', forceNewDeployment: true, taskDefinition: 'backend:412' }), false)
  assert.equal(isForcedRestart({ service: 'backend', desiredCount: 3 }), false)
  assert.equal(isForcedRestart({}), false)
})

test('restartRow: riga con chi ha premuto, cluster e "stessa immagine"', () => {
  const row = restartRow(updateService({ cluster: 'acme-production', service: 'backend', forceNewDeployment: true }))
  assert.equal(row.kind, 'restart')
  assert.equal(row.provider, 'ecs')
  assert.equal(row.service, 'backend')
  assert.equal(row.cluster, 'acme-production')
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
      { cluster: 'acme-production', service: 'backend', forceNewDeployment: true },
      { errorCode: 'AccessDenied', errorMessage: 'not authorized to perform ecs:UpdateService' },
    ),
  )
  assert.equal(row.status, 'FAILED')
  assert.match(row.failReason, /^AccessDenied: not authorized/)
})

test('startEntry: chiave = ARN della build, e riconosce l’hotfix dal ruolo', () => {
  const e = ctEvent({
    eventName: 'StartBuild',
    requestParameters: { projectName: 'acme-production-backend-deploy' },
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
  const sso = 'arn:aws:sts::521:assumed-role/AWSReservedSSO_Ruolo_0000/sam@example.com'
  assert.equal(isHotfixRole(hotfix), true)
  assert.equal(isHotfixRole(restart), false)
  assert.equal(isHotfixRole(sso), false)
  assert.equal(viaTeleportRole(restart), true)
  assert.equal(viaTeleportRole(sso), false)
  assert.equal(viaTeleportRole(null), false)
})

test('serviceFromEcs: toglie il prefisso ambiente, così build e riavvio finiscono nello stesso gruppo', () => {
  assert.equal(serviceFromEcs('backend'), 'backend')
  assert.equal(serviceFromEcs('acme-production-backend'), 'backend')
  assert.equal(serviceFromEcs(''), '')
})

test('resolveTrigger: auto vince sempre; senza CloudTrail resta manuale', () => {
  assert.equal(resolveTrigger('acme-production-gha-deploy/GitHubActions', null), 'auto')
  // anche se per assurdo CloudTrail dicesse hotfix, un initiator della CI resta auto
  assert.equal(resolveTrigger('acme-production-gha-deploy/GitHubActions', { hotfix: true }), 'auto')
  assert.equal(resolveTrigger('matte97p', null), 'manuale')
  assert.equal(resolveTrigger('matte97p', { hotfix: false }), 'manuale')
  assert.equal(resolveTrigger('matte97p', { hotfix: true }), 'hotfix')
})

test('mapBuild: lo starter porta chi ha premuto, che NON è l’autore del commit', () => {
  const out = mapBuild(
    {
      id: 'acme-production-backend-deploy:abc',
      arn: 'arn:aws:codebuild:eu-central-1:521:build/x:1',
      projectName: 'acme-production-backend-deploy',
      buildStatus: 'SUCCEEDED',
      initiator: 'matte97p',
      exportedEnvironmentVariables: [{ name: 'DEPLOYER', value: 'alex@example.com' }],
    },
    { forcedBy: 'matte97p', viaTeleport: true, hotfix: true },
  )
  assert.equal(out.trigger, 'hotfix')
  assert.equal(out.forcedBy, 'matte97p')
  assert.equal(out.viaTeleport, true)
  assert.equal(out.author, 'alex@example.com')
  // senza starter il comportamento è quello di prima
  const plain = mapBuild({ projectName: 'acme-production-backend-deploy', buildStatus: 'SUCCEEDED', initiator: 'matte97p' })
  assert.equal(plain.trigger, 'manuale')
  assert.equal(plain.forcedBy, null)
})

// --- break-glass e shell nei container: le due azioni che non lasciavano traccia ---
// `sg-allow open` apre una porta a mano su un security group: serve quando Teleport o IAM sono giù,
// lascia drift rispetto a Terragrunt e VA RICHIUSA. Finora «chi ha aperto cosa e non l'ha richiuso»
// era una domanda senza risposta, e la risposta stava in CloudTrail da sempre.
const eventoSg = (nome, extra = {}) => ({
  EventId: 'e1',
  EventTime: '2026-08-13T18:00:00Z',
  CloudTrailEvent: JSON.stringify({
    eventName: nome,
    eventTime: '2026-08-13T18:00:00Z',
    userIdentity: { arn: 'arn:aws:sts::1:assumed-role/AWSReservedSSO_Admin_abc/persona' },
    requestParameters: { groupId: 'sg-0abc', ipPermissions: { items: [{ fromPort: 5432, toPort: 5432 }] } },
    ...extra,
  }),
})

test('apertura di un security group: riga di break-glass, con porta e con chi', () => {
  const r = sgRow(eventoSg('AuthorizeSecurityGroupIngress'))
  assert.equal(r.kind, 'sg-open')
  assert.equal(r.service, 'sg-0abc')
  assert.deepEqual(r.porte, [5432])
  // Il trigger è una CHIAVE, non una frase: la frase (tradotta) la scrive la UI.
  assert.equal(r.trigger, 'sg-open')
  assert.equal(r.forcedBy, 'persona')
  assert.equal(r.status, 'SUCCEEDED')
})

test('chiusura: la riga gemella, così le due insieme dicono se è ancora aperta', () => {
  assert.equal(sgRow(eventoSg('RevokeSecurityGroupIngress')).kind, 'sg-close')
  assert.equal(sgRow(eventoSg('RevokeSecurityGroupIngress')).trigger, 'sg-close')
})

test('security group: la forma senza `items` (altro SDK) non diventa «porta ignota»', () => {
  const r = sgRow(eventoSg('AuthorizeSecurityGroupIngress', { requestParameters: { groupId: 'sg-1', ipPermissions: [{ fromPort: 22 }] } }))
  assert.deepEqual(r.porte, [22])
})

test('un tentativo RESPINTO si vede: un break-glass negato spiega perché si è rimasti fuori', () => {
  const r = sgRow(eventoSg('AuthorizeSecurityGroupIngress', { errorCode: 'UnauthorizedOperation', errorMessage: 'no' }))
  assert.equal(r.status, 'FAILED')
  assert.match(r.failReason, /UnauthorizedOperation/)
})

test('shell dentro a un container: tracciata, perché vede tutti i segreti del servizio', () => {
  const r = execRow({
    EventId: 'e2',
    EventTime: '2026-08-13T19:00:00Z',
    CloudTrailEvent: JSON.stringify({
      eventName: 'ExecuteCommand',
      userIdentity: { arn: 'arn:aws:sts::1:assumed-role/teleport-restart-production/persona' },
      requestParameters: { cluster: 'acme-production', container: 'backend', task: 'abc' },
    }),
  })
  assert.equal(r.kind, 'exec')
  assert.equal(r.trigger, 'exec')
  // Il nome della riga è il CONTAINER in cui si è entrati, non l'ambiente: sei shell nello stesso
  // cluster sono sei righe identiche se ci si mette il cluster, e non si capisce dove sia entrato chi.
  assert.equal(r.service, 'backend')
  assert.equal(r.cluster, 'acme-production')
  assert.equal(r.viaTeleport, true, 'passata da Teleport: sessione registrata')
  assert.equal(r.forcedBy, 'persona')
})

test('shell senza il container nell’evento: si ricade sul cluster invece di lasciare la riga senza nome', () => {
  const r = execRow({
    EventId: 'e3',
    EventTime: '2026-08-13T19:00:00Z',
    CloudTrailEvent: JSON.stringify({
      eventName: 'ExecuteCommand',
      userIdentity: { arn: 'arn:aws:sts::1:assumed-role/ruolo/persona' },
      requestParameters: { cluster: 'acme-production', task: 'abc' },
    }),
  })
  assert.ok(r.service, 'una riga senza nome non si mostra a nessuno')
})
