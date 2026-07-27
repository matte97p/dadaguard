import { log } from '../log.js'

// Il messaggio Slack di una transizione. La composizione è PURA (testabile senza rete); l'invio è
// una fetch sola, senza SDK.
//
// Cosa deve dire un messaggio di allarme perché serva a qualcosa, in quest'ordine: COSA è cambiato,
// DOVE, PERCHÉ (il segnale colpevole col suo testo), e da dove si continua a indagare. Niente
// altro: un messaggio che riporta l'intero stato del mondo non si legge.
const EMOJI = { alert: '🔴', recovery: '🟢' }

// `<!channel>` solo per un guasto in PRODUZIONE, come nei cron: se suona sempre, non suona più.
function mention(t) {
  return t.kind === 'alert' && /^prod/i.test(t.account ?? '') ? '<!channel> ' : ''
}

export function slackMessage(transitions, { url = null, t = (k) => k } = {}) {
  const lines = transitions.map((tr) => {
    const emoji = EMOJI[tr.kind] ?? '•'
    const stato = t(`notify.status.${tr.to}`)
    const causa = tr.kind === 'alert' && tr.cause ? ` · ${t(`notify.cause.${tr.cause}`)}` : ''
    const dettaglio = tr.detail ? `\n> ${tr.detail}` : ''
    const dove = tr.account ? ` _(${tr.account})_` : ''
    return `${mention(tr)}${emoji} *${tr.name}*${dove} → *${stato}*${causa}${dettaglio}`
  })
  const link = url ? `\n<${url}|${t('notify.open')}>` : ''
  return { text: lines.join('\n\n') + link }
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
