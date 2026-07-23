import { ECSClient, DescribeTaskDefinitionCommand, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs'
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { clientOpts } from './awsClient.js'
import { imageTag } from './ecs.js'
import { principalName } from '../util/principal.js'
import { nextRun } from '../util/nextrun.js'
import { identityT } from '../i18n.js'

// #2 build/deploy per i cron su ECS RunTask: la task def schedulata non ha un "servizio" long-running,
// quindi leggiamo direttamente la sua revision → tag immagine + quando/chi l'ha registrata.
// registeredAt/registeredBy sono in DescribeTaskDefinition (nessuna chiamata extra oltre a questa).
export async function ecsScheduledBuildInfo(cfg, aws) {
  const client = new ECSClient(clientOpts(aws))
  const td = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: cfg.taskDefinition }))
  const def = td.taskDefinition
  if (!def) return null
  const containers = def.containerDefinitions ?? []
  const image = (cfg.container ? containers.find((c) => c.name === cfg.container) : containers[0])?.image
  return { tag: imageTag(image), image, deployedAt: def.registeredAt ?? null, modifiedBy: principalName(def.registeredBy) }
}

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

  const now = Date.now()
  const nextRunAt = nextRun(cfg.scheduleExpr, now)
  const nextRunLabel = nextRunAt ? t('cron.next', { in: fmtDur(Math.max(1, Math.round((nextRunAt - now) / 60000)), t) }) : null
  // Durata dell'ultima run (RunTask non ha un p95 come le Lambda): start→stop dell'ultimo task fermato.
  // Best-effort: se manca il permesso (ecs:ListTasks/DescribeTasks) o non c'è storico → niente durata.
  const durMs = outcome === 'missed' ? null : await ecsScheduledDuration(cfg, aws)
  const dur = durMs ? ` · ${t('cron.duration', { d: fmtDur(Math.max(1, Math.round(durMs / 60000)), t) })}` : ''
  const base = { schedule: cfg.schedule, scheduleExpr: cfg.scheduleExpr, nextRunAt, nextRunLabel, durationMs: durMs ?? null }
  if (outcome === 'missed') {
    return { status: 'down', summary: t('ecssched.down', { window: fmtDur(windowMin, t), sched: fmtDur(schedMin, t) }), ...base }
  }
  if (outcome === 'failed') {
    return { status: 'down', summary: t('ecssched.failed', { sched: fmtDur(schedMin, t) }) + dur, ...base }
  }
  return { status: 'up', summary: t('ecssched.ok', { sched: fmtDur(schedMin, t) }) + dur, ...base }
}

// Durata dell'ultima esecuzione: task fermato più recente della famiglia (start→stop). Best-effort.
async function ecsScheduledDuration(cfg, aws) {
  try {
    const client = new ECSClient(clientOpts(aws))
    const family = /task-definition\/([^:/]+)/.exec(cfg.taskDefinition ?? '')?.[1]
    if (!family) return null
    const list = await client.send(
      new ListTasksCommand({ cluster: cfg.cluster, family, desiredStatus: 'STOPPED', maxResults: 10 }),
    )
    if (!(list.taskArns ?? []).length) return null
    const desc = await client.send(new DescribeTasksCommand({ cluster: cfg.cluster, tasks: list.taskArns }))
    const runs = (desc.tasks ?? []).filter((t) => t.startedAt && t.stoppedAt)
    if (!runs.length) return null
    runs.sort((a, b) => new Date(b.stoppedAt) - new Date(a.stoppedAt))
    return Math.max(0, new Date(runs[0].stoppedAt) - new Date(runs[0].startedAt))
  } catch {
    return null
  }
}
