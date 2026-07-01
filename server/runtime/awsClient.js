import { fromIni, fromTemporaryCredentials } from '@aws-sdk/credential-providers'

// Opzioni client AWS SDK dal contesto: { region, profile, roleArn, externalId }.
//  - roleArn → AssumeRole: in cloud il task role assume un ruolo read-only cross-account
//    (pattern Datadog/Vanta; ExternalId contro il confused-deputy). Niente chiavi custodite.
//  - profile → credential file / SSO (uso locale).
//  - niente → catena di default (env / role del container).
export function clientOpts(aws = {}) {
  // Retry ADATTIVO: sotto throttling (429/TooManyRequests) l'SDK applica un rate-limit client-side e
  // ritenta con backoff, invece di far fallire subito. Con molti servizi/account assorbe i picchi
  // verso CloudWatch/STS. maxAttempts alzato per dare margine (override: DADAGUARD_AWS_MAX_ATTEMPTS).
  const opts = {
    retryMode: 'adaptive',
    maxAttempts: Number(process.env.DADAGUARD_AWS_MAX_ATTEMPTS) || 6,
  }
  if (aws.region) opts.region = aws.region
  if (aws.roleArn) {
    opts.credentials = fromTemporaryCredentials({
      params: {
        RoleArn: aws.roleArn,
        ExternalId: aws.externalId,
        RoleSessionName: 'dadaguard',
      },
    })
  } else if (aws.profile) {
    opts.credentials = fromIni({ profile: aws.profile })
  }
  return opts
}
