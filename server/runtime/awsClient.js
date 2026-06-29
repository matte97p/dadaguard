import { fromIni, fromTemporaryCredentials } from '@aws-sdk/credential-providers'

// Opzioni client AWS SDK dal contesto: { region, profile, roleArn, externalId }.
//  - roleArn → AssumeRole: in cloud il task role assume un ruolo read-only cross-account
//    (pattern Datadog/Vanta; ExternalId contro il confused-deputy). Niente chiavi custodite.
//  - profile → credential file / SSO (uso locale).
//  - niente → catena di default (env / role del container).
export function clientOpts(aws = {}) {
  const opts = {}
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
