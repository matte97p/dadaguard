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
// COSA NON C'È: la latenza per task. L'ALB pubblica `TargetResponseTime` per target group e per AZ, mai
// per singolo target, e questi record non la contengono. Ricavarla richiederebbe gli access log ALB su
// S3, che è un'altra sorgente e un altro permesso. La latenza resta un numero di servizio: se un
// pannello la mostrasse per task sarebbe un numero inventato.
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'

const MAX_PAGES = 5

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
      ts: r.Timestamp ?? null,
      startedAt: r.CreatedAt ?? null,
    }))
    // Il task che consuma più CPU in cima: se una replica è in difficoltà, è la riga che si cerca.
    .sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || String(a.shortId).localeCompare(String(b.shortId)))
}

// Ritorna { logGroup, tasks:[…], revisions:[…] } | { notApplicable } | { logGroup, error }.
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

    const tasks = latestByTask(records)
    return {
      logGroup,
      tasks,
      revisions: [...new Set(tasks.map((x) => x.revision).filter(Boolean))].sort(),
    }
  } catch (err) {
    // Tipicamente: Container Insights spento sul cluster (il log group non esiste). È un'informazione
    // utile in sé, non un errore da nascondere.
    return { logGroup, error: cleanAwsReason(err, t) }
  }
}
