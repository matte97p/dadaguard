import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getStatus } from '../status.js'
import { publishStatus } from '../statusCache.js'
import { makeT } from '../i18n.js'
import { log } from '../log.js'
import { diffStates, snapshot } from './diff.js'
import { slackMessage, postSlack, messaggioAccessi } from './slack.js'
import { loadConfig } from '../config.js'
import { statoAccessi, segnali, daAnnunciare } from '../accessi.js'
import { splitByRoute } from './route.js'

// Il watchdog vero e proprio: guarda la flotta a intervalli, e quando qualcosa ATTRAVERSA il confine
// problema/non-problema lo dice su Slack. Finché questo non esisteva, Dadaguard era una dashboard —
// una cosa che devi ricordarti di aprire: il cron di produzione fallito all'01:01 l'abbiamo scoperto
// alle 14:30 guardando una card.
//
// Gira nel SERVER, non nel browser: il polling della dashboard esiste solo mentre qualcuno la tiene
// aperta, e alle 4 del mattino non c'è nessuno.
//
// Configurazione (tutta opzionale: senza webhook il watcher non parte e non chiama AWS):
//   DADAGUARD_SLACK_WEBHOOK        destinazione di ciò che nessun altro dice (ECS, endpoint, secret,
//                                  drift, backup, certificati, sicurezza, Bedrock, Cloudflare)
//   DADAGUARD_SLACK_WEBHOOK_CRON   opzionale: destinazione del solo «cron mai partito» — il buco del
//                                  canale dei cron, dove la squadra guarda già. Assente → va nel
//                                  webhook principale
//   DADAGUARD_NOTIFY_CRON_FAILED   1 per riattivare anche i cron CADUTI (di norma taciuti: li scrive
//                                  già il job stesso, con più dettaglio)
//   DADAGUARD_WATCH_INTERVAL  secondi tra i giri (default 300: per i cron 5 minuti sono abbondanti,
//                             e ogni giro costa chiamate AWS)
//   DADAGUARD_WATCH_CONFIRM   letture consecutive perché una transizione conti (default 2)
//   DADAGUARD_STATE_FILE      dove ricordare lo stato (default .dadaguard-state.json nel cwd)
//   DADAGUARD_PUBLIC_URL      link messo in fondo al messaggio
const DEFAULT_INTERVAL_S = 300
const DEFAULT_CONFIRMATIONS = 2

export function watchConfig(env = process.env) {
  return {
    webhook: env.DADAGUARD_SLACK_WEBHOOK || null,
    webhookCron: env.DADAGUARD_SLACK_WEBHOOK_CRON || null,
    notifyCronFailed: env.DADAGUARD_NOTIFY_CRON_FAILED === '1',
    intervalMs: Math.max(30, Number(env.DADAGUARD_WATCH_INTERVAL) || DEFAULT_INTERVAL_S) * 1000,
    confirmations: Math.max(1, Number(env.DADAGUARD_WATCH_CONFIRM) || DEFAULT_CONFIRMATIONS),
    stateFile: env.DADAGUARD_STATE_FILE || '.dadaguard-state.json',
    publicUrl: env.DADAGUARD_PUBLIC_URL || null,
    lang: env.DADAGUARD_LANG || 'it',
  }
}

// Lo stato precedente. Assente/illeggibile → `null`, che il differ tratta come PRIMO GIRO: prende
// nota e non annuncia niente. È deliberato: su ECS il filesystem del task è effimero, quindi a ogni
// deploy si ricomincia — meglio perdere una transizione che rovesciare in chat lo stato del mondo
// a ogni rilascio.
async function loadState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function saveState(file, state) {
  try {
    await mkdir(dirname(file), { recursive: true }).catch(() => {})
    await writeFile(file, JSON.stringify(state), 'utf8')
  } catch (err) {
    // filesystem in sola lettura: il watcher continua a funzionare DENTRO la vita del processo
    // (stato in memoria), semplicemente non sopravvive al riavvio.
    log.error('watch: stato non salvato', { err: err.message })
  }
}

// Un giro: leggi lo stato del mondo, confronta col precedente, annuncia le transizioni, salva.
// Esportato perché è la cosa da testare (e da invocare a mano, in un futuro `/api/watch/run`).
export async function runOnce(cfg, deps = {}) {
  const fetchStatus = deps.getStatus ?? getStatus
  // Il giro del watchdog costa quanto quello della dashboard, e finiva solo in un confronto con lo
  // stato precedente: regalarlo alla cache che serve le pagine vuol dire che ogni 300 secondi la UI ha
  // un dato fresco senza che nessuno abbia aspettato. Iniettabile perché `runOnce` è la cosa provata.
  const pubblica = deps.publishStatus ?? publishStatus
  const send = deps.postSlack ?? postSlack
  const readState = deps.loadState ?? loadState
  const writeState = deps.saveState ?? saveState
  const t = makeT(cfg.lang)

  const status = await fetchStatus(cfg.lang)
  pubblica(cfg.lang, status)
  const prev = await readState(cfg.stateFile)
  const { transitions, next } = diffStates(prev, snapshot(status.services ?? []), {
    confirmations: cfg.confirmations,
  })
  // Memoria della destinazione usata per ogni allarme aperto: il rientro torna dove è stato aperto.
  const routeMemory = Object.fromEntries(
    Object.entries(prev?.services ?? {})
      .filter(([, v]) => v?.route)
      .map(([k, v]) => [k, v.route]),
  )
  const gruppi = splitByRoute(transitions, { routeMemory, notifyCronFailed: cfg.notifyCronFailed })
  const destinazioni = [
    ['main', gruppi.main, cfg.webhook],
    // senza un webhook dedicato ai cron, «mai partito» va nel principale: meglio nel posto sbagliato
    // che in nessun posto
    ['cron', gruppi.cron, cfg.webhookCron || cfg.webhook],
  ]

  let ok = true
  for (const [nome, lista, hook] of destinazioni) {
    if (!lista.length) continue
    const payload = slackMessage(lista, { url: cfg.publicUrl, t })
    const inviato = hook ? await send(hook, payload) : true
    ok = ok && inviato
    log.info('watch: transizioni', {
      dove: nome,
      n: lista.length,
      inviato: Boolean(hook) && inviato,
      servizi: lista.map((x) => `${x.key}:${x.from}→${x.to}`),
    })
    // Ricorda DOVE è stato aperto ogni allarme (per mandarci il rientro) e CHE è stato aperto: senza il
    // secondo, il rientro di un allarme mai annunciato diventa un verde orfano (vedi `rientroOrfano`).
    // Si scrive qui e non nel differ perché è l'invio riuscito a rendere l'allarme "annunciato".
    // Solo il RIENTRO chiude l'allarme. Un alleggerimento (down → degraded) è ancora rosso: se
    // azzerasse il flag, il verde vero che arriva dopo verrebbe scartato come orfano e resteremmo
    // con un allarme aperto che nessuno chiude mai.
    for (const tr of lista) {
      if (!next.services[tr.key]) continue
      if (tr.kind === 'recovery') {
        delete next.services[tr.key].route
        next.services[tr.key].alerted = false
      } else {
        next.services[tr.key].route = nome
        next.services[tr.key].alerted = true
      }
    }
  }
  if (gruppi.skipped.length) {
    log.info('watch: transizioni taciute (le scrive già il servizio stesso)', {
      servizi: gruppi.skipped.map((x) => `${x.key}:${x.outcome}`),
    })
  }
  // Se un invio FALLISCE non si salva lo stato nuovo: al giro dopo la transizione viene riprovata,
  // invece di essere persa per sempre perché Slack era irraggiungibile per dieci secondi.
  // Gli accessi girano SEMPRE, anche quando l'invio dei servizi e' fallito: sono un canale diverso e
  // una notizia diversa, e legarli vorrebbe dire perdere la seconda per colpa del primo.
  let accessi = { spento: true }
  try {
    accessi = await giroAccessi(cfg, deps, prev)
    if (accessi.stato) next.accessi = accessi.stato
  } catch (err) {
    log.error('watch: giro accessi fallito', { err: err.message })
  }
  if (!ok) return { transitions, sent: false, groups: gruppi, accessi }
  await writeState(cfg.stateFile, next)
  return { transitions, sent: true, groups: gruppi, accessi }
}

// ── Il giro degli ACCESSI ──────────────────────────────────────────────────────────────────────────
//
// Tre regole che nessun altro puo' dire (vedi server/accessi.js), con una destinazione loro e uno stato
// suo dentro lo stesso file. Sta a parte dal giro dei servizi per una ragione precisa: quelle sono
// TRANSIZIONI di stato (su → giu → su), queste sono EVENTI (una scrittura e' avvenuta, e non «rientra»).
// Passarle dal differ dei servizi vorrebbe dire inventargli un rientro che non esiste.
//
// ⚠️ Senza `teleport.slackWebhook` in config non fa NIENTE, e soprattutto non chiama AWS: chi non ha
// configurato la destinazione non paga due letture di CloudWatch ogni cinque minuti.
export async function giroAccessi(cfg, deps = {}, prev = null) {
  const leggiConfig = deps.loadConfig ?? loadConfig
  const stato = deps.statoAccessi ?? statoAccessi
  const send = deps.postSlack ?? postSlack
  const hook = leggiConfig().teleport?.slackWebhook ?? null
  if (!hook) return { spento: true, nuovi: [], sent: null }

  const dati = await stato({ ore: 24 })
  const ora = segnali(dati)
  const { nuovi, stato: statoNuovo } = daAnnunciare(ora, prev?.accessi ?? null)
  if (!nuovi.length) return { spento: false, nuovi: [], sent: null, stato: statoNuovo }

  const testo = nuovi.map((s) => messaggioAccessi(s, { publicUrl: cfg.publicUrl })).join('\n')
  const inviato = await send(hook, { text: testo })
  log.info('watch: accessi', { n: nuovi.length, inviato, segnali: nuovi.map((s) => s.chiave) })
  // Se l'invio fallisce lo stato NON avanza: al giro dopo si riprova, come per i servizi.
  return { spento: false, nuovi, sent: inviato, stato: inviato ? statoNuovo : null }
}

export function startWatcher(env = process.env) {
  const cfg = watchConfig(env)
  if (!cfg.webhook) {
    log.info('watch: nessun DADAGUARD_SLACK_WEBHOOK, notifiche disattivate')
    return null
  }
  log.info('watch: attivo', { ogni: `${cfg.intervalMs / 1000}s`, conferme: cfg.confirmations, stato: cfg.stateFile })
  const tick = () =>
    runOnce(cfg).catch((err) => log.error('watch: giro fallito', { err: err.message }))
  tick() // primo giro subito: prende nota dello stato attuale senza annunciare
  const timer = setInterval(tick, cfg.intervalMs)
  timer.unref?.()
  return timer
}
