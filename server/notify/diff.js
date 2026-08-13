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
//  4. Dentro al rosso ci sono due gravità, e il salto fra le due È una notizia (regola 5, sotto).

// Classi di stato: il confine che conta è problema / non-problema. `unknown` è a parte — non sappiamo,
// e "non sappiamo" non è una notizia da mandare a nessuno (ma non cancella nemmeno un rosso noto).
export function stateClass(overall) {
  if (overall === 'down' || overall === 'degraded') return 'problem'
  if (overall === 'unknown' || overall == null) return 'unknown'
  return 'quiet' // up, idle, disabled
}

// Regola 5: dentro la classe "problema" ci sono DUE gravità, e passare dall'una all'altra è una
// notizia quanto entrarci. `degraded` = da guardare, `down` = conclamato.
//  · peggiora (degraded → down) = un allarme vero, con la stessa sirena di un rosso nuovo;
//  · migliora (down → degraded) = «sembra rientrato, non è confermato»: si annuncia, ma SENZA sirena
//    (in slack.js il `<!channel>` è legato a kind === 'alert'). È il segnale intermedio che mancava:
//    prima o eri rosso o eri verde, e un rientro parziale non aveva modo di dirsi.
// Il verde definitivo resta l'unica cosa che chiude l'allarme: qui non si esce mai dal rosso.
const GRAVITA = { degraded: 1, down: 2 }

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
      // `alert` prima di `summary`: la card e la chat non vogliono la stessa frase. Il summary è
      // scritto per stare accanto alle metriche e al pannello dei task ("6/7 target sani", "no ·
      // memoria 512MB"); in chat non c'è niente accanto, quindi serve il soggetto, la conseguenza e
      // la soglia. I provider che hanno qualcosa in più da dire mettono `alert`, gli altri no.
      detail: s.checks?.[s.cause]?.alert ?? s.checks?.[s.cause]?.summary ?? s.checks?.[s.cause]?.reason ?? null,
      // Quale SEGNALE ha degradato il servizio, quando non è quello del suo tipo: un servizio ECS può
      // essere rosso per i target dietro al load balancer, non per i container.
      causeType: s.checks?.[s.cause]?.causeType ?? null,
      account: s.account?.label ?? null,
      name: s.name,
      type: s.type ?? null,
      // esito strutturato del dead-man: 'missed' (mai partita) | 'failed' (partita e caduta) | 'ok'
      outcome: s.checks?.runtime?.outcome ?? null,
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
      // `alerted: false` è esplicito di proposito: è la memoria di "per questa chiave non abbiamo mai
      // annunciato niente", e serve a non mandare un rientro per un allarme che nessuno ha visto.
      next[key] = { confirmed: obs.overall, cause: obs.cause, since: obs.at ?? null, pending: null, alerted: false }
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
    // `route` (dove è stato aperto l'allarme) si conserva: serve a mandare il rientro nello stesso posto
    // `alerted` va conservato come `route`: un cambio di gravità dentro la stessa classe non chiude
    // l'allarme, e se perdessimo il flag il rientro vero verrebbe poi soppresso come orfano.
    next[key] = {
      confirmed: obs.overall,
      cause: obs.cause,
      pending: null,
      ...(before.route ? { route: before.route } : {}),
      ...(before.alerted ? { alerted: true } : {}),
    }
    const from = stateClass(confirmed)
    const to = stateClass(obs.overall)
    const attraversa = from !== to && from !== 'unknown' && to !== 'unknown'
    // Regola 4: un rientro si annuncia SOLO se l'allarme è stato davvero mandato. Una chiave mai
    // annunciata (servizio nuovo nato già rotto, vedi sopra, o allarme taciuto dal routing) altrimenti
    // produce un verde "tornato OK" che non corrisponde a nessun rosso — e il lettore va a cercare un
    // allarme che non c'è mai stato. Visto dal vivo sui modelli Bedrock, che sono autoscoperti e
    // compaiono nella watchlist appena qualcuno li chiama.
    const rientroOrfano = to !== 'problem' && !before.alerted
    // Cambio di gravità restando nel rosso (regola 5). Il miglioramento segue la stessa regola del
    // rientro: se l'allarme non è mai stato mandato, non si annuncia nemmeno il suo alleggerimento.
    const dentro = from === 'problem' && to === 'problem' && GRAVITA[obs.overall] !== GRAVITA[confirmed]
    const peggiora = dentro && GRAVITA[obs.overall] > GRAVITA[confirmed]
    const migliora = dentro && !peggiora && before.alerted
    if ((attraversa && !rientroOrfano) || peggiora || migliora) {
      transitions.push({
        kind: attraversa ? (to === 'problem' ? 'alert' : 'recovery') : peggiora ? 'alert' : 'improvement',
        key,
        name: obs.name,
        account: obs.account,
        from: confirmed,
        to: obs.overall,
        cause: obs.cause,
        detail: obs.detail,
        type: obs.type,
        causeType: obs.causeType,
        outcome: obs.outcome,
      })
    }
  }
  // I servizi spariti (rimossi dalla watchlist, o non più scoperti) escono dallo stato senza rumore:
  // "non lo vedo più" non è un guasto da annunciare.
  return { transitions: firstRun ? [] : transitions, next: { services: next } }
}
