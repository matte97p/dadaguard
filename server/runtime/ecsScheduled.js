import { ECSClient, DescribeTaskDefinitionCommand, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs'
import { CloudWatchLogsClient, FilterLogEventsCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { clientOpts, isDenied } from './awsClient.js'
import { imageTag } from './ecs.js'
import { principalName } from '../util/principal.js'
import { nextRun, missedWindow } from '../util/nextrun.js'
import { fmtAgo, identityT } from '../i18n.js'

// #2 build/deploy per i cron su ECS RunTask: la task def schedulata non ha un "servizio" long-running,
// quindi leggiamo direttamente la sua revision → tag immagine + quando/chi l'ha registrata.
// registeredAt/registeredBy sono in DescribeTaskDefinition (nessuna chiamata extra oltre a questa).
export async function ecsScheduledBuildInfo(cfg, aws) {
  const client = new ECSClient(clientOpts(aws))
  const td = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: cfg.taskDefinition, include: ['TAGS'] }))
  const def = td.taskDefinition
  if (!def) return null
  const containers = def.containerDefinitions ?? []
  const image = (cfg.container ? containers.find((c) => c.name === cfg.container) : containers[0])?.image
  // Tag `deployedBy` (persona) prima, poi `registeredBy` (chi ha registrato la revision).
  const deployedBy = (td.tags ?? []).find((t) => t.key === 'deployedBy')?.value
  return { tag: imageTag(image), image, deployedAt: def.registeredAt ?? null, modifiedBy: deployedBy || principalName(def.registeredBy) }
}

// Durata compatta con unità tradotte (g/h/m) — allineata a runtime/lambda.js.
function fmtDur(min, t = identityT) {
  if (min % 1440 === 0) return `${min / 1440}${t('time.unit.d')}`
  if (min >= 60) return `${Math.round(min / 60)}${t('time.unit.h')}`
  return `${min}${t('time.unit.m')}`
}

// Marcatori di FALLIMENTO nei log (filter pattern CloudWatch, case-sensitive, OR di termini). I cron
// usiamo il pacchetto cron condiviso: su eccezione fa crash-alert e RILANCIA → l'eccezione non catturata stampa
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

// Su ECS RunTask ogni esecuzione ha il SUO log stream (`<fam>/<container>/<taskId>`): lo stream più
// recente È l'ultima esecuzione. Sceglie quello e dice se è caduto dentro la finestra attesa. Pura.
//
// Perché non basta cercare l'errore "in tutto il gruppo nella finestra": `FilterLogEvents` distribuisce
// uno scan budget tra gli stream e può restituire una pagina VUOTA con un `nextToken` anche quando i
// match esistono — con `limit: 1` succede sistematicamente. Il check leggeva quella pagina vuota come
// "nessun errore" e dava VERDE un cron con tre traceback nell'ultima run (visto in produzione su
// refresh-bi-mvs). Restringere all'ultimo stream rende la risposta deterministica, più economica
// (nessuna paginazione da inseguire) e più aderente a ciò che la card dichiara: «ultima esecuzione».
export function pickLastRun(streams = [], startTimeMs) {
  const withEvents = (streams ?? []).filter((s) => Number.isFinite(s?.lastEventTimestamp))
  if (!withEvents.length) return { stream: null, ran: false }
  const last = withEvents.reduce((a, b) => (b.lastEventTimestamp > a.lastEventTimestamp ? b : a))
  return { stream: last.logStreamName ?? null, ran: last.lastEventTimestamp >= startTimeMs }
}

// "C'è almeno un evento?" SEGUENDO le pagine: con `FilterLogEvents` una pagina vuota NON è una
// risposta — finché torna un `nextToken` lo scan non è finito. È questo il passo che mancava e che
// faceva leggere "nessun errore" dove gli errori c'erano. Tetto di pagine per non trasformare un
// check in una scansione infinita: esaurito il budget diciamo "non trovato", mai "fallito".
const MAX_PAGES = 15
async function anyEvent(logs, params) {
  let token
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await logs.send(new FilterLogEventsCommand({ ...params, nextToken: token, limit: 1 }))
    if ((r.events ?? []).length) return true
    token = r.nextToken
    if (!token) return false
  }
  return false
}

// È partito? è fallito? Due strade, per non dipendere da un permesso in più:
//  A) `DescribeLogStreams` → l'ultima esecuzione è lo stream più recente (su RunTask uno stream per
//     run): due chiamate, deterministico, ed è la domanda che la card dichiara.
//  B) permesso assente (ruolo read-only senza `logs:DescribeLogStreams`) → si torna sul log group
//     intero, ma inseguendo le pagine invece di fidarsi della prima.
export async function runOutcome(logs, logGroup, startTime) {
  try {
    const streams = await logs.send(
      new DescribeLogStreamsCommand({ logGroupName: logGroup, orderBy: 'LastEventTime', descending: true, limit: 5 }),
    )
    const { stream, ran } = pickLastRun(streams.logStreams ?? [], startTime)
    if (!ran || !stream) return { ran: false, failed: false }
    const failed = await anyEvent(logs, { logGroupName: logGroup, logStreamNames: [stream], startTime, filterPattern: FAILURE_PATTERN })
    return { ran: true, failed }
  } catch (err) {
    if (!isDenied(err)) throw err
    const [ran, failed] = await Promise.all([
      anyEvent(logs, { logGroupName: logGroup, startTime }),
      anyEvent(logs, { logGroupName: logGroup, startTime, filterPattern: FAILURE_PATTERN }),
    ])
    return { ran, failed }
  }
}

// RuntimeProvider per i cron su ECS RunTask (EventBridge Scheduler → RunTask, one-shot su Fargate).
// A differenza della Lambda NON c'è una metrica "Invocations", E i task fermati spariscono dalle API
// ECS dopo ~1h → per un cron giornaliero l'exit code non è più leggibile la mattina dopo. Il segnale
// DUREVOLE è il LOG (retention di giorni): controlliamo che il task sia PARTITO (evento nella cadenza
// attesa) e che l'ultimo run NON sia FALLITO (nessun traceback/errore). Schedule DISABLED → 'disabled'.
// Permessi: ecs:DescribeTaskDefinition, logs:FilterLogEvents; logs:DescribeLogStreams OPZIONALE
// (con quello il check è più preciso ed economico, senza si usa la strada B — vedi runOutcome).
export async function ecsScheduledRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const schedMin = cfg.scheduleMinutes ?? 1440
  // Finestra dall'ESPRESSIONE vera (fino all'ultimo fire atteso + grazia), come per le Lambda cron:
  // una cadenza dedotta grida al guasto ogni volta che il cron NON gira ogni giorno (es. lun-ven).
  // Espressione non calcolabile (`rate(...)`) → euristica: cadenza × 1.2, minimo 10 min.
  const missed = missedWindow(cfg.scheduleExpr, Date.now(), cfg.scheduleTz)
  const windowMin = missed?.windowMin ?? Math.max(Math.round(schedMin * 1.2), 10)

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
  const { ran, failed } = await runOutcome(logs, logGroup, startTime)
  const outcome = classifyEcsRun({ ran, failed })

  const now = Date.now()
  const nextRunAt = nextRun(cfg.scheduleExpr, now, cfg.scheduleTz)
  const nextRunLabel = nextRunAt ? t('cron.next', { in: fmtDur(Math.max(1, Math.round((nextRunAt - now) / 60000)), t) }) : null
  // Durata dell'ultima run (RunTask non ha un p95 come le Lambda): start→stop dell'ultimo task fermato.
  // Best-effort: se manca il permesso (ecs:ListTasks/DescribeTasks) o non c'è storico → niente durata.
  const durMs = outcome === 'missed' ? null : await ecsScheduledDuration(cfg, aws)
  const dur = durMs ? ` · ${t('cron.duration', { d: fmtDur(Math.max(1, Math.round(durMs / 60000)), t) })}` : ''
  // `outcome` esce dal check: distingue "mai partita" da "partita e fallita", che hanno due
  // destinatari diversi (vedi server/notify/watch.js).
  const base = { outcome, schedule: cfg.schedule, scheduleExpr: cfg.scheduleExpr, nextRunAt, nextRunLabel, durationMs: durMs ?? null }
  if (outcome === 'missed') {
    const summary = missed
      ? t('cron.missed', { ago: fmtAgo(new Date(missed.expectedAt), t) })
      : t('ecssched.down', { window: fmtDur(windowMin, t), sched: fmtDur(schedMin, t) })
    return { status: 'down', summary, ...base }
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
