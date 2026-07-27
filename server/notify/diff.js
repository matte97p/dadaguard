// Cosa è CAMBIATO da un giro all'altro. È la parte che fa la differenza tra una dashboard (che devi
// ricordarti di guardare) e un watchdog (che ti chiama), e sta qui da sola perché è l'unico pezzo
// dove i bug si nascondono: tutto puro, tutto testabile, zero rete.
//
// Tre regole, imparate dalle cose che rendono insopportabile una notifica:
//  1. NON tutto è un evento. `up → idle` (un modello Bedrock che nessuno chiama per un'ora) non è un
//     guasto; `→ unknown` di solito è un permesso o un throttle, cioè un problema del controllo, non
//     del servizio. Si notifica solo l'attraversamento del confine problema/non-problema.
//  2. Una transizione conta solo se REGGE (debounce): un throttle CloudWatch di trenta secondi non
//     deve svegliare nessuno. Serve che lo stato nuovo si presenti N letture di fila.
//  3. Un messaggio per TRANSIZIONE, non per stato: se resta rosso tre giorni, resta un messaggio.

// Classi di stato: il confine che conta è problema / non-problema. `unknown` è a parte — non sappiamo,
// e "non sappiamo" non è una notizia da mandare a nessuno (ma non cancella nemmeno un rosso noto).
export function stateClass(overall) {
  if (overall === 'down' || overall === 'degraded') return 'problem'
  if (overall === 'unknown' || overall == null) return 'unknown'
  return 'quiet' // up, idle, disabled
}

export const serviceKey = (s) => `${s.account?.key ?? '—'}/${s.name}`

// Fotografia da salvare: per ogni servizio lo stato osservato ora + il candidato in attesa di conferma.
// `confirmed` è l'ultimo stato ANNUNCIATO (o osservato al primo giro): il confronto si fa su quello,
// altrimenti un rosso che sfarfalla genererebbe una notifica a ogni oscillazione.
export function snapshot(services = []) {
  const out = {}
  for (const s of services) {
    out[serviceKey(s)] = {
      overall: s.overall ?? 'unknown',
      cause: s.cause ?? null,
      detail: s.checks?.[s.cause]?.summary ?? s.checks?.[s.cause]?.reason ?? null,
      account: s.account?.label ?? null,
      name: s.name,
    }
  }
  return out
}

// prev: { [key]: { confirmed, pending: {overall, count} , ...meta } } — lo stato su disco
// now:  snapshot() del giro corrente
// Ritorna { transitions, next }: cosa annunciare e lo stato da salvare.
export function diffStates(prev, now, { confirmations = 2 } = {}) {
  const prevMap = prev?.services ?? {}
  const firstRun = !prev || Object.keys(prevMap).length === 0
  const transitions = []
  const next = {}

  for (const [key, obs] of Object.entries(now)) {
    const before = prevMap[key]
    // Servizio nuovo (o primo giro in assoluto): si prende nota, non si annuncia. Dopo un riavvio
    // il notificatore non deve rovesciare in chat lo stato del mondo — solo i cambi che vede lui.
    if (!before) {
      next[key] = { confirmed: obs.overall, cause: obs.cause, since: obs.at ?? null, pending: null }
      continue
    }
    const confirmed = before.confirmed ?? 'unknown'
    if (obs.overall === confirmed) {
      next[key] = { ...before, confirmed, pending: null } // tornato quello noto: candidato annullato
      continue
    }
    // stato diverso da quello confermato: conta le letture consecutive
    const count = before.pending?.overall === obs.overall ? (before.pending.count ?? 1) + 1 : 1
    if (count < confirmations) {
      next[key] = { ...before, confirmed, pending: { overall: obs.overall, count } }
      continue
    }
    // confermato: aggiorna lo stato noto e valuta se è una notizia
    next[key] = { confirmed: obs.overall, cause: obs.cause, pending: null }
    const from = stateClass(confirmed)
    const to = stateClass(obs.overall)
    if (from !== to && from !== 'unknown' && to !== 'unknown') {
      transitions.push({
        kind: to === 'problem' ? 'alert' : 'recovery',
        key,
        name: obs.name,
        account: obs.account,
        from: confirmed,
        to: obs.overall,
        cause: obs.cause,
        detail: obs.detail,
      })
    }
  }
  // I servizi spariti (rimossi dalla watchlist, o non più scoperti) escono dallo stato senza rumore:
  // "non lo vedo più" non è un guasto da annunciare.
  return { transitions: firstRun ? [] : transitions, next: { services: next } }
}
