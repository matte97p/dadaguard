import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAwsProfiles, accountsFromProfiles } from '../server/awsProfiles.js'

// Estratto realistico di ~/.aws/config: profili SSO + varianti -ro/dev- dello stesso account,
// una [default] senza account, una [sso-session] e commenti di riga.
const CONFIG = `
sso_region = eu-central-1

[profile staging]
sso_account_id = 521595303218
region = eu-central-1

[profile production]
sso_account_id = 051986612631
region = eu-central-1

[profile management]
sso_account_id = 708895069864
region = eu-central-1

# security account (audit)
[profile security]
sso_account_id = 973584726014
region         = eu-central-1

[profile staging-ro]
sso_account_id = 521595303218
region = eu-central-1

[profile dev-prod]
sso_account_id = 051986612631
region = eu-central-1

[default]
region = eu-central-1

[sso-session cato]
sso_start_url = https://example.awsapps.com/start
sso_region = eu-central-1
`

test('parseAwsProfiles: solo profili con sso_account_id (salta default/sso-session/commenti)', () => {
  const p = parseAwsProfiles(CONFIG)
  assert.deepEqual(
    p.map((x) => x.name).sort(),
    ['dev-prod', 'management', 'production', 'security', 'staging', 'staging-ro'],
  )
  const staging = p.find((x) => x.name === 'staging')
  assert.equal(staging.accountId, '521595303218')
  assert.equal(staging.region, 'eu-central-1')
})

test('accountsFromProfiles: dedup per accountId, preferisce il profilo primario (no -ro / dev-)', () => {
  const out = accountsFromProfiles(parseAwsProfiles(CONFIG))
  // un account per id: staging (non staging-ro), production (non dev-prod), management, security
  assert.deepEqual(Object.keys(out).sort(), ['management', 'production', 'security', 'staging'])
  assert.equal(out.staging.profile, 'staging')
  assert.equal(out.production.profile, 'production')
  assert.equal(out.security.accountId, '973584726014')
  assert.equal(out.security.label, 'Security')
  assert.equal(out.security.discovered, true)
  assert.match(out.security.color, /^#[0-9a-f]{6}$/i)
})

test('accountsFromProfiles: color stabile per accountId (indipendente dall`ordine)', () => {
  const a = accountsFromProfiles(parseAwsProfiles(CONFIG))
  const b = accountsFromProfiles(parseAwsProfiles(CONFIG).reverse())
  assert.equal(a.security.color, b.security.color)
})

test('accountsFromProfiles: exclude per Id o Nome', () => {
  const byId = accountsFromProfiles(parseAwsProfiles(CONFIG), { exclude: ['973584726014'] })
  assert.ok(!('security' in byId))
  const byName = accountsFromProfiles(parseAwsProfiles(CONFIG), { exclude: ['security'] })
  assert.ok(!('security' in byName))
})

test('parseAwsProfiles: input vuoto → nessun profilo', () => {
  assert.deepEqual(parseAwsProfiles(''), [])
  assert.deepEqual(parseAwsProfiles(undefined), [])
})
