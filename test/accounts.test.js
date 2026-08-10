// Un account può avere spesa e ZERO servizi monitorati: è il caso del payer (dove vivono Bedrock e
// CodeBuild) e di un account di sicurezza. Ricavando le liste dai servizi quegli account sparivano
// dalle pagine per-account — senza un messaggio, che è il modo peggiore: chi guarda conclude "non
// costa niente" invece di "non lo sto guardando".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQueryable, queryableAccounts, accountsSummary } from '../server/accounts.js'

test('interrogabile con profilo, ruolo, o credenziali dell’ambiente', () => {
  assert.equal(isQueryable({ profile: 'staging' }), true)
  assert.equal(isQueryable({ roleArn: 'arn:aws:iam::1:role/x' }), true)
  assert.equal(isQueryable({ inAccount: true }), true)
})

test('un account senza credenziali NON è interrogabile: è solo un’etichetta', () => {
  // Interrogarlo userebbe le credenziali dell'ambiente per sbaglio, cioè leggerebbe l'account
  // sbagliato riportandone i dati sotto un altro nome.
  assert.equal(isQueryable({ label: 'Security', accountId: '444455556666' }), false)
  assert.equal(isQueryable({}), false)
  assert.equal(isQueryable(null), false)
})

test('queryableAccounts tiene solo quelli leggibili, come coppie', () => {
  const out = queryableAccounts({
    staging: { roleArn: 'arn:1' },
    management: { inAccount: true },
    security: { label: 'Security' },
  })
  assert.deepEqual(
    out.map(([k]) => k),
    ['staging', 'management'],
  )
})

test('accountsSummary elenca TUTTI gli account, dicendo quali sono leggibili', () => {
  // Tutti, anche i non interrogabili: nelle liste ci vanno, così si vede che esistono; è il `queryable`
  // a dire che di quello non si può leggere niente.
  const out = accountsSummary({
    prod: { label: 'Production', color: '#cf1322', region: 'eu-central-1', roleArn: 'arn:1' },
    security: { accountId: '9' },
  })
  assert.deepEqual(out, [
    { key: 'prod', label: 'Production', color: '#cf1322', region: 'eu-central-1', queryable: true },
    { key: 'security', label: 'security', color: null, region: null, queryable: false },
  ])
})

test('nessun account: lista vuota, non un errore', () => {
  assert.deepEqual(accountsSummary(undefined), [])
  assert.deepEqual(queryableAccounts(null), [])
})
