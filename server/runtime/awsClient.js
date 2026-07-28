import { fromIni, fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import { NodeHttpHandler } from '@smithy/node-http-handler'

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

// "Non ti è permesso" (per scegliere una strada alternativa invece di arrendersi al check).
export function isDenied(err) {
  return awsReasonKey(err) === 'denied'
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

// ─── Traccia delle chiamate AWS (DADAGUARD_TRACE=1) ─────────────────────────────────────────────
// Contare quante chiamate partono e verso QUALE servizio AWS è l'unico modo di sapere dove va il
// tempo: due volte oggi ho stimato a occhio e mi sono sbagliato (le metriche CloudWatch sono già
// unite in batch da cw.js, il collo era altrove). Il conteggio si aggancia al livello più basso — il
// gestore HTTP — così vede TUTTE le chiamate, comprese le AssumeRole e i retry, senza dover
// strumentare un modulo alla volta.
// Spenta per default: costa un wrapper per richiesta e in produzione non serve.
const TRACE = process.env.DADAGUARD_TRACE === '1'
const traced = new Map() // host → { n, ms }

class TracingHandler extends NodeHttpHandler {
  async handle(request, options) {
    const host = String(request?.hostname ?? '?').split('.')[0] // "monitoring", "ecs", "cloudtrail"…
    const t0 = performance.now()
    try {
      return await super.handle(request, options)
    } finally {
      const cur = traced.get(host) ?? { n: 0, ms: 0 }
      cur.n += 1
      cur.ms += performance.now() - t0
      traced.set(host, cur)
    }
  }
}

export function traceReset() {
  traced.clear()
}

// Riepilogo ordinato dal servizio che costa più tempo. `null` se la traccia è spenta.
export function traceReport() {
  if (!TRACE) return null
  return Object.fromEntries(
    [...traced.entries()]
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([host, v]) => [host, { chiamate: v.n, ms: Math.round(v.ms) }]),
  )
}

export function clientOpts(aws = {}) {
  // Retry ADATTIVO: sotto throttling (429/TooManyRequests) l'SDK applica un rate-limit client-side e
  // ritenta con backoff, invece di far fallire subito. maxAttempts alzato (override: DADAGUARD_AWS_MAX_ATTEMPTS).
  const opts = {
    retryMode: 'adaptive',
    maxAttempts: Number(process.env.DADAGUARD_AWS_MAX_ATTEMPTS) || 6,
  }
  if (aws.region) opts.region = aws.region
  if (TRACE) opts.requestHandler = new TracingHandler()
  const creds = credentialsFor(aws)
  if (creds) opts.credentials = creds
  return opts
}
