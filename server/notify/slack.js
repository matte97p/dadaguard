import { log } from '../log.js'

// Il messaggio Slack di una transizione. La composizione è PURA (testabile senza rete); l'invio è
// una fetch sola, senza SDK.
//
// Cosa deve dire un messaggio di allarme perché serva a qualcosa, in quest'ordine: COSA è cambiato,
// DOVE, PERCHÉ (il segnale colpevole col suo testo), e da dove si continua a indagare. Niente
// altro: un messaggio che riporta l'intero stato del mondo non si legge.
//
// La FORMA non è una scelta libera: è quella che il team legge già in #aws-deploy (notifiche di
// deploy) e in #aws-cron-test (esiti dei cron). Un terzo dialetto costringerebbe a imparare due
// grammatiche per la stessa cosa, e la seconda si legge peggio della prima:
//
//   :red_circle: `nome` [PROD] GIÙ · esecuzione — dettaglio · <url|stato su Dadaguard>
//   └ shortcode   └ backtick └ maiuscolo └ a parole  └ "—" apre  └ "·" separa
//
// Differenze rispetto a prima, tutte per allineamento: emoji come shortcode Slack (non unicode),
// nome del servizio in backtick (non grassetto), ambiente in MAIUSCOLO tra parentesi quadre (non
// minuscolo tra tonde), esito a parole (non `→ *STATO*`), dettaglio sulla stessa riga dopo "—" (non
// una citazione a capo).
const EMOJI = {
  down: ':red_circle:',
  degraded: ':warning:',
  recovery: ':white_check_mark:',
  // Alleggerimento dentro al rosso (down → degraded): non è un verde, ma nemmeno un allarme nuovo.
  // Un pallino giallo lo distingue a colpo d'occhio da entrambi nello scroll del canale.
  improvement: ':large_yellow_circle:',
}

// Ambiente come lo scrivono i cron e i deploy: `[PROD]`, `[STAGING]`. Gli altri account prendono la
// propria chiave in maiuscolo (`[SECURITY]`), che è più utile di un'etichetta lunga. Puro/testabile.
export function envTag(account) {
  const a = String(account ?? '').trim()
  if (!a) return ''
  if (/^prod/i.test(a)) return ' [PROD]'
  if (/^stag|^stg/i.test(a)) return ' [STAGING]'
  return ` [${a.toUpperCase()}]`
}

// `<!channel>` solo per un guasto in PRODUZIONE, come nei cron: se suona sempre, non suona più.
function mention(t) {
  return t.kind === 'alert' && /^prod/i.test(t.account ?? '') ? '<!channel> ' : ''
}

export function slackMessage(transitions, { url = null, t = (k) => k } = {}) {
  const lines = transitions.map((tr) => {
    const emoji = EMOJI[tr.kind] ?? EMOJI[tr.to] ?? EMOJI.down
    // Un alleggerimento arriva sullo stesso stato di un allarme (`degraded`): senza un'etichetta sua
    // si leggerebbe come un secondo rosso, cioè il contrario di quello che è successo.
    const stato = tr.kind === 'improvement' ? t('notify.status.improving') : t(`notify.status.${tr.to}`)
    const causa = tr.kind === 'alert' && tr.cause ? ` · ${t(`notify.cause.${tr.cause}`)}` : ''
    const dettaglio = tr.detail ? ` — ${tr.detail}` : ''
    return `${mention(tr)}${emoji} \`${tr.name}\`${envTag(tr.account)} ${stato}${causa}${dettaglio}`
  })
  // Il link chiude l'ultima riga con lo stesso "·" e la stessa etichetta dei messaggi di deploy, che
  // già rimandano qui: chi li legge riconosce la porta.
  const link = url ? ` · <${url}|${t('notify.open')}>` : ''
  return { text: lines.join('\n') + link }
}

// Invio: una POST al webhook. Errori loggati e ingoiati — un guasto di Slack non deve far cadere il
// watchdog (e la prossima transizione riproverà). Timeout corto: qui non si aspetta nessuno.
export async function postSlack(webhook, payload, { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      log.error('slack: invio fallito', { status: res.status, body: (await res.text().catch(() => '')).slice(0, 200) })
      return false
    }
    return true
  } catch (err) {
    log.error('slack: invio fallito', { err: err.message })
    return false
  } finally {
    clearTimeout(timer)
  }
}
