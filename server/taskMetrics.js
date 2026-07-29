// Metriche PER SINGOLA ISTANZA di un servizio ECS (un task = una replica), on-demand e read-only.
//
// Perché servono: le metriche di servizio sono medie sulla flotta, e una media nasconde esattamente il
// caso che si va a cercare — un task che macina CPU o perde memoria mentre gli altri due stanno bene.
// Con 2-3 replica la media sposta il numero di un terzo e il colpevole non si vede.
//
// Da dove arrivano: Container Insights pubblica un record per task al minuto sul log group
// `/aws/ecs/containerinsights/<cluster>/performance` in formato EMF (una riga JSON per record). Si
// leggono con `logs:FilterLogEvents`, permesso che il ruolo read-only ha già: NIENTE nuovo grant IAM,
// nessun apply da aspettare. Il namespace metrico `ECS/ContainerInsights` NON ha una dimension TaskId
// (solo ClusterName/ServiceName/TaskDefinitionFamily), quindi GetMetricData non può dare il per-task:
// i log di performance sono l'unica strada.
//
// La LATENZA non è qui: questi record non la contengono, e `TargetResponseTime` di CloudWatch esiste per
// target group e per zona, mai per singolo target. Arriva dagli access log dell'ALB — altra sorgente,
// altro permesso — e la compone `albLatency.js`, che si aggancia qui sotto sullo stesso join per
// indirizzo dello stato nel target group. Dove gli access log sono spenti la colonna resta vuota e il
// pannello dice perché, invece di spacciare la media di servizio per un numero per-task.
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs'
import { ElasticLoadBalancingV2Client, DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'
import { albLatencyByTarget } from './albLatency.js'

const MAX_PAGES = 5
const STOPPED_LIMIT = 10 // gli ultimi task fermati: oltre, è archeologia

// Task id dall'ARN: `arn:aws:ecs:<region>:<account>:task/<cluster>/<taskId>`.
export function taskIdOfArn(arn) {
  return String(arn ?? '').split('/').pop() || null
}

// Durata del pull dell'immagine. Un pull lento è una causa vera di avvii lenti, e si legge da due
// timestamp che stiamo già scaricando. Mancante o incoerente → null: non si inventa uno zero.
export function pullMs(record) {
  const a = Number(record?.PullStartedAt)
  const b = Number(record?.PullStoppedAt)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return b - a
}

// Un task ucciso per memoria lo dice in chiaro, ma il messaggio sta a volte sul task e a volte sul
// container. Riconoscerlo esplicitamente cambia la diagnosi: "OOM" indica il sizing, un kill da
// health-check indica l'applicazione, e le due portano a interventi opposti.
const OOM_RE = /out\s*of\s*memory|memory\s*usage|OutOfMemoryError/i
export function stopKind(task) {
  const texts = [task?.stoppedReason, ...(task?.containerReasons ?? [])].filter(Boolean).join(' · ')
  if (OOM_RE.test(texts)) return 'oom'
  if (/health\s*check/i.test(texts)) return 'health'
  // `stopCode` di ECS: una sostituzione da deploy o uno scale-in non sono guasti.
  if (task?.stopCode === 'ServiceSchedulerInitiated') return 'scheduler'
  if (task?.stopCode === 'UserInitiated') return 'user'
  return texts ? 'other' : null
}

// Attacca a ogni task il suo stato NEL TARGET GROUP. Il join è sull'IP privato dell'ENI, perché con
// target type `ip` (Fargate) il load balancer conosce i task per indirizzo, non per id.
//
// È il pezzo che mancava: il pannello sapeva dire "0/2 target sani" ma non QUALE task fosse fuori, e
// senza quello l'informazione non è azionabile.
export function mergeTargetHealth(tasks, targetsByIp) {
  if (!targetsByIp) return tasks // nessun load balancer, o permesso assente: non si inventa uno stato
  return tasks.map((task) => {
    const target = task.privateIp ? targetsByIp[task.privateIp] : null
    return target ? { ...task, target } : task
  })
}

// Task id → 8 caratteri: quanto basta a distinguere le replica di un servizio senza occupare la riga
// con 32 caratteri esadecimali che nessuno legge per intero.
export function shortTaskId(taskId) {
  return String(taskId ?? '').slice(0, 8)
}

// Percentuale di quanto è usato del riservato. `reserved` a 0 o assente → null, non 0: "non lo so" e
// "sta a zero" sono cose diverse, e mostrare 0% su un dato mancante è affermare il falso.
export function pctOf(used, reserved) {
  const u = Number(used)
  const r = Number(reserved)
  if (!Number.isFinite(u) || !Number.isFinite(r) || r <= 0) return null
  return Math.round((u / r) * 1000) / 10
}

// L'ULTIMO record di ogni task nella finestra. Container Insights ne emette uno al minuto per task:
// interessa la foto più recente, non la serie storica (quella la dà già la sparkline di servizio).
export function latestByTask(records) {
  const byTask = new Map()
  for (const r of records) {
    if (!r?.TaskId) continue
    const prev = byTask.get(r.TaskId)
    if (!prev || (r.Timestamp ?? 0) > (prev.Timestamp ?? 0)) byTask.set(r.TaskId, r)
  }
  return [...byTask.values()]
    .map((r) => ({
      taskId: r.TaskId,
      shortId: shortTaskId(r.TaskId),
      az: r.AvailabilityZone ?? null,
      revision: r.TaskDefinitionRevision != null ? String(r.TaskDefinitionRevision) : null,
      status: r.KnownStatus ?? null,
      cpuPct: pctOf(r.CpuUtilized, r.CpuReserved),
      memPct: pctOf(r.MemoryUtilized, r.MemoryReserved),
      cpuReserved: Number(r.CpuReserved) || null,
      memReserved: Number(r.MemoryReserved) || null,
      netRxBytes: Number(r.NetworkRxBytes) || 0,
      netTxBytes: Number(r.NetworkTxBytes) || 0,
      // Storage effimero: su Fargate è il disco che si riempie senza che nessuno lo guardi, e un
      // servizio che scrive file (upload, conversioni, sandbox) muore lì prima che in memoria.
      diskPct: pctOf(r.EphemeralStorageUtilized, r.EphemeralStorageReserved),
      // Pacchetti scartati o in errore: non sono zero per definizione, e quando non lo sono spiegano
      // timeout che dall'applicazione sembrano inspiegabili.
      netDropped: (Number(r.NetworkRxDropped) || 0) + (Number(r.NetworkTxDropped) || 0),
      netErrors: (Number(r.NetworkRxErrors) || 0) + (Number(r.NetworkTxErrors) || 0),
      pullMs: pullMs(r),
      ts: r.Timestamp ?? null,
      startedAt: r.CreatedAt ?? null,
    }))
    // Il task che consuma più CPU in cima: se una replica è in difficoltà, è la riga che si cerca.
    .sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || String(a.shortId).localeCompare(String(b.shortId)))
}

// Dettaglio ECS dei task ATTIVI: salute del container, quando è partito, e l'IP privato che serve al
// join col target group. Best-effort: un permesso mancante non deve far sparire le metriche.
async function runningTaskDetail(ecs, cfg) {
  const list = await ecs.send(
    new ListTasksCommand({ cluster: cfg.cluster, serviceName: cfg.service, desiredStatus: 'RUNNING' }),
  )
  if (!list.taskArns?.length) return {}
  const desc = await ecs.send(new DescribeTasksCommand({ cluster: cfg.cluster, tasks: list.taskArns }))
  const byId = {}
  for (const task of desc.tasks ?? []) {
    const id = taskIdOfArn(task.taskArn)
    if (!id) continue
    const eni = (task.attachments ?? []).find((a) => a.type === 'ElasticNetworkInterface')
    byId[id] = {
      health: task.healthStatus && task.healthStatus !== 'UNKNOWN' ? task.healthStatus : null,
      lastStatus: task.lastStatus ?? null,
      startedAt: task.startedAt ? new Date(task.startedAt).getTime() : null,
      privateIp: (eni?.details ?? []).find((d) => d.name === 'privateIPv4Address')?.value ?? null,
    }
  }
  return byId
}

// Gli ultimi task FERMATI, col motivo. È il segnale più diagnostico dell'insieme: un OOM kill, un kill
// da health-check e una sostituzione da deploy sono tre storie diverse, e senza il motivo restano tutte
// "il task è ripartito". Il motivo del container è più specifico di quello del task, quindi si tengono
// entrambi.
// GOTCHA verificato su staging: `ListTasks` col filtro `serviceName` NON restituisce i task fermati —
// torna una lista vuota mentre i task ci sono, e la sezione sarebbe rimasta perennemente vuota senza
// alcun errore. Si filtra per FAMIGLIA della task-def, che per gli STOPPED ECS onora.
async function stoppedTaskDetail(ecs, cfg, family) {
  if (!family) return []
  const list = await ecs.send(
    new ListTasksCommand({
      cluster: cfg.cluster,
      family,
      desiredStatus: 'STOPPED',
      maxResults: STOPPED_LIMIT,
    }),
  )
  if (!list.taskArns?.length) return []
  const desc = await ecs.send(new DescribeTasksCommand({ cluster: cfg.cluster, tasks: list.taskArns }))
  return (desc.tasks ?? [])
    .map((task) => {
      const entry = {
        taskId: taskIdOfArn(task.taskArn),
        shortId: shortTaskId(taskIdOfArn(task.taskArn)),
        stoppedAt: task.stoppedAt ? new Date(task.stoppedAt).getTime() : null,
        stoppedReason: task.stoppedReason ?? null,
        stopCode: task.stopCode ?? null,
        containerReasons: (task.containers ?? []).map((c) => c.reason).filter(Boolean),
        exitCodes: (task.containers ?? []).map((c) => c.exitCode).filter((x) => x != null),
      }
      return { ...entry, kind: stopKind(entry) }
    })
    .sort((a, b) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0))
}

// Region e account da un ARN: `arn:aws:<servizio>:<region>:<account>:…`. Servono a comporre il prefisso
// degli oggetti di access log, che contiene entrambi.
export function arnParts(arn) {
  const p = String(arn ?? '').split(':')
  return p.length >= 6 ? { region: p[3] || null, accountId: p[4] || null } : { region: null, accountId: null }
}

// Attacca a ogni task la sua latenza, per indirizzo. Stesso join dello stato nel target group: con
// target type `ip` il load balancer conosce le replica per indirizzo, non per id.
export function mergeLatency(tasks, byIp) {
  if (!byIp) return tasks
  return tasks.map((task) => {
    const lat = task.privateIp ? byIp[task.privateIp] : null
    return lat ? { ...task, latency: lat } : task
  })
}

// La famiglia della task-def dall'ARN: `…:task-definition/<family>:<revision>`.
export function familyOfTaskDef(arn) {
  const tail = String(arn ?? '').split('/').pop() || ''
  return tail.split(':')[0] || null
}

// Stato PER TARGET nei target group del servizio, indicizzato per IP.
async function targetsByIp(elb, svc) {
  const arns = (svc?.loadBalancers ?? []).map((lb) => lb.targetGroupArn).filter(Boolean)
  if (!arns.length) return null // servizio senza load balancer: lo stato nel target group non si applica
  const byIp = {}
  for (const TargetGroupArn of arns) {
    const out = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn }))
    for (const d of out.TargetHealthDescriptions ?? []) {
      const ip = d.Target?.Id
      if (!ip) continue
      byIp[ip] = {
        state: d.TargetHealth?.State ?? null,
        reason: d.TargetHealth?.Reason ?? null,
        description: d.TargetHealth?.Description ?? null,
        port: d.Target?.Port ?? null,
      }
    }
  }
  return byIp
}

// Ritorna { logGroup, tasks:[…], revisions:[…], stopped:[…] } | { notApplicable } | { logGroup, error }.
// `revisions` = le revision di task-def viste: più di una significa deploy in corso (o rollout a metà),
// che è la spiegazione di metà delle anomalie "un task si comporta diverso dagli altri".
export async function taskMetrics(service, accounts, { minutes = 15, t = (k) => k } = {}) {
  const cfg = service.aws ?? {}
  if (cfg.type !== 'ecs' || !cfg.cluster || !cfg.service) return { notApplicable: true }

  const acct = service.account ? accounts[service.account] : null
  const aws = {
    profile: acct?.profile,
    roleArn: acct?.roleArn,
    externalId: acct?.externalId,
    region: cfg.region ?? acct?.region,
  }
  const logGroup = `/aws/ecs/containerinsights/${cfg.cluster}/performance`
  const cw = new CloudWatchLogsClient(clientOpts(aws))
  const startTime = Date.now() - Math.max(1, minutes) * 60 * 1000

  try {
    // Filtro sul CONTENUTO, non a valle: il log group porta anche i record di cluster, di servizio e
    // di Fargate, e su un cluster con decine di servizi le righe di questo servizio sarebbero una
    // frazione minima di quelle scaricate.
    const records = []
    let nextToken
    let pages = 0
    do {
      const out = await cw.send(
        new FilterLogEventsCommand({
          logGroupName: logGroup,
          startTime,
          nextToken,
          filterPattern: `{ $.Type = "Task" && $.ServiceName = "${cfg.service}" }`,
        }),
      )
      for (const e of out.events ?? []) {
        try {
          records.push(JSON.parse(e.message))
        } catch {
          /* una riga malformata non deve far fallire tutta la lettura */
        }
      }
      nextToken = out.nextToken
      pages += 1
    } while (nextToken && pages < MAX_PAGES)

    // Dettaglio ECS e stato nei target group, in parallelo e best-effort: se un permesso manca o una
    // chiamata fallisce restano le metriche, che sono il grosso. Un pannello mezzo pieno è utile; uno
    // che non si apre perché un segnale accessorio è andato storto, no.
    const ecs = new ECSClient(clientOpts(aws))
    const elb = new ElasticLoadBalancingV2Client(clientOpts(aws))
    const soft = (p, fallback) => p.catch(() => fallback)
    // Il servizio si descrive UNA volta: da lì escono sia i target group sia la famiglia della
    // task-def, che serve a elencare i task fermati.
    const svc = await soft(
      ecs
        .send(new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }))
        .then((r) => r.services?.[0] ?? null),
      null,
    )
    // La latenza per replica esce dagli access log dell'ALB, non dalle metriche: `TargetResponseTime`
    // esiste per target group e per zona, mai per target. Se gli access log sono spenti torna
    // `notApplicable` e il pannello lo dice, invece di mostrare la media di servizio spacciata per
    // per-task.
    const tgArn = (svc?.loadBalancers ?? []).map((lb) => lb.targetGroupArn).filter(Boolean)[0] ?? null
    const { region: tgRegion, accountId } = arnParts(tgArn)
    const [detail, stopped, byIp, latency] = await Promise.all([
      soft(runningTaskDetail(ecs, cfg), {}),
      soft(stoppedTaskDetail(ecs, cfg, familyOfTaskDef(svc?.taskDefinition)), []),
      soft(targetsByIp(elb, svc), null),
      soft(
        albLatencyByTarget({ targetGroupArn: tgArn, region: tgRegion ?? aws.region, accountId }, aws, { minutes: 15 }),
        { notApplicable: true },
      ),
    ])

    // I record coprono una finestra di minuti, quindi contengono anche task che nel frattempo si sono
    // FERMATI: senza dirlo, un servizio a una replica ne mostrerebbe tre e sembrerebbe scalato.
    // Si marcano `gone` solo se il dettaglio dei task attivi è arrivato davvero — altrimenti, con il
    // permesso assente, li marcheremmo tutti come spenti mentre stanno benissimo.
    const haveDetail = Object.keys(detail).length > 0
    const tasks = mergeLatency(
      mergeTargetHealth(
        latestByTask(records).map((task) => ({
          ...task,
          ...(detail[task.taskId] ?? {}),
          gone: haveDetail && !detail[task.taskId],
        })),
        byIp,
      ),
      latency?.byIp ?? null,
    )
    return {
      logGroup,
      tasks,
      stopped,
      // Da quanti oggetti di access log poggia la latenza: un p95 su tre richieste e uno su tremila non
      // valgono uguale, e il pannello deve poterlo dire.
      latencySource: latency?.notApplicable
        ? { available: false }
        : { available: true, objects: latency?.objects ?? 0, window: latency?.window ?? null, error: latency?.error ?? null },
      revisions: [...new Set(tasks.map((x) => x.revision).filter(Boolean))].sort(),
    }
  } catch (err) {
    // Tipicamente: Container Insights spento sul cluster (il log group non esiste). È un'informazione
    // utile in sé, non un errore da nascondere.
    return { logGroup, error: cleanAwsReason(err, t) }
  }
}
