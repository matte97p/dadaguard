import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'

// #6 META-SALUTE: la plumbing del watchdog stesso. Se Dadaguard non riesce ad assumere il
// ruolo read-only in un account (credenziali scadute, trust rotta, ExternalId sbagliato),
// TUTTI i segnali di quell'account sarebbero falsamente "unknown" — e non lo sapresti.
// STS GetCallerIdentity è la sonda universale: read-only, sempre permessa, conferma che
// l'assunzione del ruolo / la catena di credenziali funziona e ritorna l'identità risolta.

// Pura/testabile: riassume i risultati per il pallino in header.
export function summarizeHealth(accounts) {
  const anyFail = accounts.some((a) => !a.ok)
  const allOk = accounts.length > 0 && accounts.every((a) => a.ok)
  return { allOk, anyFail, status: anyFail ? 'down' : allOk ? 'up' : 'unknown' }
}

export async function selfCheck(accounts, t = (k) => k) {
  const entries = Object.entries(accounts ?? {})
  const results = await Promise.all(
    entries.map(async ([key, a]) => {
      const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: a.region }
      try {
        const sts = new STSClient(clientOpts(aws))
        const id = await sts.send(new GetCallerIdentityCommand({}))
        return {
          key, label: a.label ?? key, color: a.color ?? null,
          ok: true, account: id.Account ?? null, arn: id.Arn ?? null,
          via: a.roleArn ? 'roleArn' : a.profile ? 'profile' : 'default',
        }
      } catch (err) {
        return { key, label: a.label ?? key, color: a.color ?? null, ok: false, error: cleanAwsReason(err, t) }
      }
    }),
  )
  return { accounts: results, ...summarizeHealth(results) }
}
