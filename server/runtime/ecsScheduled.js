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

// RuntimeProvider per i cron su ECS RunTask (EventBridge Scheduler → RunTask, one-shot su Fargate).
// A differenza della Lambda NON c'è una metrica "Invocations": il dead-man switch guarda se il LOG
// GROUP del task ha avuto almeno un evento nella cadenza attesa (× 1.2). Se lo schedule è DISABLED →
// 'disabled' (fermo di proposito, non un allarme). Permessi: ecs:DescribeTaskDefinition,
// logs:FilterLogEvents.
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

  // Dead-man switch: c'è stato ALMENO un evento di log nella finestra? (limit 1 = check economico)
  const logs = new CloudWatchLogsClient(clientOpts(aws))
  const r = await logs.send(
    new FilterLogEventsCommand({
      logGroupName: logGroup,
      startTime: Date.now() - windowMin * 60 * 1000,
      limit: 1,
    }),
  )
  const ran = (r.events ?? []).length > 0
  if (!ran) {
    return {
      status: 'down',
      summary: t('ecssched.down', { window: fmtDur(windowMin, t), sched: fmtDur(schedMin, t) }),
      schedule: cfg.schedule,
      scheduleExpr: cfg.scheduleExpr,
    }
  }
  return {
    status: 'up',
    summary: t('ecssched.ok', { sched: fmtDur(schedMin, t) }),
    schedule: cfg.schedule,
    scheduleExpr: cfg.scheduleExpr,
  }
}
