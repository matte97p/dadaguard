import { fromIni, fromTemporaryCredentials } from '@aws-sdk/credential-providers'

// Opzioni client AWS SDK dal contesto: { region, profile, roleArn, externalId }.
//  - roleArn → AssumeRole: in cloud il task role assume un ruolo read-only cross-account
//    (pattern Datadog/Vanta; ExternalId contro il confused-deputy). Niente chiavi custodite.
//  - profile → credential file / SSO (uso locale).
//  - niente → catena di default (env / role del container).
// Provider di credenziali CONDIVISO per account (per roleArn/profile): senza cache OGNI client creato
// (uno per check × servizio) istanzia il proprio provider → una AssumeRole STS a testa → con molti
// servizi si arriva a centinaia di AssumeRole per refresh = throttling (429). Cachandolo, tutti i
// client di un account condividono UNA sola AssumeRole (che l'SDK rinnova alla scadenza).
const credCache = new Map()
function credentialsFor(aws) {
  if (aws.roleArn) {
    const k = `role:${aws.roleArn}|${aws.externalId ?? ''}`
    if (!credCache.has(k)) {
      credCache.set(
        k,
        fromTemporaryCredentials({
          params: { RoleArn: aws.roleArn, ExternalId: aws.externalId, RoleSessionName: 'dadaguard' },
        }),
      )
    }
    return credCache.get(k)
  }
  if (aws.profile) {
    const k = `profile:${aws.profile}`
    if (!credCache.has(k)) credCache.set(k, fromIni({ profile: aws.profile }))
    return credCache.get(k)
  }
  return undefined
}

export function clientOpts(aws = {}) {
  // Retry ADATTIVO: sotto throttling (429/TooManyRequests) l'SDK applica un rate-limit client-side e
  // ritenta con backoff, invece di far fallire subito. maxAttempts alzato (override: DADAGUARD_AWS_MAX_ATTEMPTS).
  const opts = {
    retryMode: 'adaptive',
    maxAttempts: Number(process.env.DADAGUARD_AWS_MAX_ATTEMPTS) || 6,
  }
  if (aws.region) opts.region = aws.region
  const creds = credentialsFor(aws)
  if (creds) opts.credentials = creds
  return opts
}
