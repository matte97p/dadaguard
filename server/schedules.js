// Deduzione dello SCHEDULE di una Lambda cron, senza doverlo dichiarare (config-free): legge le
// EventBridge Rules schedulate e i loro target Lambda. Con lo schedule, il runtime riconosce la
// funzione come cron e applica il dead-man switch (0 invocazioni nella cadenza attesa = allarme),
// invece di trattarla come on-demand "a riposo". Tutto read-only e best-effort: un permesso
// mancante non rompe nulla, semplicemente non deduce lo schedule.
// Permessi: events:ListRules, events:ListTargetsByRule.
import { EventBridgeClient, ListRulesCommand, ListTargetsByRuleCommand } from '@aws-sdk/client-eventbridge'
import { clientOpts } from './runtime/awsClient.js'
import { mapLimit } from './util/pool.js'

// Espressione di schedule EventBridge → cadenza in MINUTI (null se non interpretabile). Pura/testabile.
// rate(N unit) è esatto; cron(...) è una stima best-effort che, nel dubbio, SOVRASTIMA la cadenza
// (fallback giornaliero) per non generare falsi allarmi nel dead-man switch.
export function scheduleExpressionToMinutes(expr) {
  if (!expr) return null
  const s = String(expr).trim()
  const rate = /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/i.exec(s)
  if (rate) {
    const n = Number(rate[1])
    const u = rate[2].toLowerCase()
    if (u.startsWith('minute')) return n
    if (u.startsWith('hour')) return n * 60
    return n * 1440
  }
  const cron = /^cron\((.+)\)$/i.exec(s)
  if (!cron) return null
  // EventBridge cron: "min hour day-of-month month day-of-week year"
  const [min = '*', hour = '*'] = cron[1].trim().split(/\s+/)
  const stepMin = /^(?:\*|\d+)\/(\d+)$/.exec(min)
  if (stepMin) return Number(stepMin[1]) // ogni N minuti (*/N oppure start/N)
  if (min === '*') return 1 // ogni minuto
  const stepHour = /^(?:\*|\d+)\/(\d+)$/.exec(hour)
  if (stepHour) return Number(stepHour[1]) * 60 // ogni N ore
  if (/^\d/.test(min) && hour === '*') return 60 // minuto fisso, ogni ora
  return 1440 // ora/giorno fissi o pattern complesso → conservativo (giornaliero)
}

// Minuti → stringa `schedule` compatibile con runtime/lambda.js (parseSchedule capisce 'Nm'). Pura.
export function minutesToSchedule(min) {
  return min && min > 0 ? `${min}m` : null
}

// Nome funzione (dal target ARN) → { expr, minutes, state } per le Lambda con una EventBridge Rule
// schedulata. Best-effort: su errore/permesso mancante ritorna una mappa vuota.
export async function scheduleForLambdas(aws) {
  const map = new Map()
  try {
    const eb = new EventBridgeClient(clientOpts(aws))
    const rules = []
    let token
    do {
      const out = await eb.send(new ListRulesCommand({ NextToken: token, Limit: 100 }))
      for (const r of out.Rules ?? []) if (r.ScheduleExpression) rules.push(r)
      token = out.NextToken
    } while (token)

    await mapLimit(rules, 8, async (rule) => {
      try {
        const out = await eb.send(
          new ListTargetsByRuleCommand({ Rule: rule.Name, EventBusName: rule.EventBusName }),
        )
        for (const tgt of out.Targets ?? []) {
          const m = /:function:([^:]+)/.exec(tgt.Arn ?? '') // arn:aws:lambda:…:function:NAME[:alias]
          if (!m || map.has(m[1])) continue // 1 schedule per cron: la prima rule vince
          map.set(m[1], {
            expr: rule.ScheduleExpression,
            minutes: scheduleExpressionToMinutes(rule.ScheduleExpression),
            state: rule.State === 'DISABLED' ? 'DISABLED' : 'ENABLED',
          })
        }
      } catch {
        /* target di questa rule non leggibili */
      }
    })
  } catch {
    /* events:ListRules assente o EventBridge non disponibile → nessuna cron dedotta */
  }
  return map
}
