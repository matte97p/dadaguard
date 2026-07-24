import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapPhase, failureOf, mapBuild, deployerOf } from '../server/deploys.js'

test('mapPhase: fase ok → niente messaggio; durata in ms', () => {
  const p = mapPhase({ phaseType: 'BUILD', phaseStatus: 'SUCCEEDED', durationInSeconds: 90 })
  assert.deepEqual(p, { type: 'BUILD', status: 'SUCCEEDED', durationMs: 90_000 })
})

test('mapPhase: fase fallita → include il messaggio dai contexts', () => {
  const p = mapPhase({
    phaseType: 'BUILD',
    phaseStatus: 'FAILED',
    durationInSeconds: 47,
    contexts: [{ statusCode: 'COMMAND_EXECUTION_ERROR', message: 'exit status 1' }],
  })
  assert.equal(p.type, 'BUILD')
  assert.equal(p.status, 'FAILED')
  assert.equal(p.message, 'exit status 1')
})

test('failureOf: prima fase fallita + motivo; null se tutto ok', () => {
  const phases = [
    { phaseType: 'INSTALL', phaseStatus: 'SUCCEEDED' },
    { phaseType: 'BUILD', phaseStatus: 'FAILED', contexts: [{ message: 'boom' }] },
  ]
  assert.deepEqual(failureOf(phases), { phase: 'BUILD', reason: 'boom' })
  assert.equal(failureOf([{ phaseType: 'BUILD', phaseStatus: 'SUCCEEDED' }]), null)
  assert.equal(failureOf([]), null)
})

test('mapBuild: espone fasi, motivo fallimento e logsUrl', () => {
  const out = mapBuild({
    id: 'cato-staging-backend-deploy:abc',
    projectName: 'cato-staging-backend-deploy',
    buildNumber: 39,
    buildStatus: 'FAILED',
    resolvedSourceVersion: 'f7de76ecafe',
    phases: [
      { phaseType: 'DOWNLOAD_SOURCE', phaseStatus: 'SUCCEEDED', durationInSeconds: 5 },
      { phaseType: 'BUILD', phaseStatus: 'FAILED', durationInSeconds: 47, contexts: [{ message: 'exit status 1' }] },
    ],
    logs: { deepLink: 'https://console.aws.amazon.com/cloudwatch/x' },
  })
  assert.equal(out.service, 'backend')
  assert.equal(out.commit, 'f7de76e')
  assert.equal(out.failPhase, 'BUILD')
  assert.equal(out.failReason, 'exit status 1')
  assert.equal(out.logsUrl, 'https://console.aws.amazon.com/cloudwatch/x')
  assert.equal(out.phases.length, 2)
  assert.equal(out.phases[1].message, 'exit status 1')
})

test('deployerOf: legge la exported-variable DEPLOYER; null se assente', () => {
  assert.equal(
    deployerOf({ exportedEnvironmentVariables: [{ name: 'FOO', value: 'x' }, { name: 'DEPLOYER', value: 'mperino@get-cato.com' }] }),
    'mperino@get-cato.com',
  )
  assert.equal(deployerOf({ exportedEnvironmentVariables: [{ name: 'DEPLOYER', value: '' }] }), null)
  assert.equal(deployerOf({ exportedEnvironmentVariables: [] }), null)
  assert.equal(deployerOf({}), null)
})

test('mapBuild: espone author da DEPLOYER (chi ha lanciato)', () => {
  const out = mapBuild({
    id: 'cato-staging-backend-deploy:abc',
    projectName: 'cato-staging-backend-deploy',
    buildStatus: 'SUCCEEDED',
    exportedEnvironmentVariables: [{ name: 'DEPLOYER', value: 'mperino@get-cato.com' }],
  })
  assert.equal(out.author, 'mperino@get-cato.com')
  // build senza la variabile → author null (build vecchi / progetti che non la esportano)
  assert.equal(mapBuild({ projectName: 'cato-staging-backend-deploy', buildStatus: 'SUCCEEDED' }).author, null)
})
