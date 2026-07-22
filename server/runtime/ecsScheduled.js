import { ECSClient, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs'
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { clientOpts } from './awsClient.js'
import { identityT } from '../i18n.js'

// Durata compatta con unità tradotte (g/h/m) — allineata a runtime/lambda.js.
function fmtDur(min, t = identityT) {
  if (min % 1440 === 0) return `${min / 1440}${t('time.unit.d')}`
  if (min >= 60) return `${Math.round(min / 60)}${t('time.unit.h')}`
  return `${min}${t('time.unit.m')}`
}

// Marcatori di FALLIMENTO nei log (filter pattern CloudWatch, case-sensitive, OR di termini). I cron
// Cato usano catocron: su eccezione fa crash-alert e RILANCIA → l'eccezione non catturata stampa
// `Traceback (most recent call last):` su stderr → CloudWatch. `ERROR:`/`CRITICAL:` coprono i log di
// livello error (formato logging `LEVEL:logger:msg`). Il successo logga `Done: ...`, nessuno di questi.
const FAILURE_PATTERN = '?Traceback ?"ERROR:" ?"CRITICAL:"'

// Classifica l'esito di un cron ECS dai due segnali di log. Pura/testabile.
//   ran=false           → 'missed'  (dead-man: nessun log nella finestra = non è partito)
//   ran=true, failed    → 'failed'  (è partito ma i log contengono un errore/traceback)
//   ran=true, ok        → 'ok'
export function classifyEcsRun({ ran, failed }) {
  if (!ran) return 'missed'
  return failed ? 'failed' : 'ok'
}

// RuntimeProvider per i cron su ECS RunTask (EventBridge Scheduler → RunTask, one-shot su Fargate).
// A differenza della Lambda NON c'è una metrica "Invocations", E i task fermati spariscono dalle API
// ECS dopo ~1h → per un cron giornaliero l'exit code non è più leggibile la mattina dopo. Il segnale
// DUREVOLE è il LOG (retention di giorni): controlliamo che il task sia PARTITO (evento nella cadenza
// attesa) e che l'ultimo run NON sia FALLITO (nessun traceback/errore). Schedule DISABLED → 'disabled'.
// Permessi: ecs:DescribeTaskDefinition, logs:FilterLogEvents (già nel ruolo read-only).
export async function ecsScheduledRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const schedMin = cfg.scheduleMinutes ?? 1440
  // Finestra = cadenza × 1.2 (minimo 10 min), come il dead-man switch delle Lambda cron.
  const windowMin = Math.max(Math.round(schedMin * 1.2), 10)

  // Schedule spento di proposito → niente allarme, niente chiamate inutili.
  if ((opts.scheduleState ?? cfg.scheduleState) === 'DISABLED') {
    return {
      status: 'disabled',
      summary: t('ecssched.disabled', { sched: fmtDur(schedMin, t) }),
      schedule: cfg.schedule,
      scheduleExpr: cfg.scheduleExpr,
    }
  }

  // Log group reale dalla task-def (primo container) — non lo deduco dal nome per non sbagliare.
  const ecs = new ECSClient(clientOpts(aws))
  const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: cfg.taskDefinition }))
  const logGroup =
    td.taskDefinition?.containerDefinitions?.[0]?.logConfiguration?.options?.['awslogs-group']
  if (!logGroup) {
    return { status: 'unknown', reason: t('ecssched.nolog'), schedule: cfg.schedule, scheduleExpr: cfg.scheduleExpr }
  }

  const logs = new CloudWatchLogsClient(clientOpts(aws))
  const startTime = Date.now() - windowMin * 60 * 1000
  // 1) È partito? (almeno un evento nella finestra)  2) È fallito? (marcatore d'errore nella finestra)
  const [any, errs] = await Promise.all([
    logs.send(new FilterLogEventsCommand({ logGroupName: logGroup, startTime, limit: 1 })),
    logs.send(new FilterLogEventsCommand({ logGroupName: logGroup, startTime, filterPattern: FAILURE_PATTERN, limit: 1 })),
  ])
  const outcome = classifyEcsRun({ ran: (any.events ?? []).length > 0, failed: (errs.events ?? []).length > 0 })

  const base = { schedule: cfg.schedule, scheduleExpr: cfg.scheduleExpr }
  if (outcome === 'missed') {
    return { status: 'down', summary: t('ecssched.down', { window: fmtDur(windowMin, t), sched: fmtDur(schedMin, t) }), ...base }
  }
  if (outcome === 'failed') {
    return { status: 'down', summary: t('ecssched.failed', { sched: fmtDur(schedMin, t) }), ...base }
  }
  return { status: 'up', summary: t('ecssched.ok', { sched: fmtDur(schedMin, t) }), ...base }
}
