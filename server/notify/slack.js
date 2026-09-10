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

// NESSUNA menzione: il canale non si tagga, in nessun ambiente e per nessuna gravità (09/09/2026).
// Prima un guasto in produzione portava `<!channel>`, «come nei cron». Il ragionamento si morde la
// coda: se il canale fa così tanto rumore che un rosso ci si perde, la risposta è meno rumore, non
// una sveglia per tutti, e una sveglia che suona spesso è una sveglia che si smette di guardare.
// Un guasto si vede dove lo si vede scorrendo, cioè dal pallino in testa alla riga, e chi vuole
// essere svegliato imposta le notifiche su questo canale nel PROPRIO Slack: così la sceglie chi la
// riceve, invece di subirla per conto di altri otto.
//
// La funzione resta, e resta il posto dove si rimetterebbe una menzione MIRATA (una persona, non il
// canale) il giorno in cui esistesse una reperibilità con un nome sopra.
function mention() {
  return ''
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
    // Lo sforamento visto dalla sola finestra corta si DICE, invece di cambiare come suona la riga.
    // Prima quel flag serviva a non mettere il `<!channel>`, e tolto il tag sarebbe rimasto un dato
    // calcolato, propagato e provato che nessuno legge. Da qui in poi è una nota in coda, che è il
    // posto dello standard per la frase che dice cosa non sappiamo ancora.
    const forse = tr.provisional ? ` · ${t('notify.provisional')}` : ''
    return `${mention()}${emoji} \`${tr.name}\`${envTag(tr.account)} ${stato}${causa}${dettaglio}${forse}`
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

// COSA e' stato scritto, in una manciata di caratteri. Una sola azione si dice per nome (`3 UPDATE`),
// tante si dicono con le due che contano e quante restano: il messaggio deve stare su una riga, e
// l'elenco intero sta nella pagina, che e' linkata in coda.
//
// ⚠️ Sotto un titolo rosso le azioni sui DATI vengono per prime, anche se sono le meno numerose. Il
// 09/09/2026 il canale ha scritto «SCRITTURE (9 CREATE FUNCTION, 7 GRANT, +9) su utenti»: il rosso era
// acceso da un `UPDATE` su una tabella di clienti, e le due azioni mostrate erano le due piu' numerose,
// cioe' due DDL. La riga diceva il colore giusto e il motivo sbagliato, che e' il modo piu' veloce per
// insegnare a non fidarsi del colore.
function sommarioAzioni(azioni = [], natura) {
  const righe = azioni.filter((a) => a?.etichetta)
  const insieme = natura === 'struttura' ? 'DDL' : 'scritture'
  if (!righe.length) return natura === 'struttura' ? 'DDL' : 'statement di scrittura'
  const ordinate =
    natura === 'struttura'
      ? righe
      : [...righe].sort((a, b) => (a.tipo === b.tipo ? 0 : a.tipo === 'dati' ? -1 : 1))
  if (ordinate.length === 1) return ordinate[0].etichetta
  const testa = ordinate.slice(0, 2).map((a) => `${a.quante} ${a.etichetta}`)
  const resto = ordinate.length - 2
  return `${insieme} (${testa.join(', ')}${resto > 0 ? `, +${resto}` : ''})`
}

// Su COSA. Solo per le scritture sui dati: le tabelle le sa `azione()` da un `insert into X`, mentre
// un `ALTER INDEX` non nomina la tabella e qui non si indovina.
function sommarioTabelle(tabelle = []) {
  if (!tabelle.length) return ''
  const resto = tabelle.length - 2
  return ` su ${tabelle.slice(0, 2).join(', ')}${resto > 0 ? ` e altre ${resto}` : ''}`
}

// L'utente di database di una persona, quando il login e' il suo nome: `dev_<utente github>` sui
// database dove i login sono per persona. Il confronto e' senza maiuscole perche' GitHub le tiene e
// Postgres no.
const suoLogin = (utenteDb, chi = []) => {
  const u = String(utenteDb ?? '').toLowerCase()
  return chi.some((c) => `dev_${String(c).toLowerCase()}` === u)
}

// CON CHE COSA hanno scritto, tolto quello che il messaggio ha gia' detto. Tre cose, in quest'ordine
// di importanza per chi legge:
//   · l'endpoint (`writer`, `reader`), che e' la prima domanda vera e si dice UNA volta anche se le
//     persone sono sei;
//   · i login che NON sono il nome di chi ha scritto (`dev_readonly`, `dev_readwrite` condivisi), che
//     sono l'informazione che il nome della persona non porta;
//   · niente, quando non c'e' nessuna delle due.
// Quello che spariva sotto la ripetizione: «da tizio, caio, sempronio (dev_caio su endpoint ignoto,
// dev_tizio su endpoint ignoto, dev_readonly su endpoint ignoto)» dice tre volte «endpoint ignoto»,
// due volte gli stessi nomi, e nasconde in fondo l'unica riga che vale: qualcuno ha scritto passando
// da `dev_readonly`.
function sommarioLogin(utentiDb = [], chi = []) {
  // La forma vecchia era una frase gia' scritta (`"tizio su writer"`): si legge ancora, perche' uno
  // stato o un payload di ieri non deve far sparire la riga.
  const voci = utentiDb.map((u) => (typeof u === 'string' ? { utente: u, endpoint: null } : u)).filter((u) => u?.utente)
  if (!voci.length) return ''
  const endpoint = [...new Set(voci.map((u) => u.endpoint).filter(Boolean))]
  const estranei = [...new Set(voci.filter((u) => !suoLogin(u.utente, chi)).map((u) => u.utente))]
  const pezzi = []
  if (estranei.length) pezzi.push(estranei.join(', '))
  if (endpoint.length) pezzi.push(`su ${endpoint.join(', ')}`)
  if (!pezzi.length) return ''
  return ` (${pezzi.join(' ')})`
}

// Le scritture MANDATE e non arrivate. Non e' un dettaglio da nascondere: e' la riga che spiega un
// login che non torna. Senza, il canale scriveva `dev_readonly` fra chi scrive in produzione e chi lo
// leggeva andava a cercare un permesso rotto, mentre erano statement che il database ha rifiutato.
//
// ⚠️ Sono un'aggiunta a una riga che esiste gia', mai una riga da sole: una scrittura che non e'
// avvenuta non merita un messaggio, e un allarme su niente insegna a ignorare gli allarmi.
function sommarioTentate(segnale) {
  const n = segnale.tentate ?? 0
  if (n <= 0) return ''
  const perche = (segnale.motiviTentate ?? [])[0]
  return ` · ${n} rifiutate${perche ? ` (${perche})` : ''}`
}

export function messaggioAccessi(segnale, { publicUrl = null } = {}) {
  const emoji = EMOJI_ACCESSI[segnale.livello] ?? ':warning:'
  const coda = publicUrl ? ` · <${publicUrl}/accessi?vista=${vistaDi(segnale)}|Accessi>` : ''
  const testa = `${emoji} \`${segnale.bersaglio}\``

  if (segnale.tipo === 'scrittura') {
    // `nuove` sono quelle arrivate dall'ultimo messaggio, e il `+` lo dice: senza, un secondo messaggio
    // con un numero piu' piccolo del primo sembra un conteggio sbagliato invece di un delta.
    const quante = segnale.nuove ?? segnale.quante ?? 0
    const titolo = segnale.natura === 'struttura' ? 'STRUTTURA' : 'SCRITTURE'
    const cosa = sommarioAzioni(segnale.azioni, segnale.natura)
    // Le tabelle solo sotto al rosso: sono i bersagli delle scritture sui DATI, e accanto a un elenco
    // di DDL si leggerebbero come la tabella che le DDL hanno toccato, che non e' quello che dicono.
    const dove = segnale.natura === 'struttura' ? '' : sommarioTabelle(segnale.tabelle)
    const come = sommarioLogin(segnale.utentiDb, segnale.chi)
    const respinte = sommarioTentate(segnale)
    return `${testa}${envTag(segnale.ambiente)} ${titolo} — +${quante} ${cosa}${dove} da ${elenco(segnale.chi)}${come}${respinte}${coda}`
  }
  if (segnale.tipo === 'ssh') {
    const di = segnale.diChi?.length ? `una macchina di ${elenco(segnale.diChi)}` : 'una macchina che non ha mai mandato un avvio'
    return `${testa} SESSIONE SSH APERTA — ${elenco(segnale.chi)} su ${di}${coda}`
  }
  if (segnale.tipo === 'versione') {
    const q = segnale.quante === 1 ? "l'unica macchina" : `nessuna delle ${segnale.quante} macchine`
    return `${testa} VERSIONE ATTESA — non ce l'ha ${q}${coda}`
  }
  if (segnale.tipo === 'guasto') {
    // La CLASSE per prima: e' il nome con cui quel guasto tornera' domani, e quello che si cerca in
    // chat fra un mese. La riga d'errore in coda arriva gia' ripulita dal dev-env, e serve a capire in
    // un secondo se e' roba nostra o del Mac di quella persona.
    const dove = segnale.passo ? ` nel passo \`${segnale.passo}\`` : ''
    const chi = segnale.chi?.length ? ` da ${elenco(segnale.chi)}` : ''
    const riga = segnale.dettaglio ? ` · \`${segnale.dettaglio}\`` : ''
    return `${testa} GUASTO MAI VISTO — \`${segnale.classe}\`${dove}${chi}${riga}${coda}`
  }
  if (segnale.tipo === 'dev-fermo') {
    // ⚠️ Due avvii falliti di fila, non uno: qui si sta dicendo che una persona non sta lavorando, e
    // se lo si dicesse al primo inciampo (una porta occupata che si libera da sola) il messaggio dopo
    // non lo leggerebbe piu' nessuno.
    const perche = segnale.classe ? ` — \`${segnale.classe}\`` : ''
    const chi = segnale.chi?.length ? ` (${elenco(segnale.chi)})` : ''
    return `${testa} IL DEV-ENV NON PARTE${chi}${perche} · due avvii di fila${coda}`
  }
  return `${testa} — ${segnale.tipo}${coda}`
}

// La tabella dove si continua a guardare: il link porta dove sta la riga, non sulla pagina generica.
function vistaDi(segnale) {
  if (segnale.tipo === 'scrittura') return 'database'
  if (segnale.tipo === 'ssh') return 'ssh'
  return 'devEnv'
}
