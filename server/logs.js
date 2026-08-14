// Log recenti di una risorsa, on-demand (read-only, zero storage): la naturale risposta a
// "perché è rosso?". Risolve il log group e legge gli ultimi eventi via FilterLogEvents.
//  - lambda → /aws/lambda/<function> (deterministico)
//  - ecs    → log group dal task definition (logDriver awslogs)
//  - override → aws.logGroup per qualunque tipo
// Permessi: logs:FilterLogEvents (+ ecs:DescribeServices/DescribeTaskDefinition già concessi).
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'

// pattern CloudWatch: eventi che contengono uno di questi termini (OR)
const ERROR_PATTERN = '?ERROR ?Error ?error ?Exception ?exception ?FATAL ?CRITICAL ?Traceback'

// Riga di access log di un health-check (ALB/target group verso l'endpoint di liveness). Su un
// servizio HTTP sano sono la maggioranza schiacciante del log — 3 nodi ALB ogni 10s = ~1000 righe/h —
// e riempiono il tetto di righe cacciando fuori tutto il resto: un turno di chat appena eseguito
// finiva fuori dalle 100 righe restituite.
//
// Si scartano MENTRE si raccoglie, non nel pannello: filtrarle dopo lascerebbe una lista quasi vuota,
// perché il tetto si è già speso su di loro. Non si delega nemmeno a CloudWatch (`-"/health"`): un
// filterPattern di sola negazione è terreno incerto, e se lo rifiuta il pannello non mostra più nulla.
export const HEALTH_LINE = /\b(?:GET|HEAD)\s+\/(?:health|healthz|_health|healthcheck|livez|readyz)\b/i

// Nome del log stream di UN task ECS. Il driver awslogs lo compone così — prefisso configurato,
// nome del container, id del task — quindi conoscendo la task-def si costruisce senza cercarlo:
// `logs:DescribeLogStreams` non è tra i permessi del ruolo read-only, e non serve.
export function ecsStreamName({ streamPrefix, container }, taskId) {
  if (!streamPrefix || !container || !taskId) return null
  return `${streamPrefix}/${container}/${taskId}`
}

// Configurazione `awslogs` di una task definition → { logGroup, streamPrefix, container }. Pura.
// `preferred` = il container che interessa quando la task-def ne dichiara più di uno (un sidecar
// scrive sul suo stream, e prenderlo per il principale sposta i log su un altro flusso); senza,
// vince il primo container che ha il driver awslogs.
export function awslogsFromTaskDef(taskDefinition, preferred = null) {
  const conts = taskDefinition?.containerDefinitions ?? []
  const awslogs = conts.filter((c) => c.logConfiguration?.logDriver === 'awslogs')
  const c = (preferred ? awslogs.find((x) => x.name === preferred) : null) ?? awslogs[0]
  if (!c) return { logGroup: null }
  return {
    logGroup: c.logConfiguration.options?.['awslogs-group'] ?? null,
    streamPrefix: c.logConfiguration.options?.['awslogs-stream-prefix'] ?? null,
    container: c.name ?? null,
  }
}

// Ritorna { logGroup, streamPrefix, container } — gli ultimi due solo per ECS, e servono a filtrare
// per singola istanza. `logGroup` null = il tipo non ha log applicativi su CloudWatch.
async function resolveLogGroup(service, aws) {
  const cfg = service.aws ?? {}
  if (cfg.logGroup) return { logGroup: cfg.logGroup } // override esplicito
  if (cfg.type === 'lambda' && cfg.function) return { logGroup: `/aws/lambda/${cfg.function}` }
  if (cfg.type === 'ecs') {
    const ecs = new ECSClient(clientOpts(aws))
    const svc = (await ecs.send(new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }))).services?.[0]
    if (!svc?.taskDefinition) return { logGroup: null }
    const td = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: svc.taskDefinition }))).taskDefinition
    return awslogsFromTaskDef(td, cfg.container)
  }
  // cron su ECS RunTask: il log group sta nella task-def schedulata (nessun servizio da interrogare).
  if (cfg.type === 'ecs-scheduled' && cfg.taskDefinition) {
    const ecs = new ECSClient(clientOpts(aws))
    const td = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: cfg.taskDefinition }))).taskDefinition
    return awslogsFromTaskDef(td, cfg.container)
  }
  return { logGroup: null } // tipo senza log applicativi su CloudWatch
}

// FETTE A RITROSO, dalla più recente alla più vecchia, in minuti-fa: `[fromAgo, toAgo]`.
// Servono perché FilterLogEvents restituisce gli eventi dal PIÙ VECCHIO: chiedere "le ultime 100
// righe" alla finestra intera dà le 100 più VECCHIE. Su un servizio chiacchierone (3 nodi ALB che
// fanno health-check ogni 10s = ~1000 righe/h) il tetto si esaurisce nei primi 90 secondi della
// finestra, e l'attività di adesso — quella per cui hai aperto il pannello — non compare affatto.
//
// Le fette crescono (1, 2, 4, 8… minuti): sui casi densi la prima basta, e una finestra da 48h senza
// nessun match si copre in una ventina di chiamate invece di seicento. Tetto per fetta a 4h: oltre,
// una singola chiamata tornerebbe a spazzolare troppo per riempire il tetto di righe.
export function backwardSlices(minutes) {
  const out = []
  let toAgo = 0
  let size = 1
  while (toAgo < minutes) {
    out.push([toAgo, Math.min(minutes, toAgo + size)])
    toAgo += size
    size = Math.min(size * 2, 240)
  }
  return out
}

const MAX_PAGES_PER_SLICE = 10
const MAX_PAGES_TOTAL = 40

// Le `need` righe PIÙ RECENTI di una fetta, in ordine cronologico. `more` = nella fetta c'era altro
// prima di queste (scartato di proposito, o pagine finite): serve a marcare la risposta troncata.
// `skipped` = righe di health-check buttate via strada facendo, da dire al lettore.
export async function readSlice(cw, params, need, budget, { skipHealth = true } = {}) {
  const events = []
  let nextToken
  let pages = 0
  let dropped = false
  let skipped = 0
  do {
    const out = await cw.send(new FilterLogEventsCommand({ ...params, nextToken }))
    for (const e of out.events ?? []) {
      const message = (e.message ?? '').trimEnd()
      if (skipHealth && HEALTH_LINE.test(message)) {
        skipped += 1
        continue
      }
      // `stream` = il log stream di provenienza. Su ECS è `<prefisso>/<container>/<taskId>`, quindi
      // identifica LA REPLICA che ha scritto la riga: senza di lui i flussi di 2-3 task arrivano
      // mescolati e una sostituzione di task sembra un log che salta.
      events.push({ ts: e.timestamp, message, stream: e.logStreamName ?? null })
    }
    // FilterLogEvents legge più stream in parallelo (un servizio ECS = un flusso per task) e l'ordine
    // che torna non è garantito per timestamp: senza riordinare, "i più recenti della fetta" sarebbero
    // gli ultimi ARRIVATI, che è una cosa diversa. Si ordina prima di tagliare, non dopo.
    events.sort((a, b) => a.ts - b.ts)
    if (events.length > need) {
      events.splice(0, events.length - need) // teniamo la CODA: ordinati, i più recenti stanno in fondo
      dropped = true
    }
    nextToken = out.nextToken
    pages += 1
    budget.pages += 1
  } while (nextToken && pages < MAX_PAGES_PER_SLICE && budget.pages < MAX_PAGES_TOTAL)
  return { events, more: dropped || Boolean(nextToken), skipped }
}

// Le righe di UNA finestra chiusa da entrambi i lati, su uno stream preciso quando lo si conosce: è
// così che si leggono i log di UNA esecuzione. `to` assente = run ancora in corso, si legge fino ad
// adesso. Condivisa fra i log di servizio e quelli per-esecuzione (server/runs.js), così la lettura
// resta una sola implementazione.
export async function readWindow(cw, { logGroup, stream = null, from, to = null, limit = 200, errorsOnly = false, skipHealth = true }) {
  const budget = { pages: 0 }
  const slice = await readSlice(
    cw,
    {
      logGroupName: logGroup,
      startTime: Number(from),
      // +1 min di coda: l'ultima riga di un traceback arriva dopo la fine dichiarata della run.
      endTime: Number.isFinite(Number(to)) ? Number(to) + 60_000 : Date.now(),
      ...(stream ? { logStreamNames: [stream] } : {}),
      ...(errorsOnly ? { filterPattern: ERROR_PATTERN } : {}),
    },
    Math.min(Math.max(1, Number(limit) || 200), 500),
    budget,
    { skipHealth },
  )
  return {
    logGroup,
    events: slice.events,
    truncated: slice.more,
    healthSkipped: slice.skipped,
    streams: [...new Set(slice.events.map((e) => e.stream).filter(Boolean))].sort(),
  }
}

// Ritorna { logGroup, events:[{ts,message,stream}], truncated, healthSkipped, streams, task } |
// { notApplicable } | { logGroup, error }. `task` = l'id del task a cui la lettura è stata ristretta.
//
// `stream` + `from`/`to` = i log di UNA SOLA ESECUZIONE (vedi server/runs.js). Perché così e non
// filtrando per request id: su Lambda le righe dell'applicazione non contengono il request id — lo
// stampa la piattaforma su START/REPORT, non un `print` — quindi cercarlo restituirebbe tre righe di
// contorno e nessun log del lavoro. Lo stream invece serve UNA invocazione alla volta (è un ambiente
// di esecuzione), e su ECS RunTask è addirittura un task solo: stream + intervallo = quella run e
// nient'altro.
export async function recentLogs(
  service,
  accounts,
  { errorsOnly = false, minutes = 60, limit = 100, skipHealth = true, task = null, stream: wantStream = null, from = null, to = null, t = (k) => k } = {},
) {
  const acct = service.account ? accounts[service.account] : null
  const aws = {
    profile: acct?.profile,
    roleArn: acct?.roleArn,
    externalId: acct?.externalId,
    region: service.aws?.region ?? acct?.region,
  }

  let resolved = { logGroup: null }
  try {
    resolved = await resolveLogGroup(service, aws)
  } catch {
    resolved = { logGroup: null }
  }
  const { logGroup } = resolved
  if (!logGroup) return { notApplicable: true }
  // Il task chiesto diventa un nome di stream ESATTO. Se non si riesce a comporlo (prefisso o container
  // ignoti) si legge il servizio intero: meglio più righe del richiesto che una lista vuota senza
  // spiegazione — e `task` nella risposta dice al pannello se il filtro ha davvero attecchito.
  const stream = wantStream ?? (task ? ecsStreamName(resolved, task) : null)

  const cw = new CloudWatchLogsClient(clientOpts(aws))
  const now = Date.now()
  // Finestra e tetto sono aritmetica: un NaN non alza un errore, si propaga e fa restituire "nessun
  // evento" (o tutto quanto). Numeri non validi → default, non NaN.
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
  const windowMinutes = Math.max(1, num(minutes, 60))
  const cap = Math.min(Math.max(1, num(limit, 100)), 200)
  try {
    // "Log recenti" vuol dire le righe più recenti: si raccoglie dal presente verso il passato e si
    // ferma appena il tetto è pieno. Le fette più vecchie non vengono nemmeno chieste.
    const events = [] // ordine finale: dal più vecchio al più recente (come li legge il pannello)
    let truncated = false
    let healthSkipped = 0
    const budget = { pages: 0 }
    // Intervallo ESPLICITO (una singola esecuzione): niente fette a ritroso — la finestra è già quella
    // giusta e chiuderla da entrambi i lati è ciò che tiene fuori la run precedente e la successiva.
    if (Number.isFinite(Number(from))) {
      const out = await readWindow(cw, { logGroup, stream, from, to, limit: cap, errorsOnly, skipHealth })
      return { ...out, task: stream ? task : null }
    }
    for (const [fromAgo, toAgo] of backwardSlices(windowMinutes)) {
      const need = cap - events.length
      if (need <= 0 || budget.pages >= MAX_PAGES_TOTAL) {
        truncated = true
        break
      }
      const slice = await readSlice(
        cw,
        {
          logGroupName: logGroup,
          startTime: now - toAgo * 60 * 1000,
          endTime: now - fromAgo * 60 * 1000,
          // Filtrare per istanza va chiesto a CloudWatch, non fatto a valle: un task chiacchierone
          // riempirebbe il tetto di righe e degli altri non resterebbe niente da mostrare.
          ...(stream ? { logStreamNames: [stream] } : {}),
          ...(errorsOnly ? { filterPattern: ERROR_PATTERN } : {}),
        },
        need,
        budget,
        { skipHealth },
      )
      events.unshift(...slice.events) // la fetta appena letta è più vecchia di quelle già raccolte
      healthSkipped += slice.skipped
      if (slice.more) truncated = true
    }
    // Gli stream incontrati: è da qui che il pannello ricava le istanze da offrire nel filtro, quindi
    // vengono elencati anche quando un filtro è già attivo (in quel caso è uno solo, e il pannello
    // tiene le opzioni che aveva).
    const streams = [...new Set(events.map((e) => e.stream).filter(Boolean))].sort()
    return { logGroup, events, truncated, healthSkipped, streams, task: stream ? task : null }
  } catch (err) {
    return { logGroup, error: cleanAwsReason(err, t) } // es. group inesistente / permessi
  }
}
