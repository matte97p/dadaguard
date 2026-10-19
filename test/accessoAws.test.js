import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessoAccount, comandoAws, linkAws } from '../shared/accessoAws.js'
import { accessoDi, accountsSummary } from '../server/accounts.js'
import { comandoPer } from '../server/meta/stato.js'

const staging = {
  accountId: '111122223333',
  region: 'eu-central-1',
  cliProfile: 'ops-staging',
  ssoRole: 'ReadOnly',
  teleportApp: 'aws-staging',
  teleportRole: 'dashboard-readonly',
}
const cfgTeleport = { teleport: { webUrl: 'https://teleport.example.com' }, sso: { startUrl: 'https://d-x.awsapps.com/start/' } }
const cfgSso = { sso: { startUrl: 'https://d-x.awsapps.com/start' } }

test('accesso: Teleport quando l\'installazione lo ha, SSO altrimenti', () => {
  assert.equal(accessoDi(staging, cfgTeleport).modo, 'teleport')
  assert.equal(accessoDi(staging, cfgSso).modo, 'sso')
  // l'account senza app Teleport resta su SSO anche dove Teleport c'e'
  assert.equal(accessoDi({ ...staging, teleportApp: undefined }, cfgTeleport).modo, 'sso')
  assert.equal(accessoAccount(null), null)
})

test('comando: tsh aws con Teleport, --profile con SSO, region del servizio in fondo', () => {
  const cmd = "aws ecs describe-services --cluster 'c' --services 's'"
  assert.equal(
    comandoAws(cmd, accessoDi(staging, cfgTeleport)),
    "tsh aws --app 'aws-staging' --aws-role 'dashboard-readonly' ecs describe-services --cluster 'c' --services 's' --region 'eu-central-1'",
  )
  assert.equal(comandoAws(cmd, accessoDi(staging, cfgSso), { region: 'eu-west-1' }), `${cmd} --region 'eu-west-1' --profile 'ops-staging'`)
  assert.equal(comandoAws('terragrunt run-all plan', accessoDi(staging, cfgTeleport)), 'terragrunt run-all plan')
  assert.equal(comandoAws(cmd, null), cmd)
})

test('comando dei servizi: la stessa strada passa da arricchisciServizio', () => {
  const c = comandoPer('liveness', 'ecs', { cluster: 'c', service: 's' }, { accesso: accessoDi(staging, cfgTeleport), region: 'eu-central-1' })
  assert.match(c, /^tsh aws --app 'aws-staging' --aws-role 'dashboard-readonly' ecs describe-services /)
  assert.doesNotMatch(c, /--profile/)
})

test('link: launcher Teleport con path, portale SSO con destination, diretto senza nessuno', () => {
  const url = 'https://eu-central-1.console.aws.amazon.com/ecs/v2/clusters/c/services/s/health?region=eu-central-1#x'
  assert.equal(
    linkAws(url, accessoDi(staging, cfgTeleport)),
    'https://teleport.example.com/web/launch/aws-staging.teleport.example.com/teleport.example.com/aws-staging.teleport.example.com/arn%3Aaws%3Aiam%3A%3A111122223333%3Arole%2Fdashboard-readonly?path=%2Fecs%2Fv2%2Fclusters%2Fc%2Fservices%2Fs%2Fhealth%3Fregion%3Deu-central-1%23x',
  )
  assert.equal(
    linkAws(url, accessoDi(staging, cfgSso)),
    `https://d-x.awsapps.com/start/#/console?account_id=111122223333&role_name=ReadOnly&destination=${encodeURIComponent(url)}`,
  )
  assert.equal(linkAws(url, accessoDi({ region: 'eu-central-1' }, {})), url)
  // non console: invariato
  assert.equal(linkAws('https://github.com/o/r/commit/abc', accessoDi(staging, cfgTeleport)), 'https://github.com/o/r/commit/abc')
})

test('link Teleport senza account id: il ruolo per nome non basta, si ripiega sul portale o sul diretto', () => {
  const url = 'https://console.aws.amazon.com/billing/home#/freetier'
  const senzaId = { ...staging, accountId: undefined }
  assert.equal(linkAws(url, accessoDi(senzaId, cfgTeleport)), url)
  // il comando invece funziona: tsh aws accetta il nome del ruolo
  assert.match(comandoAws('aws sts get-caller-identity', accessoDi(senzaId, cfgTeleport)), /^tsh aws /)
  // un ARN intero non ha bisogno dell'id
  const arn = 'arn:aws:iam::1:role/r'
  assert.match(linkAws(url, accessoDi({ ...senzaId, teleportRole: arn }, cfgTeleport)), /arn%3Aaws%3Aiam%3A%3A1%3Arole%2Fr\?path=/)
})

test('accountsSummary: porta la strada alla pagina, senza segreti', () => {
  const [a] = accountsSummary({ staging: { ...staging, roleArn: 'arn:x', externalId: 'segreto', profile: 'p' } }, cfgTeleport)
  assert.equal(a.accesso.modo, 'teleport')
  assert.doesNotMatch(JSON.stringify(a), /segreto/)
})
