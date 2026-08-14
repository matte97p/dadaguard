// ESECUZIONI di un cron, una per una: quali stanno girando ADESSO e com'è andata ognuna di quelle
// finite. Read-only, zero storage, on-demand come tutto il resto.
//
// Perché serve una vista per-esecuzione: i check dicono «il cron va» o «il cron è saltato», che è la
// domanda di un watchdog. Ma un job lungo — uno scraper che macina un'ora — ha altre due domande,
// che nessuna card sa rispondere: *sta girando in questo momento?* e *quella di stanotte com'è
// finita?*. La prima non si deduce dallo stato aggregato (un cron «up» può essere fermo o a metà
// corsa); la seconda vuole la lista delle run, non l'ultima.
//
// DA DOVE ARRIVA UNA RUN, per tipo di cron:
//
//  · ECS RunTask — DUE sorgenti che si completano, e servono entrambe:
//      API ECS   `ListTasks` + `DescribeTasks`: le run VIVE (lastStatus ≠ STOPPED) e l'esito ESATTO
//                di quelle appena finite (exit code, stopCode, «OutOfMemoryError»). Ma ECS dimentica
//                i task fermati dopo ~1h: per un cron giornaliero, la mattina dopo qui non c'è più
//                niente.
//      LOG       un task = un log stream (`<prefisso>/<container>/<taskId>`), quindi lo stream È la
//                run: `DescribeLogStreams` ne dà inizio e fine per quanto dura la retention (giorni).
//                Non dà l'exit code — un task ucciso per OOM non scrive nulla — e per questo l'API
//                non è sostituibile: la si usa dove c'è, il log copre lo storico.
//    Si uniscono per `taskId`, che le due sorgenti condividono.
//
//  · Lambda — una run è la coppia `START RequestId` / `REPORT RequestId` nel log group. Non esiste
//    un'API che elenchi le invocazioni (`Invocations` è un CONTATORE: dice quante, non quali), quindi
//    il log è l'unica sorgente. Vive = START senza REPORT; oltre il timeout della funzione + grazia
//    diventa 'unknown' invece di restare eternamente «in corso».
//
// Permessi: quelli che il ruolo read-only ha già — `ecs:ListTasks`, `ecs:DescribeTasks`,
// `ecs:DescribeTaskDefinition`, `logs:DescribeLogStreams`, `logs:FilterLogEvents`. Nessun grant nuovo.
import {
  ECSClient,
  DescribeTaskDefinitionCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from '@aws-sdk/client-ecs'
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import { clientOpts, cleanAwsReason, isDenied } from './runtime/awsClient.js'
import { getLambdaConfig } from './runtime/lambdaConfig.js'
import { awslogsFromTaskDef, readWindow } from './logs.js'
import { FAILURE_PATTERN } from './runtime/ecsScheduled.js'
import { mapLimit } from './util/pool.js'

// Family dalla task-def (ARN o `family:rev`): serve a `ListTasks`, che filtra per family e non per ARN.
export function familyOfTaskDef(taskDefinition) {
  const s = String(taskDefinition ?? '')
  const fromArn = /task-definition\/([^:/]+)/.exec(s)?.[1]
  return fromArn || s.split(':')[0] || null
}

// Task id dall'ARN (`arn:aws:ecs:…:task/<cluster>/<taskId>`) o dal nome dello stream
// (`<prefisso>/<container>/<taskId>`): in entrambi i casi è l'ultimo segmento.
export const runIdOf = (s) => String(s ?? '').split('/').pop() || null

// Un log stream di ECS RunTask → una run. `firstEventTimestamp`/`lastEventTimestamp` sono la prima e
// l'ultima riga scritta, quindi l'inizio è leggermente DOPO l'avvio vero (pull dell'immagine e boot
// non loggano) e la fine leggermente PRIMA: dove c'è l'API ECS i suoi timestamp vincono, qui servono
// a coprire lo storico che l'API non ha più. Pura/testabile.
export function runsFromStreams(streams = [], { streamPrefix = null, container = null, since = 0 } = {}) {
  const wanted = streamPrefix && container ? `${streamPrefix}/${container}/` : null
  return (streams ?? [])
    // Un task con un sidecar scrive DUE stream: senza filtrare per il container principale la stessa
    // esecuzione comparirebbe due volte, una per container, come se fossero due run.
    .filter((s) => (wanted ? String(s?.logStreamName ?? '').startsWith(wanted) : true))
    .filter((s) => Number.isFinite(s?.firstEventTimestamp) && s.firstEventTimestamp >= since)
    .map((s) => ({
      id: runIdOf(s.logStreamName),
      startedAt: s.firstEventTimestamp,
      endedAt: Number.isFinite(s.lastEventTimestamp) ? s.lastEventTimestamp : null,
      stream: s.logStreamName ?? null,
      running: false, // il log non lo sa dire: una run VIVA sta anche in `ListTasks`, e da lì si marca
      source: 'log',
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

// Un task ECS (da `DescribeTasks`) → una run. `container` = il container principale, quando la
// task-def ne dichiara più di uno: l'exit code che conta è il suo. Pura/testabile.
export function runFromTask(task, { container = null } = {}) {
  const conts = task?.containers ?? []
  const main = (container ? conts.find((c) => c.name === container) : null) ?? conts.find((c) => c.exitCode != null) ?? conts[0]
  const ms = (d) => (d ? new Date(d).getTime() : null)
  return {
    id: runIdOf(task?.taskArn),
    // `startedAt` manca finché il task è in PROVISIONING/PENDING: si ricade su `createdAt`, altrimenti
    // una run appena lanciata comparirebbe senza orario proprio nel momento in cui la stai guardando.
    startedAt: ms(task?.startedAt) ?? ms(task?.createdAt),
    endedAt: ms(task?.stoppedAt),
    running: task?.lastStatus !== 'STOPPED',
    exitCode: main?.exitCode ?? null,
    stopCode: task?.stopCode ?? null,
    stopReason: task?.stoppedReason ?? main?.reason ?? null,
    source: 'api',
  }
}

// Unione delle due sorgenti ECS per `taskId`. L'API vince sui campi che sa (timestamp veri, exit code,
// motivo dello stop); il log riempie i buchi e porta le run che l'API ha già dimenticato. Pura.
export function mergeRuns(logRuns = [], apiRuns = []) {
  const byId = new Map()
  for (const r of logRuns) if (r.id) byId.set(r.id, { ...r })
  for (const r of apiRuns) {
    if (!r.id) continue
    const prev = byId.get(r.id) ?? {}
    byId.set(r.id, {
      ...prev,
      ...r,
      // Lo stream lo conosce solo il log, e serve al pannello per aprire i log di QUESTA run: un
      // merge che lo perde rende la riga non apribile.
      stream: prev.stream ?? null,
      startedAt: r.startedAt ?? prev.startedAt ?? null,
      endedAt: r.endedAt ?? prev.endedAt ?? null,
      source: prev.source ? 'both' : 'api',
    })
  }
  return [...byId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

// Esito di una run, dai segnali disponibili. Pura/testabile.
//   running                       → 'running'
//   exit code ≠ 0, o task morto prima di partire, o OOM → 'failed'
//   errori/traceback nei log       → 'failed' (l'exit code può essere 0 e il job avere fallito dentro)
//   nessun segnale ma la run è chiusa → 'ok'
//   run senza fine e senza modo di saperlo → 'unknown' (mai «ok» per omissione)
export function classifyRun({ running, exitCode, stopCode, stopReason, failed, timedOut, endedAt } = {}) {
  if (running) return 'running'
  if (timedOut) return 'failed'
  if (exitCode != null && exitCode !== 0) return 'failed'
  if (stopCode === 'TaskFailedToStart') return 'failed'
  if (/OutOfMemory|OOMKilled/i.test(String(stopReason ?? ''))) return 'failed'
  if (failed) return 'failed'
  if (!endedAt) return 'unknown'
  return 'ok'
}

// Durata di una run: quella vera se è finita, quella maturata FINORA se sta girando (è il numero che
// si guarda su un job lungo). Pura.
export function runDuration(run, now = Date.now()) {
  if (!run?.startedAt) return null
  const end = run.running ? now : run.endedAt
  if (!end) return null
  return Math.max(0, end - run.startedAt)
}

const MAX_PAGES = 12
// Budget di pagine per la ricerca delle run di una Lambda: più alto di quello di una singola domanda
// («c'è un errore?») perché qui le chiamate si spendono su fette di tempo, non su pagine di righe.
// La vista di UN cron lo alza (`maxPages`): lì si è chiesto esplicitamente uno storico profondo, e
// fermarsi a metà finestra darebbe una lista che sembra completa e non lo è.
const MAX_LAMBDA_PAGES = 25

// «C'è un errore in questo stream?», seguendo le pagine: con `FilterLogEvents` una pagina vuota NON è
// una risposta finché torna un `nextToken` (stesso inganno documentato in runtime/ecsScheduled.js).
async function anyFailure(logs, params) {
  let token
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await logs.send(new FilterLogEventsCommand({ ...params, nextToken: token, limit: 1, filterPattern: FAILURE_PATTERN }))
    if ((r.events ?? []).length) return true
    token = r.nextToken
    if (!token) return false
  }
  return false
}

// Run di un cron su ECS RunTask. `scanFailures` = per quante run (le più recenti) si va a cercare
// l'errore nei log: è una chiamata a testa, e su una lista lunga non serve saperlo per tutte subito.
export async function ecsRuns(cfg, aws, { minutes = 1440, limit = 8, scanFailures = 6, t = (k) => k } = {}) {
  const since = Date.now() - minutes * 60 * 1000
  const ecs = new ECSClient(clientOpts(aws))

  const td = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: cfg.taskDefinition }))).taskDefinition
  const { logGroup, streamPrefix, container } = awslogsFromTaskDef(td, cfg.container)
  const family = familyOfTaskDef(cfg.taskDefinition)

  // API ECS: le run vive e quelle finite nell'ultima ora, con l'esito esatto. Best-effort — senza
  // `ecs:ListTasks` restano le run dal log, che è la maggior parte della lista.
  let apiRuns = []
  try {
    const arns = (
      await Promise.all(
        ['RUNNING', 'STOPPED'].map((desiredStatus) =>
          ecs.send(new ListTasksCommand({ cluster: cfg.cluster, family, desiredStatus, maxResults: 50 })),
        ),
      )
    ).flatMap((r) => r.taskArns ?? [])
    if (arns.length) {
      // `DescribeTasks` accetta 100 ARN per chiamata: oltre, si spezza.
      const chunks = []
      for (let i = 0; i < arns.length; i += 100) chunks.push(arns.slice(i, i + 100))
      const tasks = (await Promise.all(chunks.map((c) => ecs.send(new DescribeTasksCommand({ cluster: cfg.cluster, tasks: c })))))
        .flatMap((r) => r.tasks ?? [])
      apiRuns = tasks.map((task) => runFromTask(task, { container }))
    }
  } catch (err) {
    if (!isDenied(err)) throw err
  }

  if (!logGroup) {
    // Nessun log group nella task-def: restano le run dell'ultima ora dall'API, e va detto perché la
    // lista è corta invece di lasciar credere che il cron non giri da un'ora.
    const runs = apiRuns
      .filter((r) => r.running || (r.startedAt ?? 0) >= since)
      .map((r) => ({ ...r, outcome: classifyRun(r) }))
    return { logGroup: null, runs: runs.slice(0, limit), apiOnly: true }
  }

  const logs = new CloudWatchLogsClient(clientOpts(aws))
  let logRuns = []
  try {
    const out = await logs.send(
      new DescribeLogStreamsCommand({
        logGroupName: logGroup,
        orderBy: 'LastEventTime',
        descending: true,
        // Un po' più di `limit`: il filtro per container e per finestra ne scarta qualcuno, e chiedere
        // esattamente `limit` stream darebbe una lista più corta del richiesto.
        limit: Math.min(50, Math.max(limit * 2, 10)),
      }),
    )
    logRuns = runsFromStreams(out.logStreams ?? [], { streamPrefix, container, since })
  } catch (err) {
    if (!isDenied(err)) return { logGroup, runs: [], error: cleanAwsReason(err, t) }
    // `logs:DescribeLogStreams` negato: si resta sull'ora dell'API. Meglio poco e vero.
  }

  const merged = mergeRuns(logRuns, apiRuns).filter((r) => r.running || (r.startedAt ?? 0) >= since).slice(0, limit)

  // Errori nei log, solo per le run in cima e solo dove servono davvero: se l'exit code c'è ed è ≠ 0
  // la run è già fallita, e una chiamata in più non aggiunge niente.
  const daScansionare = merged.filter((r) => r.stream && !r.running && r.exitCode !== 0).slice(0, scanFailures)
  const failedById = new Map()
  await mapLimit(daScansionare, 4, async (r) => {
    try {
      const failed = await anyFailure(logs, {
        logGroupName: logGroup,
        logStreamNames: [r.stream],
        startTime: r.startedAt ?? since,
        // +1 min: l'ultima riga di un traceback può arrivare dopo lo `stoppedAt` del task.
        endTime: (r.endedAt ?? Date.now()) + 60_000,
      })
      failedById.set(r.id, failed)
    } catch {
      /* niente scansione per questa run: l'esito resta quello dei segnali API */
    }
  })

  return {
    logGroup,
    streamPrefix,
    container,
    runs: merged.map((r) => {
      const failed = failedById.get(r.id)
      return {
        ...r,
        // `failedScanned` dice al pannello se «nessun errore» è una risposta o solo una mancanza: senza,
        // una run non scansionata sembrerebbe verde per averlo verificato.
        failedScanned: failedById.has(r.id),
        outcome: classifyRun({ ...r, failed }),
      }
    }),
  }
}

// Righe di piattaforma e di errore che delimitano e qualificano una invocazione Lambda. Un solo
// `FilterLogEvents` le porta tutte: START/REPORT per costruire la run, il resto per dire com'è andata.
export const LAMBDA_PATTERN =
  '?"START RequestId" ?"REPORT RequestId" ?"Task timed out" ?Traceback ?"[ERROR]" ?"ERROR:" ?"CRITICAL:"'

const RE_START = /^START RequestId:\s*([0-9a-f-]{36})/i
const RE_REPORT = /^REPORT RequestId:\s*([0-9a-f-]{36})/i
const RE_DURATION = /\bDuration:\s*([\d.]+)\s*ms/i
const RE_BILLED = /\bBilled Duration:\s*([\d.]+)\s*ms/i
const RE_MAXMEM = /\bMax Memory Used:\s*(\d+)\s*MB/i
const RE_TIMEOUT = /Task timed out after\s*([\d.]+)\s*seconds/i

// Eventi di log → run Lambda. Pura/testabile, ed è il cuore della sorgente: qui non c'è nessuna API
// che elenchi le invocazioni, quindi la lista delle esecuzioni È questa lettura.
//
// L'attribuzione degli errori si appoggia a un fatto del runtime, non a un'euristica: dentro UN log
// stream le invocazioni sono SERIALI (uno stream = un ambiente di esecuzione, che serve una richiesta
// alla volta). Quindi una riga di errore appartiene all'invocazione aperta in quello stream — e le
// invocazioni concorrenti, che stanno su stream diversi, non si mescolano.
export function pairLambdaRuns(events = [], { now = Date.now(), timeoutSec = null, graceMs = 60_000 } = {}) {
  const byId = new Map()
  const openByStream = new Map() // stream → requestId dell'invocazione in corso
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, { id, startedAt: null, endedAt: null, durationMs: null, billedMs: null, maxMemoryMb: null, errors: 0, timedOut: false, source: 'log', stream: null })
    return byId.get(id)
  }

  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const msg = String(e.message ?? '').trim()
    const stream = e.stream ?? null
    const start = RE_START.exec(msg)
    if (start) {
      const run = get(start[1])
      run.startedAt = e.ts
      run.stream = stream
      if (stream) openByStream.set(stream, start[1])
      continue
    }
    const report = RE_REPORT.exec(msg)
    if (report) {
      const run = get(report[1])
      run.endedAt = e.ts
      run.stream = run.stream ?? stream
      const dur = RE_DURATION.exec(msg)
      if (dur) run.durationMs = Number(dur[1])
      const billed = RE_BILLED.exec(msg)
      if (billed) run.billedMs = Number(billed[1])
      const mem = RE_MAXMEM.exec(msg)
      if (mem) run.maxMemoryMb = Number(mem[1])
      // La run PRIMA di questo REPORT è chiusa: le righe successive dello stream sono di un'altra.
      if (stream && openByStream.get(stream) === report[1]) openByStream.delete(stream)
      continue
    }
    // Riga non di piattaforma: errore o timeout. Va alla run aperta in QUESTO stream; se lo stream non
    // ne ha una (START più vecchio della finestra letta), il timeout porta con sé il proprio requestId.
    const openId = stream ? openByStream.get(stream) : null
    const timeout = RE_TIMEOUT.exec(msg)
    const id = openId ?? (timeout ? /([0-9a-f-]{36})/.exec(msg)?.[1] : null)
    if (!id) continue
    const run = get(id)
    run.stream = run.stream ?? stream
    if (timeout) run.timedOut = true
    else run.errors += 1
  }

  const timeoutMs = timeoutSec ? timeoutSec * 1000 : null
  return [...byId.values()]
    .map((run) => {
      // START fuori dalla finestra letta: l'inizio si ricostruisce dal REPORT, che porta la durata.
      const startedAt = run.startedAt ?? (run.endedAt && run.durationMs ? run.endedAt - run.durationMs : run.endedAt)
      // Senza REPORT la run è «in corso» solo finché può esserlo: oltre il timeout della funzione più
      // una grazia, il REPORT non arriverà mai (log troncato, o processo ucciso) → 'unknown', non un
      // «in corso» eterno che finge un lavoro che non sta avvenendo.
      const stale = timeoutMs && startedAt ? now - startedAt > timeoutMs + graceMs : false
      const running = !run.endedAt && !stale
      const durationMs = run.durationMs ?? (run.endedAt && startedAt ? run.endedAt - startedAt : null)
      return {
        ...run,
        startedAt,
        running,
        durationMs,
        failedScanned: true, // gli errori arrivano dalla STESSA lettura: qui «nessuno» è una risposta
        outcome: classifyRun({ running, failed: run.errors > 0, timedOut: run.timedOut, endedAt: run.endedAt }),
      }
    })
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

// QUANTO indietro guardare per trovare le ultime `limit` run di questo cron. È la misura che sostituisce
// una manciata di chiamate con UNA sola, e nasce da tre numeri misurati sui cron veri:
//  · la quota di CloudWatch Logs è ~10 `FilterLogEvents` al secondo per account: con ventisei cron letti
//    insieme la STESSA query passa da 600ms a 4,8 secondi di attesa e retry. Il costo dominante è il
//    NUMERO di chiamate, non quanto log scansionano;
//  · leggere «a fette» dal presente verso il passato costava 4-8 chiamate per cron — corretto per
//    l'ordinamento, disastroso per la quota (un cron giornaliero: 1,4s da solo, 18s in mezzo agli altri);
//  · ma la CADENZA del cron dice già quanto indietro serve andare: per sei run di un job che gira ogni
//    cinque minuti bastano 35 minuti; per sei run di un giornaliero servono sei giorni.
// Quindi: finestra = cadenza × (run chieste + 1), mai oltre quella richiesta da chi guarda, mai sotto un
// quarto d'ora (un cron al minuto con una finestra di 6 minuti sarebbe al limite del rumore). Pura.
export function windowForRuns(minutes, { scheduleMinutes = null, limit = 6 } = {}) {
  const cadenza = Number.isFinite(scheduleMinutes) && scheduleMinutes > 0 ? scheduleMinutes : 1440
  return Math.max(15, Math.min(minutes, cadenza * (limit + 1)))
}

// Gli stream su cui vale la pena restringere la ricerca, e SE si può farlo senza perdere run.
//
// Restringere paga: una `FilterLogEvents` sul log group intero costa ~600ms, sugli stream recenti
// ~100ms. Ma «i più recenti» è corretto solo se quegli stream COPRONO la finestra chiesta, altrimenti
// una run vecchia sta in uno stream che non abbiamo elencato e sparisce senza dirlo. Due condizioni,
// ognuna sufficiente e verificabile:
//   · sono ARRIVATI TUTTI (meno di quanti chiesti = il gruppo non ne ha altri);
//   · il più vecchio che abbiamo ha smesso di scrivere PRIMA dell'inizio della finestra (quindi tutto
//     ciò che cade dentro la finestra sta negli stream che abbiamo).
// Nessuna delle due → si legge il gruppo intero: più lento, ma non si perde niente in silenzio. Pura.
export function pickRecentStreams(streams = [], { since = 0, wanted = 20 } = {}) {
  const validi = (streams ?? []).filter((s) => s?.logStreamName)
  const names = validi.map((s) => s.logStreamName)
  if (!names.length) return { names: [], restrict: false }
  const oldest = Math.min(...validi.map((s) => (Number.isFinite(s.lastEventTimestamp) ? s.lastEventTimestamp : Infinity)))
  return { names, restrict: validi.length < wanted || oldest <= since }
}

// Run di un cron Lambda. Si legge A RITROSO: «le ultime N esecuzioni» chieste sulla finestra intera
// darebbero le PIÙ VECCHIE (FilterLogEvents restituisce dal più vecchio), che è il contrario di quello
// che si guarda — e su un cron ogni 5 minuti la finestra da 24h contiene 288 run.
export async function lambdaRuns(
  cfg,
  aws,
  { minutes = 1440, limit = 8, maxPages = MAX_LAMBDA_PAGES, scheduleMinutes = null, t = (k) => k } = {},
) {
  const logGroup = `/aws/lambda/${cfg.function}`
  const logs = new CloudWatchLogsClient(clientOpts(aws))
  const now = Date.now()
  const windowMin = windowForRuns(minutes, { scheduleMinutes, limit })
  const since = now - windowMin * 60 * 1000

  // Su una finestra lunga conviene restringere agli stream recenti: costa una `DescribeLogStreams`
  // (quota separata e più larga, ~35ms) e fa scendere la `FilterLogEvents` da ~600ms a ~100ms. Su una
  // finestra corta no: non c'è abbastanza da scansionare perché la chiamata in più si ripaghi.
  let onlyStreams = null
  if (windowMin > 120) {
    try {
      const wanted = 20
      const out = await logs.send(
        new DescribeLogStreamsCommand({ logGroupName: logGroup, orderBy: 'LastEventTime', descending: true, limit: wanted }),
      )
      const { names, restrict } = pickRecentStreams(out.logStreams ?? [], { since, wanted })
      if (restrict && names.length) onlyStreams = names
    } catch (err) {
      if (!isDenied(err)) throw err
    }
  }

  const events = []
  let pages = 0
  let truncated = false
  try {
    let token
    do {
      const out = await logs.send(
        new FilterLogEventsCommand({
          logGroupName: logGroup,
          startTime: since,
          endTime: now,
          filterPattern: LAMBDA_PATTERN,
          ...(onlyStreams ? { logStreamNames: onlyStreams } : {}),
          nextToken: token,
        }),
      )
      for (const e of out.events ?? []) events.push({ ts: e.timestamp, message: e.message ?? '', stream: e.logStreamName ?? null })
      token = out.nextToken
      pages += 1
      // Tetto di pagine: `FilterLogEvents` restituisce dal più VECCHIO, quindi fermarsi a metà lascia
      // fuori le run recenti — cioè quelle che si stanno cercando. Succede solo se la finestra contiene
      // molte più run del richiesto; lo si DICE (`truncated`), non si finge una lista completa.
      if (token && pages >= maxPages) truncated = true
    } while (token && pages < maxPages)
  } catch (err) {
    return { logGroup, runs: [], error: cleanAwsReason(err, t) }
  }

  let runs = pairLambdaRuns(events, { now })
  // Il timeout della funzione serve a UNA sola domanda: una run senza REPORT sta ancora girando o il
  // REPORT non arriverà mai? Si chiede solo se quella domanda esiste — su venti cron che hanno tutti
  // finito sarebbero venti `GetFunctionConfiguration` per non usarne nessuna.
  if (runs.some((r) => !r.endedAt)) {
    try {
      const timeoutSec = (await getLambdaConfig(cfg.function, aws)).Timeout ?? null
      if (timeoutSec) runs = pairLambdaRuns(events, { now, timeoutSec })
    } catch {
      /* senza il timeout una run senza REPORT resta «in corso» più a lungo: non è un errore */
    }
  }
  return { logGroup, truncated, runs: runs.slice(0, limit) }
}

// Run di un cron, qualunque sia il suo tipo. `cron` è la descrizione che ne fa `server/crons.js`.
export async function cronRuns(cron, aws, opts = {}) {
  if (cron.type === 'ecs-scheduled') {
    return ecsRuns({ cluster: cron.cluster, taskDefinition: cron.taskDefinition, container: cron.container }, aws, opts)
  }
  if (cron.type === 'lambda') return lambdaRuns({ function: cron.function }, aws, { ...opts, scheduleMinutes: cron.scheduleMinutes ?? null })
  return { runs: [], notApplicable: true }
}

// I log di UNA esecuzione di UN cron. Il log group NON arriva dal client: lo si risolve qui dal cron
// (task-def per ECS, nome della funzione per Lambda), così la lettura resta dentro i log dei cron
// scoperti e non diventa «leggimi un log group qualunque di questo account».
//
// Lo `stream`, invece, il client lo passa: è quello della run che ha in mano. Non è un varco — un
// nome di stream vale solo DENTRO il log group già risolto qui, e uno sbagliato dà zero righe.
export async function cronRunLogs(cron, aws, { runId = null, stream = null, from, to = null, limit = 300, errorsOnly = false, t = (k) => k } = {}) {
  let logGroup = null
  let exact = stream

  if (cron.type === 'lambda') {
    logGroup = `/aws/lambda/${cron.function}`
  } else if (cron.type === 'ecs-scheduled') {
    const ecs = new ECSClient(clientOpts(aws))
    const td = (await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: cron.taskDefinition }))).taskDefinition
    const cfg = awslogsFromTaskDef(td, cron.container)
    logGroup = cfg.logGroup
    // Su RunTask lo stream della run si COMPONE dall'id del task: non serve chiederlo né cercarlo.
    if (!exact && runId && cfg.streamPrefix && cfg.container) exact = `${cfg.streamPrefix}/${cfg.container}/${runId}`
  }
  if (!logGroup) return { notApplicable: true }

  const cw = new CloudWatchLogsClient(clientOpts(aws))
  try {
    // Health-check: su un cron non esistono, e tenerli spenti nasconderebbe una riga vera che gli
    // somiglia. Qui si legge tutto quello che la run ha scritto.
    return await readWindow(cw, { logGroup, stream: exact, from, to, limit, errorsOnly, skipHealth: false })
  } catch (err) {
    return { logGroup, events: [], error: cleanAwsReason(err, t) }
  }
}
