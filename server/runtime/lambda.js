import {
  LambdaClient,
  GetAliasCommand,
  GetFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda'
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per Lambda. Due profili di salute:
//  - on-demand (webhook/event): finestra breve; 0 invocazioni = `idle` (ok, nessuno l'ha chiamata).
//  - cron (`schedule: 24h|daily|1h|…`): dead man's switch — 0 invocazioni nella cadenza attesa
//    = `down` (la cron è saltata!). MA se lo schedule EventBridge è DISABLED (opts.scheduleState,
//    dallo state TF) → `disabled` (ferma di proposito, non un allarme).
// Permessi: cloudwatch:GetMetricData, lambda:GetFunctionConfiguration (+ lambda:GetAlias se `alias`).
const DEFAULT_WINDOW_MIN = 15
const TIMEOUT_WARN = 0.8

function fmtCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'
  return String(n)
}

function fmtDur(min) {
  if (min % 1440 === 0) return `${min / 1440}g`
  if (min >= 60) return `${Math.round(min / 60)}h`
  return `${min}m`
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
  const windowMin = isCron ? Math.round(schedMin * 1.2) : cfg.windowMinutes ?? DEFAULT_WINDOW_MIN

  // Cron col proprio schedule EventBridge DISABLED (dallo state TF) → ferma di proposito.
  // Niente allarme, niente chiamate metriche inutili.
  if (isCron && opts.scheduleState === 'DISABLED') {
    return { status: 'disabled', summary: t('lambda.cron.disabled', { sched: fmtDur(schedMin) }), schedule: cfg.schedule }
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
      return { status: 'unknown', reason: t('lambda.aliasnotfound', { alias: cfg.alias, name: err.name }) }
    }
  }

  // Timeout (per p95 vs timeout) — solo on-demand, opzionale.
  let timeoutSec = null
  if (!isCron) {
    try {
      const conf = await lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: cfg.function }),
      )
      timeoutSec = conf.Timeout ?? null
    } catch {
      /* niente confronto timeout */
    }
  }

  // Metriche sulla finestra.
  const cw = new CloudWatchClient(opts3)
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - windowMin * 60 * 1000)
  const period = Math.min(windowMin * 60, 86400)
  const dims = [{ Name: 'FunctionName', Value: cfg.function }]
  const q = (id, name, stat) => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: 'AWS/Lambda', MetricName: name, Dimensions: dims },
      Period: period,
      Stat: stat,
    },
    ReturnData: true,
  })

  const queries = [q('inv', 'Invocations', 'Sum'), q('err', 'Errors', 'Sum'), q('thr', 'Throttles', 'Sum')]
  if (!isCron) queries.push(q('dur', 'Duration', 'p95'))

  const res = await cw.send(
    new GetMetricDataCommand({ StartTime: startTime, EndTime: endTime, MetricDataQueries: queries }),
  )
  const agg = (id, how = 'sum') => {
    const vals = res.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []
    if (!vals.length) return 0
    return how === 'max' ? Math.max(...vals) : vals.reduce((a, b) => a + b, 0)
  }
  const invocations = agg('inv')
  const errors = agg('err')
  const throttles = agg('thr')

  // --- Cron: dead man's switch ---
  if (isCron) {
    if (invocations === 0) {
      return {
        status: 'down',
        summary: t('lambda.cron.down', { window: fmtDur(windowMin), sched: fmtDur(schedMin) }),
        invocations: 0,
        errors,
        throttles,
        schedule: cfg.schedule,
      }
    }
    const status = errors > 0 || throttles > 0 ? 'degraded' : 'up'
    const parts = [t('lambda.runs', { n: invocations }), t('lambda.errors', { n: errors })]
    if (throttles > 0) parts.push(t('lambda.throttled', { n: throttles }))
    return {
      status,
      summary: `${parts.join(' · ')} (${fmtDur(windowMin)})`,
      invocations,
      errors,
      throttles,
      schedule: cfg.schedule,
    }
  }

  // --- On-demand ---
  if (invocations === 0) {
    return {
      status: 'idle',
      summary: `${aliasInfo}${t('lambda.idle', { window: fmtDur(windowMin) })}`,
      invocations: 0,
      errors,
      throttles,
    }
  }

  const p95 = agg('dur', 'max')
  const errRate = (errors / invocations) * 100
  const nearTimeout = timeoutSec && p95 >= timeoutSec * 1000 * TIMEOUT_WARN
  const status = throttles > 0 || errors > 0 || nearTimeout ? 'degraded' : 'up'

  const parts = [
    t('lambda.calls', { n: fmtCount(invocations) }),
    t('lambda.errpct', { p: errRate < 0.05 ? '0' : errRate.toFixed(1) }),
    p95 ? t('lambda.p95', { ms: Math.round(p95) }) : null,
    nearTimeout ? t('lambda.neartimeout', { s: timeoutSec }) : null,
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
