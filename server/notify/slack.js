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
//
// E nemmeno per un allarme PROVVISORIO, cioè visto dalla sola finestra corta: il messaggio stesso dice
// «non è ancora una finestra da 60m», quindi strappare tutti dal lavoro contraddice la frase che porta.
// Non si perde niente: se è un guasto vero la finestra lunga lo conferma al giro dopo, e la salita
// `degraded → down` è già un `alert` con la sirena (regola 5 in diff.js). Il caso che questo toglie è
// l'altro, quello che si richiude da solo: tre 503 in un quarto d'ora scarico, che sull'ora non sono
// niente. Il messaggio arriva lo stesso, con il suo pallino giallo: non chiama, si legge.
function mention(t) {
  return t.kind === 'alert' && !t.provisional && /^prod/i.test(t.account ?? '') ? '<!channel> ' : ''
}

// La causa: quale SEGNALE ha fatto scattare l'allarme, detto come lo direbbe un umano. `runtime` è il
// nome del modulo che fa il controllo, non del problema: lo stesso check copre ventidue tipi di
// risorsa, quindi "esecuzione" su un load balancer o su un certificato non dice niente. Il tipo
// viaggia già nella transizione, e per le Lambda a schedule lo dice `outcome` (che esiste solo sui
// cron). Tipo ignoto o non mappato → si resta su "esecuzione", che è sempre meglio di `runtime`.
export function causeLabel(tr, t) {
  if (!tr.cause) return ''
  // `causeType` batte il tipo della risorsa: un servizio ECS con 2/2 container su e un target fuori è
  // degradato DAI TARGET, e intestare la riga «task» punterebbe al segnale che sta bene.
  const tipo = tr.causeType ?? tr.type
  if (tr.cause === 'runtime' && tipo) {
    const suffisso = tipo === 'lambda' && tr.outcome ? 'lambda.cron' : tipo
    const k = `notify.cause.type.${suffisso}`
    const parola = t(k)
    if (parola !== k) return parola
  }
  return t(`notify.cause.${tr.cause}`)
}

// Quanto può essere lungo il dettaglio in chat. Sommati, i dettagli "spiegati" (soglia + finestra +
// quale target) allungano la riga: oltre questa soglia su mobile va a capo tre volte e non si legge
// più nessuna delle righe accanto. Chi vuole tutto apre Dadaguard, il link è in fondo al messaggio.
const MAX_DETAIL = 160
// Quanto si tiene almeno della TESTA quando si taglia — il resto va alla coda. La coda è l'ultimo pezzo
// separato da "·", cioè proprio quello aggiunto di proposito: la soglia, la conseguenza, «scatta a…».
// Tagliare in fondo — la cosa ovvia da fare — butta via l'unica frase che dice se il numero davanti è
// un problema e tiene i numeri, che da soli non decidono niente. Quindi si taglia in MEZZO, e la testa
// serve solo a dire di chi si sta parlando.
const MIN_TESTA = 40

// Il dettaglio arriva da un summary pensato per la card: può avere il `⚠` davanti (che qui è la terza
// icona dopo il pallino di stato) e andare a capo. Si normalizza qui, una volta, invece di ricordarsi
// di non metterlo in venti provider.
export function cleanDetail(s) {
  if (!s) return ''
  const one = String(s)
    .replace(/^[\s⚠️!]+/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (one.length <= MAX_DETAIL) return one
  // La coda parte dal confine "·" più vicino alla fine, se l'ultimo pezzo ci sta lasciando spazio alla
  // testa; sennò dagli ultimi caratteri disponibili — meglio una frase che comincia a metà che una che
  // non c'è.
  const maxCoda = MAX_DETAIL - MIN_TESTA
  const taglio = one.lastIndexOf(' · ')
  const coda = taglio > 0 && one.length - taglio <= maxCoda ? one.slice(taglio) : one.slice(-maxCoda)
  const testa = one.slice(0, Math.max(1, MAX_DETAIL - coda.length - 1)).trimEnd()
  return `${testa}…${coda}`
}

export function slackMessage(transitions, { url = null, t = (k) => k } = {}) {
  const lines = transitions.map((tr) => {
    const emoji = EMOJI[tr.kind] ?? EMOJI[tr.to] ?? EMOJI.down
    // Un alleggerimento arriva sullo stesso stato di un allarme (`degraded`): senza un'etichetta sua
    // si leggerebbe come un secondo rosso, cioè il contrario di quello che è successo.
    const stato = tr.kind === 'improvement' ? t('notify.status.improving') : t(`notify.status.${tr.to}`)
    const parola = tr.kind === 'alert' ? causeLabel(tr, t) : ''
    const causa = parola ? ` · ${parola}` : ''
    const pulito = cleanDetail(tr.detail)
    const dettaglio = pulito ? ` — ${pulito}` : ''
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

// ── I messaggi degli ACCESSI ────────────────────────────────────────────────────────────────────────
//
// Stessa grammatica di sopra, che e' quella che il canale legge gia' dai cron:
//   :emoji: `bersaglio` [ENV] COSA — dettaglio · <url|Accessi>
//
// ⚠️ Nessun `<!channel>`, nemmeno sulla sessione SSH. La destinazione di queste tre regole e' un canale
// dove per ora legge una persona sola: strappare tutti dal lavoro per una cosa che non e' un guasto del
// prodotto e' il modo di far silenziare il canale prima che serva davvero.
const EMOJI_ACCESSI = { allarme: ':red_circle:', attenzione: ':warning:' }

const elenco = (nomi = []) => (nomi.length ? nomi.join(', ') : 'qualcuno che non so nominare')

export function messaggioAccessi(segnale, { publicUrl = null } = {}) {
  const emoji = EMOJI_ACCESSI[segnale.livello] ?? ':warning:'
  const coda = publicUrl ? ` · <${publicUrl}/accessi?vista=${vistaDi(segnale)}|Accessi>` : ''
  const testa = `${emoji} \`${segnale.bersaglio}\``

  if (segnale.tipo === 'scrittura') {
    const quante = segnale.quante === 1 ? '1 statement' : `${segnale.quante} statement`
    return `${testa}${envTag(segnale.ambiente)} SCRITTURE — ${quante} di scrittura da ${elenco(segnale.chi)}${coda}`
  }
  if (segnale.tipo === 'ssh') {
    const di = segnale.diChi?.length ? `una macchina di ${elenco(segnale.diChi)}` : 'una macchina che non ha mai mandato un avvio'
    return `${testa} SESSIONE SSH APERTA — ${elenco(segnale.chi)} su ${di}${coda}`
  }
  if (segnale.tipo === 'versione') {
    const q = segnale.quante === 1 ? "l'unica macchina" : `nessuna delle ${segnale.quante} macchine`
    return `${testa} VERSIONE ATTESA — non ce l'ha ${q}${coda}`
  }
  return `${testa} — ${segnale.tipo}${coda}`
}

// La tabella dove si continua a guardare: il link porta dove sta la riga, non sulla pagina generica.
function vistaDi(segnale) {
  if (segnale.tipo === 'scrittura') return 'database'
  if (segnale.tipo === 'ssh') return 'ssh'
  return 'devEnv'
}
