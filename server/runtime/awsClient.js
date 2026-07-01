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

// Riconosce gli errori di throttling AWS (429 / TooManyRequests / Throttling / "Rate exceeded"):
// quando i retry adattivi non bastano (es. burst di discovery su molti servizi), permette di mostrare
// un messaggio pulito invece dell'eccezione grezza dell'SDK.
export function isThrottle(err) {
  if (!err) return false
  const name = err.name || ''
  return (
    err.$metadata?.httpStatusCode === 429 ||
    name === 'TooManyRequestsException' ||
    name === 'ThrottlingException' ||
    name === 'Throttling' ||
    /throttl|too\s*many\s*requests|rate exceeded/i.test(err.message || '')
  )
}

// Fallback EN leggibili: usati quando cleanAwsReason è chiamata senza `t` (endpoint che non propagano
// la lingua) — così l'utente vede comunque un messaggio pulito, mai la chiave i18n grezza.
const AWS_REASON_EN = {
  throttled: 'AWS rate limit — retry on refresh',
  denied: 'access denied (insufficient permissions)',
  notfound: 'resource not found',
  expired: 'credentials expired — log in again',
  timeout: 'timeout',
  error: 'AWS error',
}

function awsReasonKey(err) {
  if (isThrottle(err)) return 'throttled'
  const name = err?.name || ''
  if (/AccessDenied|Unauthorized|Forbidden/i.test(name)) return 'denied'
  if (/NotFound|NoSuchEntity|NoSuchKey|NoSuchBucket/i.test(name)) return 'notfound'
  if (/Expired(Token|Credentials)|CredentialsError|InvalidClientTokenId/i.test(name)) return 'expired'
  if (name === 'AbortError' || /Timeout/i.test(name)) return 'timeout'
  return null
}

// Traduce un errore AWS in un messaggio pulito e azionabile per l'utente, invece dell'eccezione SDK
// grezza (es. "AccessDenied: User ... is not authorized to perform ..."). Con `t` localizza (it/en);
// senza `t` ripiega sui testi EN. `err.message` resta il fallback per gli errori non riconosciuti.
export function cleanAwsReason(err, t = (k) => k) {
  const k = awsReasonKey(err)
  if (!k) return err?.message || AWS_REASON_EN.error
  const tr = t('aws.' + k)
  return tr === 'aws.' + k ? AWS_REASON_EN[k] : tr // t identità/assente → EN leggibile, non la chiave
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
