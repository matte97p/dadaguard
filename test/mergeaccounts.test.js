// Accendere la scoperta degli account non deve far perdere quello che era stato dichiarato a mano:
// `terraform.stateBucket` alimenta i segnali di drift e risorse non gestite, e se sparisce quei
// controlli smettono di funzionare SENZA dire niente. È il tipo di guasto che si scopre settimane
// dopo, quando serve.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeAccounts } from '../server/status.js'

const discovered = {
  staging: { label: 'Staging', accountId: '1', roleArn: 'arn:1', externalId: 'x', region: 'eu-central-1' },
  security: { label: 'Security', accountId: '9', roleArn: 'arn:9', externalId: 'x', region: 'eu-central-1' },
}
const declared = {
  staging: { label: 'Staging', color: '#1677ff', terraform: { stateBucket: 'acme-tf-state-staging', env: 'staging' } },
}

test('il dichiarato vince campo per campo, e non perde niente', () => {
  const out = mergeAccounts(discovered, declared)
  assert.equal(out.staging.color, '#1677ff') // c'era solo nel dichiarato
  assert.equal(out.staging.terraform.stateBucket, 'acme-tf-state-staging') // il pezzo che fa i drift
  assert.equal(out.staging.roleArn, 'arn:1') // e prende dal scoperto ciò che non aveva
  assert.equal(out.staging.accountId, '1')
})

test('un account scoperto che nessuno ha dichiarato entra così com’è', () => {
  const out = mergeAccounts(discovered, declared)
  assert.deepEqual(out.security, discovered.security)
  assert.deepEqual(Object.keys(out).sort(), ['security', 'staging'])
})

test('un account dichiarato che l’org non conosce resta', () => {
  // Es. Cloudflare, o un account fuori dall'organizzazione: sparire sarebbe una regressione.
  const out = mergeAccounts({}, { cloudflare: { label: 'Cloudflare' } })
  assert.deepEqual(out, { cloudflare: { label: 'Cloudflare' } })
})

test('mappe vuote o assenti: nessun errore', () => {
  assert.deepEqual(mergeAccounts(), {})
  assert.deepEqual(mergeAccounts(undefined, undefined), {})
})
