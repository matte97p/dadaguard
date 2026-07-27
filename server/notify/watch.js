import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getStatus } from '../status.js'
import { makeT } from '../i18n.js'
import { log } from '../log.js'
import { diffStates, snapshot } from './diff.js'
import { slackMessage, postSlack } from './slack.js'

// Il watchdog vero e proprio: guarda la flotta a intervalli, e quando qualcosa ATTRAVERSA il confine
// problema/non-problema lo dice su Slack. Finché questo non esisteva, Dadaguard era una dashboard —
// una cosa che devi ricordarti di aprire: il cron di produzione fallito all'01:01 l'abbiamo scoperto
// alle 14:30 guardando una card.
//
// Gira nel SERVER, non nel browser: il polling della dashboard esiste solo mentre qualcuno la tiene
// aperta, e alle 4 del mattino non c'è nessuno.
//
// Configurazione (tutta opzionale: senza webhook il watcher non parte e non chiama AWS):
//   DADAGUARD_SLACK_WEBHOOK   URL del webhook (in cloud/ECS arriva da SSM come gli altri segreti)
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
  const send = deps.postSlack ?? postSlack
  const readState = deps.loadState ?? loadState
  const writeState = deps.saveState ?? saveState
  const t = makeT(cfg.lang)

  const status = await fetchStatus(cfg.lang)
  const prev = await readState(cfg.stateFile)
  const { transitions, next } = diffStates(prev, snapshot(status.services ?? []), {
    confirmations: cfg.confirmations,
  })
  if (transitions.length) {
    const payload = slackMessage(transitions, { url: cfg.publicUrl, t })
    const ok = cfg.webhook ? await send(cfg.webhook, payload) : true
    log.info('watch: transizioni', {
      n: transitions.length,
      inviato: Boolean(cfg.webhook) && ok,
      servizi: transitions.map((x) => `${x.key}:${x.from}→${x.to}`),
    })
    // Se l'invio FALLISCE non si salva lo stato nuovo: al giro dopo la transizione viene riprovata,
    // invece di essere persa per sempre perché Slack era irraggiungibile per dieci secondi.
    if (!ok) return { transitions, sent: false }
  }
  await writeState(cfg.stateFile, next)
  return { transitions, sent: true }
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
