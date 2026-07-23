import { LambdaClient, GetAliasCommand } from '@aws-sdk/client-lambda'
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail'
import { metricValues } from './cw.js'
import { clientOpts, cleanAwsReason } from './awsClient.js'
import { getLambdaConfig } from './lambdaConfig.js'
import { principalName } from '../util/principal.js'
import { nextRun } from '../util/nextrun.js'
import { fmtAgo, identityT } from '../i18n.js'
import { fmtMs, fmtCount } from '../util/format.js'

// #2 ultimo modificatore Lambda via CloudTrail. Le Lambda non espongono "chi" nella config (solo
// LastModified), quindi lo cerchiamo negli eventi CloudTrail di scrittura sulla funzione. È l'unico
// segnale con un costo extra (una LookupEvents), perciò lo CACHIAMO per `funzione@LastModified`:
// una sola query per funzione finché non viene rideployata (il timestamp cambia → cache invalidata).
// Best-effort: CloudTrail negato/throttle/vuoto → nessun modificatore, mai un errore.
const LAMBDA_WRITE_EVENTS = new Set([
  'UpdateFunctionCode20150331v2',
  'UpdateFunctionConfiguration20150331v2',
  'UpdateFunctionCode20150331',
  'UpdateFunctionConfiguration20150331',
  'CreateFunction20150331',
])
const _modifierCache = new Map() // `${fn}@${lastModified}` → who|null

function userArnFromEvent(raw) {
  try {
    return JSON.parse(raw)?.userIdentity?.arn ?? null
  } catch {
    return null
  }
}

async function lambdaLastModifier(cfg, aws, lastModified) {
  const cacheKey = `${cfg.function}@${lastModified ?? ''}`
  if (_modifierCache.has(cacheKey)) return _modifierCache.get(cacheKey)
  try {
    const ct = new CloudTrailClient(clientOpts(aws))
    const out = await ct.send(
      new LookupEventsCommand({
        LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: cfg.function }],
        MaxResults: 15, // eventi più recenti prima; cerchiamo il primo di scrittura
      }),
    )
    const ev = (out.Events ?? []).find((e) => LAMBDA_WRITE_EVENTS.has(e.EventName))
    const who = ev ? ev.Username || principalName(userArnFromEvent(ev.CloudTrailEvent)) : null
    // Cache SOLO in caso di successo (anche "nessun evento nei 90gg" è un esito valido). Un errore
    // (throttle 2 TPS / denied) NON si cacha → si riprova al refresh successivo finché non riesce,
    // altrimenti una risorsa throttlata resterebbe senza "modificato da" fino al prossimo deploy.
    _modifierCache.set(cacheKey, who)
    return who
  } catch {
    return null
  }
}

// RuntimeProvider per Lambda. Due profili di salute:
//  - on-demand (webhook/event): finestra breve; 0 invocazioni = `idle` (ok, nessuno l'ha chiamata).
//  - cron (`schedule: 24h|daily|1h|…`): dead man's switch — 0 invocazioni nella cadenza attesa
//    = `down` (la cron è saltata!). MA se lo schedule EventBridge è DISABLED (opts.scheduleState,
//    dallo state TF) → `disabled` (ferma di proposito, non un allarme).
// Permessi: cloudwatch:GetMetricData, lambda:GetFunctionConfiguration (+ lambda:GetAlias se `alias`).
const DEFAULT_WINDOW_MIN = 60 // idle on-demand: 60 min di silenzio prima di "a riposo" (era 15, troppo aggressivo)
const TIMEOUT_WARN = 0.8

// Durata compatta con unità tradotte (g/h/m IT, d/h/m EN). `t` di default = identità.
function fmtDur(min, t = identityT) {
  if (min % 1440 === 0) return `${min / 1440}${t('time.unit.d')}`
  if (min >= 60) return `${Math.round(min / 60)}${t('time.unit.h')}`
  return `${min}${t('time.unit.m')}`
}

function parseSchedule(s) {
  if (s === 'daily') return 1440
  if (s === 'hourly') return 60
  const m = /^(\d+)\s*([hm])$/.exec(String(s).trim())
  if (!m) return 1440
  return Number(m[1]) * (m[2] === 'h' ? 60 : 1)
}

export async function lambdaRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const opts3 = clientOpts(aws)
  const isCron = Boolean(cfg.schedule)
  const schedMin = isCron ? parseSchedule(cfg.schedule) : null
  // Cron: finestra = cadenza × 1.2, ma MINIMO 10 min per assorbire la latenza di pubblicazione delle
  // metriche CloudWatch (~1-3 min) → niente falsi "GIÙ" sulle cron ad alta frequenza (1m/5m).
  const windowMin = isCron ? Math.max(Math.round(schedMin * 1.2), 10) : cfg.windowMinutes ?? DEFAULT_WINDOW_MIN

  // Cron col proprio schedule EventBridge DISABLED (dallo state TF) → ferma di proposito.
  // Niente allarme, niente chiamate metriche inutili.
  if (isCron && (opts.scheduleState ?? cfg.scheduleState) === 'DISABLED') {
    return { status: 'disabled', summary: t('lambda.cron.disabled', { sched: fmtDur(schedMin, t) }), schedule: cfg.schedule, scheduleExpr: cfg.scheduleExpr }
  }

  const lambda = new LambdaClient(opts3)

  // Alias opzionale.
  let aliasInfo = ''
  if (cfg.alias) {
    try {
      const alias = await lambda.send(
        new GetAliasCommand({ FunctionName: cfg.function, Name: cfg.alias }),
      )
      aliasInfo = `${cfg.alias}→v${alias.FunctionVersion} · `
    } catch (err) {
      // Alias davvero assente vs errore AWS (throttle/denied/...): messaggi distinti, non err.name grezzo.
      const reason =
        err.name === 'ResourceNotFoundException' ? t('lambda.aliasnotfound', { alias: cfg.alias }) : cleanAwsReason(err, t)
      return { status: 'unknown', reason }
    }
  }

  // Timeout (per p95 vs timeout) — solo on-demand, opzionale.
  let timeoutSec = null
  if (!isCron) {
    try {
      const conf = await getLambdaConfig(cfg.function, aws)
      timeoutSec = conf.Timeout ?? null
    } catch {
      /* niente confronto timeout */
    }
  }

  // Metriche sulla finestra (batch CloudWatch condiviso: più servizi → poche GetMetricData).
  const dims = [{ Name: 'FunctionName', Value: cfg.function }]
  const queries = [
    ['inv', 'Invocations', 'Sum'],
    ['err', 'Errors', 'Sum'],
    ['thr', 'Throttles', 'Sum'],
  ]
  queries.push(['dur', 'Duration', 'p95']) // p95 → il batcher aggrega col max dei punti (anche per i cron: latenza)
  const m = await metricValues(aws, 'AWS/Lambda', dims, queries, windowMin)
  const invocations = m.inv
  const errors = m.err
  const throttles = m.thr

  // Prossima esecuzione (solo cron attivi): dal cron() EventBridge. rate() → null (anchor ignoto).
  const now = Date.now()
  const nextRunAt = isCron ? nextRun(cfg.scheduleExpr, now) : null
  const nextRunLabel = nextRunAt ? t('cron.next', { in: fmtDur(Math.max(1, Math.round((nextRunAt - now) / 60000)), t) }) : null

  // --- Cron: dead man's switch ---
  if (isCron) {
    if (invocations === 0) {
      return {
        status: 'down',
        summary: t('lambda.cron.down', { window: fmtDur(windowMin, t), sched: fmtDur(schedMin, t) }),
        invocations: 0,
        errors,
        throttles,
        schedule: cfg.schedule,
        scheduleExpr: cfg.scheduleExpr,
        nextRunAt,
        nextRunLabel,
      }
    }
    // Tutte le invocazioni falliscono → la cron di fatto non completa mai: GIÙ, non solo ATTENZIONE.
    const status = errors >= invocations ? 'down' : throttles > 0 || errors > 0 ? 'degraded' : 'up'
    const p95 = m.dur
    const parts = [t('lambda.runs', { n: invocations }), t('lambda.errors', { n: errors })]
    if (throttles > 0) parts.push(t('lambda.throttled', { n: throttles }))
    if (p95) parts.push(t('lambda.p95', { d: fmtMs(Math.round(p95)) })) // latenza: quanto dura la run
    return {
      status,
      summary: `${parts.join(' · ')} (${fmtDur(windowMin, t)})`,
      invocations,
      errors,
      throttles,
      p95Ms: p95 ? Math.round(p95) : null,
      schedule: cfg.schedule,
      scheduleExpr: cfg.scheduleExpr,
      nextRunAt,
      nextRunLabel,
    }
  }

  // --- On-demand ---
  if (invocations === 0) {
    return {
      status: 'idle',
      summary: `${aliasInfo}${t('lambda.idle', { window: fmtDur(windowMin, t) })}`,
      invocations: 0,
      errors,
      throttles,
    }
  }

  const p95 = m.dur
  const errRate = (errors / invocations) * 100
  const nearTimeout = timeoutSec && p95 >= timeoutSec * 1000 * TIMEOUT_WARN
  // 100% di errori = il servizio non funziona mai → GIÙ; errori parziali → ATTENZIONE.
  const status = errors >= invocations ? 'down' : throttles > 0 || errors > 0 || nearTimeout ? 'degraded' : 'up'

  const parts = [
    t('lambda.calls', { n: fmtCount(invocations) }),
    t('lambda.errpct', { p: errRate < 0.05 ? '0' : errRate.toFixed(1) }),
    p95 ? t('lambda.p95', { d: fmtMs(Math.round(p95)) }) : null,
    nearTimeout ? t('lambda.neartimeout', { d: fmtMs(timeoutSec * 1000) }) : null,
    throttles > 0 ? t('lambda.throttled', { n: throttles }) : null,
  ].filter(Boolean)

  return {
    status,
    summary: aliasInfo + parts.join(' · '),
    invocations,
    errors,
    throttles,
    p95Ms: Math.round(p95),
    timeoutSec,
  }
}

// #2 build/deploy zero-config per Lambda: versione pubblicata + ultima modifica.
// Se c'è un alias, riporta la versione a cui punta. Permessi: lambda:GetFunctionConfiguration
// (+ lambda:GetAlias se `alias`). Ritorna { version, lastModified } o null.
export async function lambdaBuildInfo(cfg, aws) {
  const lambda = new LambdaClient(clientOpts(aws))
  const conf = await getLambdaConfig(cfg.function, aws)
  let version = conf.Version // di norma "$LATEST"
  if (cfg.alias) {
    try {
      const alias = await lambda.send(
        new GetAliasCommand({ FunctionName: cfg.function, Name: cfg.alias }),
      )
      if (alias.FunctionVersion) version = alias.FunctionVersion
    } catch {
      /* alias assente: tieni la versione della config */
    }
  }
  // CodeSha256 = identità del build (cambia a ogni deploy): per le funzioni non versionate
  // ($LATEST) è l'unico modo per dire "quale build è viva".
  const modifiedBy = await lambdaLastModifier(cfg, aws, conf.LastModified)
  return { version, lastModified: conf.LastModified ?? null, codeSha: conf.CodeSha256 ?? null, modifiedBy }
}
