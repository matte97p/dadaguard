import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOrgAccounts } from '../server/org.js'

const members = [
  { Id: '111111111111', Name: 'Prod', Status: 'ACTIVE' },
  { Id: '222222222222', Name: 'Staging Team', Status: 'ACTIVE' },
  { Id: '333333333333', Name: 'Old', Status: 'SUSPENDED' },
  { Id: '444444444444', Name: 'Sandbox', Status: 'ACTIVE' },
]
const org = {
  roleName: 'dadaguard-readonly',
  externalId: 'secret-x',
  regions: ['eu-west-1', 'us-east-1'],
  exclude: ['444444444444'],
}

test('buildOrgAccounts: salta sospesi/esclusi, costruisce roleArn + sweep', () => {
  const out = buildOrgAccounts(members, org)
  assert.deepEqual(Object.keys(out).sort(), ['prod', 'staging-team'])
  assert.equal(out.prod.roleArn, 'arn:aws:iam::111111111111:role/dadaguard-readonly')
  assert.equal(out.prod.externalId, 'secret-x')
  assert.equal(out.prod.region, 'eu-west-1')
  assert.deepEqual(out.prod.regions, ['eu-west-1', 'us-east-1'])
  assert.equal(out.prod.label, 'Prod')
  assert.equal(out.prod.accountId, '111111111111')
})

test('buildOrgAccounts: roleName di default + exclude per nome', () => {
  const out = buildOrgAccounts(members, { exclude: ['Prod', 'Staging Team', 'Old'] })
  assert.deepEqual(Object.keys(out), ['sandbox'])
  assert.equal(out.sandbox.roleArn, 'arn:aws:iam::444444444444:role/dadaguard-readonly')
})

test('buildOrgAccounts: input vuoto → mappa vuota', () => {
  assert.deepEqual(buildOrgAccounts([], {}), {})
  assert.deepEqual(buildOrgAccounts(undefined, {}), {})
})

test('l’account che OSPITA Dadaguard non si assume da sé: inAccount, non roleArn', () => {
  // Provarci fallisce con un AccessDenied che sembra un problema di permessi mentre è solo la ricetta
  // sbagliata — e quell'account è il payer, cioè proprio dove vive la spesa di Bedrock e Marketplace.
  const out = buildOrgAccounts(
    [
      { Id: '333344445555', Name: 'Acme', Status: 'ACTIVE' },
      { Id: '111122223333', Name: 'Production', Status: 'ACTIVE' },
    ],
    { externalId: 'x' },
    '333344445555',
  )
  assert.equal(out.acme.inAccount, true)
  assert.equal(out.acme.roleArn, undefined)
  assert.equal(out.acme.externalId, undefined) // niente ExternalId: non c'è nessun ruolo da assumere
  assert.equal(out.production.roleArn, 'arn:aws:iam::111122223333:role/dadaguard-readonly')
  assert.equal(out.production.inAccount, undefined)
})

test('senza sapere chi siamo, il comportamento è quello di prima', () => {
  const out = buildOrgAccounts([{ Id: '1', Name: 'Solo', Status: 'ACTIVE' }], {}, null)
  assert.equal(out.solo.roleArn, 'arn:aws:iam::1:role/dadaguard-readonly')
})

test('selfUsesRole: nel proprio account si assume il ruolo come per gli altri', () => {
  // Serve quando in quell'account il ruolo read-only ESISTE: il task role resta minimo (sa solo fare
  // AssumeRole) e si riusa la stessa policy revisionata, invece di duplicare i permessi di lettura.
  const out = buildOrgAccounts(
    [{ Id: '333344445555', Name: 'Acme', Status: 'ACTIVE' }],
    { externalId: 'x', selfUsesRole: true },
    '333344445555',
  )
  assert.equal(out.acme.roleArn, 'arn:aws:iam::333344445555:role/dadaguard-readonly')
  assert.equal(out.acme.inAccount, undefined)
  assert.equal(out.acme.externalId, 'x')
})
