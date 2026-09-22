import { LambdaClient, GetAliasCommand } from '@aws-sdk/client-lambda'
import { metricValues } from './cw.js'
import { clientOpts, cleanAwsReason } from './awsClient.js'
import { getLambdaConfig } from './lambdaConfig.js'
import { lastModifier } from './lastModifier.js'
import { nextRun, missedWindow } from '../util/nextrun.js'
import { fmtAgo, identityT } from '../i18n.js'
import { fmtMs, fmtCount } from '../util/format.js'
import { risolviProfilo, valuta, testoRegola } from './soglie.js'

// RuntimeProvider per Lambda. Due profili di salute:
//  - on-demand (webhook/event): finestra breve; 0 invocazioni = `idle` (ok, nessuno l'ha chiamata).
//  - cron (`schedule: 24h|daily|1h|…`): dead man's switch — 0 invocazioni nella cadenza attesa
//    = `down` (la cron è saltata!). MA se lo schedule EventBridge è DISABLED (opts.scheduleState,
//    dallo state TF) → `disabled` (ferma di proposito, non un allarme).
// Permessi: cloudwatch:GetMetricData, lambda:GetFunctionConfiguration (+ lambda:GetAlias se `alias`).
const DEFAULT_WINDOW_MIN = 60 // idle on-demand: 60 min di silenzio prima di "a riposo" (era 15, troppo aggressivo)
const TIMEOUT_WARN = 0.8

// Quando un errore diventa un guasto: la regola non sta qui, sta in `soglie.js`, per tipologia di
// segnale (dal 22/09/2026). Una lambda ne usa due, e la differenza è il DENOMINATORE.
//  - cron → `esecuzioni`: il denominatore sono una o tre run, dove una percentuale non dice niente
//    (1 errore su 1 run è il 100%, 1 su 3 è il 33%, e vogliono dire la stessa cosa). Zero
//    tolleranza, e il backtest del 22/09/2026 dice che è giusto: in 30 giorni la produzione ha avuto
//    4 lambda con errori e 11 ore di allarme, 8 delle quali col 100% delle esecuzioni fallite.
//  - on-demand → `utente`: dietro c'è qualcuno che aspetta una risposta e non ritenta, quindi vale
//    la stessa soglia di una API pubblica, con la scappatoia per «è fallito tutto» sotto campione.
// ⚠️ Il throttling di una lambda NON è il profilo `capacita` come altrove: una run schedulata
// rifiutata per quota è una run che non è avvenuta, cioè lo stesso guasto di una run fallita.
const PROFILO = { cron: 'esecuzioni', ondemand: 'utente' }

// Gli override di config per una lambda, dal ramo GIUSTO. I due rami hanno profili diversi
// (`esecuzioni` e `utente`), quindi un solo oggetto per tutti e due vorrebbe dire che una `rate`
// pensata per le on-demand trasforma la tolleranza zero dei cron in una condizione «e», cioè
// zittisce i cron senza che nessuno l'abbia chiesto. Forma:
//   soglie: { lambda: { cron: { min: 2 }, ondemand: { rate: 0.05 } } }
// Un oggetto piatto (senza `cron`/`ondemand`) vale per tutti e due: è la forma corta per chi ha una
// lambda sola e sa di che ramo è.
function sogliaDi(cfg, opts, ramo) {
  const per = cfg?.soglie ?? opts?.soglie ?? null
  if (!per) return null
  return per.cron || per.ondemand ? (per[ramo] ?? null) : per
}

// Durata compatta con unità tradotte (g/h/m IT, d/h/m EN). `t` di default = identità.
function fmtDur(min, t = identityT) {
  if (min % 1440 === 0) return `${min / 1440}${t('time.unit.d')}`
  if (min >= 60) return `${Math.round(min / 60)}${t('time.unit.h')}`
  return `${min}${t('time.unit.m')}`
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
  // Finestra del dead man's switch dall'ESPRESSIONE vera (fino all'ultimo fire atteso + grazia):
  // una cadenza dedotta dà falsi "GIÙ" sui cron che non girano ogni giorno — un `MON-FRI` guardato
  // di lunedì ha l'ultima esecuzione attesa il venerdì, fuori da qualunque finestra "giornaliera".
  // Se l'espressione non è calcolabile (`rate(...)`) si resta sull'euristica: cadenza × 1.2, min 10m
  // per assorbire la latenza di pubblicazione delle metriche CloudWatch.
  const missed = isCron ? missedWindow(cfg.scheduleExpr, Date.now(), cfg.scheduleTz) : null
  const windowMin = isCron
    ? (missed?.windowMin ?? Math.max(Math.round(schedMin * 1.2), 10))
    : cfg.windowMinutes ?? DEFAULT_WINDOW_MIN

  // Cron col proprio schedule EventBridge DISABLED (dallo state TF) → ferma di proposito.
  // Niente allarme, niente chiamate metriche inutili.
  if (isCron && (opts.scheduleState ?? cfg.scheduleState) === 'DISABLED') {
    return { status: 'disabled', summary: t('lambda.cron.disabled', { sched: fmtDur(schedMin, t) }), schedule: cfg.schedule, scheduleExpr: cfg.scheduleExpr }
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
      // Alias davvero assente vs errore AWS (throttle/denied/...): messaggi distinti, non err.name grezzo.
      const reason =
        err.name === 'ResourceNotFoundException' ? t('lambda.aliasnotfound', { alias: cfg.alias }) : cleanAwsReason(err, t)
      return { status: 'unknown', reason }
    }
  }

  // Timeout (per p95 vs timeout) — solo on-demand, opzionale.
  let timeoutSec = null
  if (!isCron) {
    try {
      const conf = await getLambdaConfig(cfg.function, aws)
      timeoutSec = conf.Timeout ?? null
    } catch {
      /* niente confronto timeout */
    }
  }

  // Metriche sulla finestra (batch CloudWatch condiviso: più servizi → poche GetMetricData).
  const dims = [{ Name: 'FunctionName', Value: cfg.function }]
  const queries = [
    ['inv', 'Invocations', 'Sum'],
    ['err', 'Errors', 'Sum'],
    ['thr', 'Throttles', 'Sum'],
  ]
  queries.push(['dur', 'Duration', 'p95']) // p95 → il batcher aggrega col max dei punti (anche per i cron: latenza)
  // Iniettabile come `deps` in runOnce, stessa convenzione di `bedrock.js`: le soglie sono la parte
  // che si sbaglia, e va provata senza rete.
  const m = await (opts.metricValues ?? metricValues)(aws, 'AWS/Lambda', dims, queries, windowMin)
  const invocations = m.inv
  const errors = m.err
  const throttles = m.thr

  // Prossima esecuzione (solo cron attivi): dal cron() EventBridge. rate() → null (anchor ignoto).
  const now = Date.now()
  const nextRunAt = isCron ? nextRun(cfg.scheduleExpr, now, cfg.scheduleTz) : null
  const nextRunLabel = nextRunAt ? t('cron.next', { in: fmtDur(Math.max(1, Math.round((nextRunAt - now) / 60000)), t) }) : null

  // --- Cron: dead man's switch ---
  if (isCron) {
    if (invocations === 0) {
      return {
        status: 'down',
        // `outcome` STRUTTURATO, non dedotto dal testo: "mai partita" e "partita e fallita" sono due
        // guasti diversi e vanno a due destinatari diversi (il job che crasha lo scrive già da sé;
        // il job che non parte non può scriverlo nessuno dall'interno). Vedi server/notify/watch.js.
        outcome: 'missed',
        summary: missed
          ? t('cron.missed', { ago: fmtAgo(new Date(missed.expectedAt), t) })
          : t('lambda.cron.down', { window: fmtDur(windowMin, t), sched: fmtDur(schedMin, t) }),
        invocations: 0,
        errors,
        throttles,
        schedule: cfg.schedule,
        scheduleExpr: cfg.scheduleExpr,
        nextRunAt,
        nextRunLabel,
      }
    }
    // Tutte le invocazioni falliscono → la cron di fatto non completa mai: GIÙ, non solo ATTENZIONE.
    const soglia = risolviProfilo(PROFILO.cron, sogliaDi(cfg, opts, 'cron'))
    // ⚠️ Errori e throttle si valutano SEPARATI, e non sommati in un numeratore solo: un tentativo
    // rifiutato per quota non compare in `Invocations`, quindi `1 errore + 4 throttle` su 5
    // invocazioni sembrerebbe «sono fallite tutte» mentre quattro run su cinque sono andate bene.
    const sforo = valuta(errors, invocations, soglia)
    const sforoThr = valuta(throttles, invocations, soglia)
    const status = sforo?.tuttoFallito ? 'down' : sforo || sforoThr ? 'degraded' : 'up'
    const p95 = m.dur
    const parts = [t('lambda.runs', { n: invocations }), t('lambda.errors', { n: errors })]
    if (throttles > 0) parts.push(t('lambda.throttled', { n: throttles }))
    if (p95) parts.push(t('lambda.p95', { d: fmtMs(Math.round(p95)) })) // latenza: quanto dura la run
    const metrics = [
      // Niente andamento sul CONTEGGIO di una cron: la serie è 0,0,0,1,0,0… e a 66px quella punta
      // isolata non dice nulla che "1 esecuzione" + "prossima ~tra 22h" non dicano già meglio.
      // L'andamento utile su una cron è la LATENZA (più sotto): dice se le run stanno rallentando.
      { label: t('m.runs', { n: invocations }), value: String(invocations) },
      { label: t('m.errors', { n: errors }), value: String(errors), tone: errors > 0 ? 'critical' : 'good' },
    ]
    if (throttles > 0) metrics.push({ label: t('m.throttle'), value: String(throttles), tone: 'warning' })
    if (p95) metrics.push({ label: t('m.latency'), value: `~${fmtMs(Math.round(p95))}`, kind: 'latency', ms: Math.round(p95), spark: m.series?.dur, sparkUnit: 'ms' })
    return {
      status,
      // `outcome` deve seguire lo STESSO esito dello stato: ci instradano `notify/route.js` e
      // `slack.js`, quindi un `down` con `outcome: 'ok'` manderebbe l'allarme al destinatario
      // sbagliato, o non lo manderebbe affatto.
      outcome: sforo?.tuttoFallito ? 'failed' : 'ok',
      summary: `${parts.join(' · ')} (${fmtDur(windowMin, t)})`,
      metrics,
      window: fmtDur(windowMin, t),
      invocations,
      errors,
      throttles,
      p95Ms: p95 ? Math.round(p95) : null,
      schedule: cfg.schedule,
      scheduleExpr: cfg.scheduleExpr,
      nextRunAt,
      nextRunLabel,
    }
  }

  // --- On-demand ---
  if (invocations === 0) {
    return {
      status: 'idle',
      summary: `${aliasInfo}${t('lambda.idle', { window: fmtDur(windowMin, t) })}`,
      invocations: 0,
      errors,
      throttles,
    }
  }

  const p95 = m.dur
  const errRate = (errors / invocations) * 100
  const nearTimeout = timeoutSec && p95 >= timeoutSec * 1000 * TIMEOUT_WARN
  const soglia = risolviProfilo(PROFILO.ondemand, sogliaDi(cfg, opts, 'ondemand'))
  const sforo = valuta(errors, invocations, soglia)
  const sforoThr = valuta(throttles, invocations, soglia)
  // 100% di errori = il servizio non funziona mai → GIÙ; errori parziali → ATTENZIONE.
  const status = sforo?.tuttoFallito ? 'down' : sforo || sforoThr || nearTimeout ? 'degraded' : 'up'

  const parts = [
    t('lambda.calls', { n: fmtCount(invocations) }),
    t('lambda.errpct', { p: errRate < 0.05 ? '0' : errRate.toFixed(1) }),
    p95 ? t('lambda.p95', { d: fmtMs(Math.round(p95)) }) : null,
    nearTimeout ? t('lambda.neartimeout', { d: fmtMs(timeoutSec * 1000) }) : null,
    throttles > 0 ? t('lambda.throttled', { n: throttles }) : null,
  ].filter(Boolean)

  const metrics = [
    { label: t('m.calls', { n: invocations }), value: fmtCount(invocations), spark: m.series?.inv },
    { label: t('m.errPct'), value: `${errRate < 0.05 ? '0' : errRate.toFixed(1)}%`, tone: errors > 0 ? 'critical' : 'good' },
  ]
  if (p95)
    metrics.push({
      label: t('m.latency'),
      value: `~${fmtMs(Math.round(p95))}`,
      kind: 'latency',
      ms: Math.round(p95),
      tone: nearTimeout ? 'warning' : undefined,
      spark: m.series?.dur,
      sparkUnit: 'ms',
    })
  if (throttles > 0) metrics.push({ label: t('m.throttle'), value: String(throttles), tone: 'warning' })

  // Dettaglio per la chat: "10,7% errori" non dice quanti sono (3 su 28), su quanto tempo (60 min, che
  // il ramo cron scriveva e questo no) né se è sopra soglia. La regola sta nel messaggio, come su
  // Bedrock: si tara leggendo il canale, senza aprire il codice.
  const win = fmtDur(windowMin, t)
  const alert =
    status === 'up'
      ? undefined
      : [
          errors > 0 ? t('lambda.alerterr', { err: errors, n: fmtCount(invocations), p: errRate < 0.05 ? '0' : errRate.toFixed(1), window: win }) : null,
          throttles > 0 ? t('lambda.throttled', { n: throttles }) : null,
          nearTimeout ? t('lambda.neartimeout', { d: fmtMs(timeoutSec * 1000) }) : null,
          p95 ? t('lambda.p95', { d: fmtMs(Math.round(p95)) }) : null,
        ]
          .filter(Boolean)
          .join(' · ') +
        // La regola citata deve essere QUELLA che è scattata: un p95 vicino al timeout non è un
        // errore. E quando è una soglia, la frase la compone `soglie.js`, cioè lo stesso posto che
        // ha deciso: un testo ricopiato qui mentirebbe al primo cambio di taratura.
        t('rule.fires', {
          regola: sforo || sforoThr ? testoRegola(soglia, t, t('soglia.unita.chiamate')) : t('lambda.regolatimeout'),
        })

  return {
    status,
    summary: aliasInfo + parts.join(' · '),
    ...(alert ? { alert: aliasInfo + alert } : {}),
    metrics,
    window: win, // su che periodo sono i numeri (e quindi anche gli andamenti)
    invocations,
    errors,
    throttles,
    p95Ms: Math.round(p95),
    timeoutSec,
  }
}

// #2 build/deploy zero-config per Lambda: versione pubblicata + ultima modifica.
// Se c'è un alias, riporta la versione a cui punta. Permessi: lambda:GetFunctionConfiguration
// (+ lambda:GetAlias se `alias`). Ritorna { version, lastModified } o null.
export async function lambdaBuildInfo(cfg, aws) {
  const lambda = new LambdaClient(clientOpts(aws))
  const conf = await getLambdaConfig(cfg.function, aws)
  let version = conf.Version // di norma "$LATEST"
  if (cfg.alias) {
    try {
      const alias = await lambda.send(
        new GetAliasCommand({ FunctionName: cfg.function, Name: cfg.alias }),
      )
      if (alias.FunctionVersion) version = alias.FunctionVersion
    } catch {
      /* alias assente: tieni la versione della config */
    }
  }
  // CodeSha256 = identità del build (cambia a ogni deploy): per le funzioni non versionate
  // ($LATEST) è l'unico modo per dire "quale build è viva".
  // cacheKey precisa per fn@LastModified: una query per funzione finché non viene rideployata.
  const modifiedBy = await lastModifier(cfg.function, aws, { cacheKey: `${cfg.function}@${conf.LastModified ?? ''}` })
  return { version, lastModified: conf.LastModified ?? null, codeSha: conf.CodeSha256 ?? null, modifiedBy }
}
