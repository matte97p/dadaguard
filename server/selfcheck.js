import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'
import { probeSurfaces, aggregateSurfaces } from './access.js'
import { probeExposure } from './exposure.js'

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

export async function selfCheck(accounts, t = (k) => k, publicUrl = null) {
  const entries = Object.entries(accounts ?? {})
  const results = await Promise.all(
    entries.map(async ([key, a]) => {
      const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: a.region }
      try {
        const sts = new STSClient(clientOpts(aws))
        const id = await sts.send(new GetCallerIdentityCommand({}))
        // Riusa l'identità appena risolta per capire cosa il ruolo può fare (SimulatePrincipalPolicy):
        // così l'header nasconde le superfici a cui questo account non ha accesso. `allowed` è interno
        // (Set → non serializzabile): resta nella tupla per l'aggregazione, non finisce nella risposta.
        const allowed = await probeSurfaces(aws, id.Arn)
        return {
          key, label: a.label ?? key, color: a.color ?? null,
          ok: true, account: id.Account ?? null, arn: id.Arn ?? null,
          via: a.roleArn ? 'roleArn' : a.profile ? 'profile' : 'default',
          allowed,
        }
      } catch (err) {
        return { key, label: a.label ?? key, color: a.color ?? null, ok: false, error: cleanAwsReason(err, t), allowed: null }
      }
    }),
  )
  // `surfaces`: stato per superficie aggregato su tutti gli account (allowed/denied/unknown) → l'header.
  const surfaces = aggregateSurfaces(results.map((r) => r.allowed))
  // Guardiano anti-esposizione: la porta pubblica è davvero dietro Cloudflare Access? (null se non
  // pubblicato — locale/demo). Se ESPOSTA, l'header diventa rosso a prescindere dagli account.
  const exposure = await probeExposure(publicUrl, t)
  const health = summarizeHealth(results)
  return {
    accounts: results.map(({ allowed, ...rest }) => rest), // scarta il Set interno prima di serializzare
    surfaces,
    exposure,
    ...health,
    status: exposure?.status === 'down' ? 'down' : health.status,
  }
}
