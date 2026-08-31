// Le REGOLE della pagina Accessi, fuori dal componente: quali righe hanno un problema, in che ordine
// si mostrano, qual è l'immagine di riferimento e come si accorcia un digest.
//
// Stanno qui e non dentro `AccessiPage.jsx` per la stessa ragione di `deployRows.js` e `nowSignals.js`:
// una regola dentro un componente si può leggere, non si può provare. E qui le regole sono la parte
// che decide cosa una persona guarda per prima durante un guasto, cioè esattamente quello che non deve
// cambiare per sbaglio al primo ritocco della tabella. Le prove sono in `test/accessi.test.js`.
//
// Tutto puro: nessun React, nessuna fetch, nessuna data «adesso» letta da dentro.

// Una versione VERA, cioè un digest. Serve perché l'heartbeat manda anche la parola con cui dichiara
// di non sapere («sconosciuta», quando l'avvio non ha potuto leggere l'immagine), e trattarla come una
// versione ha due conseguenze, entrambe viste sui dati veri il 31/08/2026: entra nel conteggio delle
// «versioni in giro» come se fosse una versione, e fa marcare «indietro» una macchina che sta solo
// senza il dato. Il riconoscimento è sulla FORMA (`algo:esadecimale`, oppure un esadecimale lungo) e
// non sulla parola: la parola la scrive uno script che non è questo, e un giorno la cambia.
const FORMA_DIGEST = /^(?:[a-z0-9]+:)?[A-Fa-f0-9]{12,}$/
export const versioneNota = (immagine) => FORMA_DIGEST.test(String(immagine ?? '').trim())

// `sha256:45486f792f3f2a…` → `45486f792f3f`. Il prefisso è identico su ogni riga: occupa la colonna
// per niente, e sono i caratteri che servirebbero a distinguere due immagini a colpo d'occhio.
// Quello che non è un digest torna vuoto: chi chiama mostra «non dichiarata», che è l'informazione
// giusta, invece di stampare mezza parola come se fosse una versione.
export function digestCorto(immagine, quanti = 12) {
  if (!versioneNota(immagine)) return ''
  const nudo = String(immagine ?? '').replace(/^[a-z0-9]+:/i, '')
  return nudo.slice(0, quanti)
}

// L'immagine con cui si confrontano le altre, e da DOVE viene, che è la parte che cambia tutto:
//
//  · `config`: la versione attesa è scritta nella config del dev-env. Allora «indietro» è un fatto, e
//    se NESSUNA macchina ce l'ha vuol dire che sono indietro tutti, che è il caso che il ripiego qui
//    sotto non può vedere.
//  · `vista`: nessuna versione attesa, quindi si usa quella dell'avvio più recente registrato. È «la
//    più nuova che qualcuno ha visto», non «la più nuova che esiste»: se nessuno ha aggiornato, tutti
//    risultano pari. Il ripiego resta perché senza config è meglio di niente, ma la pagina deve DIRE
//    quale delle due sta usando, sennò la stessa colonna vuol dire due cose diverse.
//
// Le macchine arrivano ordinate per `quando` decrescente (lo fa il server); qui non si assume, si
// cerca il massimo, perché una funzione che dipende dall'ordine di chi la chiama si rompe in silenzio.
export function immagineRiferimento(macchine = [], attesa = null) {
  if (attesa) return { immagine: attesa, fonte: 'config' }
  let piuRecente = null
  for (const m of macchine) {
    if (!versioneNota(m?.immagine)) continue
    if (!piuRecente || (m.quando ?? 0) > (piuRecente.quando ?? 0)) piuRecente = m
  }
  return { immagine: piuRecente?.immagine ?? null, fonte: 'vista' }
}

// «Indietro» è un'accusa, e si può fare solo con la versione ATTESA in mano.
//
// ⚠️ Misurato sui dati veri il 31/08/2026, ed è la ragione di questa firma: con cinque macchine e
// cinque digest diversi, il ripiego («la più recente vista») elegge il riferimento con l'OROLOGIO, e
// il risultato era falso. Alle 12:37 una macchina aveva avviato l'immagine `36b245a8`, alle 12:42
// un'altra la `45486f79`, che era stata pubblicata PRIMA: la seconda diventava il riferimento e la
// prima veniva marcata «indietro» pur avendo l'immagine più nuova. Quattro righe su cinque accusate
// da un ordine di avvio. Quindi: `fonte: 'config'` accusa, `fonte: 'vista'` dice solo «diversa».
// Accetta anche un digest nudo (senza la fonte) per retro-compatibilità, e in quel caso NON accusa.
export function macchinaIndietro(m, riferimento) {
  const fonte = typeof riferimento === 'object' && riferimento ? riferimento.fonte : null
  if (fonte !== 'config') return false
  const atteso = riferimento.immagine
  return Boolean(atteso && versioneNota(m?.immagine) && m.immagine !== atteso)
}

// «Diversa da quella del riferimento», che è tutto quel che si può dire senza la versione attesa: si
// mostra in grigio, non in arancione, perché non è un problema di quella macchina.
export function macchinaDiversa(m, riferimento) {
  const atteso = typeof riferimento === 'object' && riferimento ? riferimento.immagine : riferimento
  return Boolean(atteso && versioneNota(m?.immagine) && m.immagine !== atteso)
}

// La macchina non ha dichiarato la versione: non è indietro, non è pari, è senza il dato.
export const senzaVersione = (m) => !versioneNota(m?.immagine)

// Un avvio con esito diverso da `ok` è una macchina che è partita male, e va detto anche se il resto
// della riga sembra sano. `null` (heartbeat vecchio, senza il campo) NON è un avvio storto: inventare
// un problema dove il dato manca è peggio che non dirlo.
export const avvioStorto = (m) => Boolean(m?.esito && m.esito !== 'ok')

// «Tutti indietro»: la versione attesa la sa la config e non ce l'ha NESSUNA macchina. Senza versione
// attesa la domanda non si può porre, e la risposta è `false` (non «sì per prudenza»: un allarme che
// non sa distinguere è un allarme che si impara a ignorare).
export function tuttiIndietro(macchine = [], riferimento) {
  if (!riferimento || riferimento.fonte !== 'config') return false
  const conImmagine = macchine.filter((m) => versioneNota(m?.immagine))
  return conImmagine.length > 0 && conImmagine.every((m) => m.immagine !== riferimento.immagine)
}

// Chi ha un problema, per ciascuna delle quattro tabelle. Sono le stesse funzioni che decidono il
// pallino sull'interruttore, l'ordine delle righe e cosa resta accendendo «solo da guardare»: se
// fossero tre copie, il pallino direbbe una cosa e il filtro un'altra.
export const problemaPersona = (p) => (p?.loginFallite ?? 0) > 0
// Le SCRITTURE su un `prod`, non le query: un database di produzione letto da sei persone è il
// mestiere, scriverci è la cosa che si guarda.
export const problemaDatabase = (d) => (d?.scritture ?? 0) > 0 && d?.ambiente === 'prod'
export const problemaMacchina = (m, riferimento) =>
  macchinaIndietro(m, riferimento) || (m?.toolMancanti ?? 0) > 0 || avvioStorto(m)
export const problemaSsh = (m) => (m?.aperte ?? 0) > 0

// Ordinamento di default: prima le righe con un problema, poi le più recenti. In un guasto si guarda
// la PRIMA riga, non la settima, e l'ordine per data da solo mette in cima chi ha appena lavorato.
const primaIProblemi = (problema) => (a, b) => Number(problema(b)) - Number(problema(a))
const perData = (campo) => (a, b) => (b[campo] ?? 0) - (a[campo] ?? 0)

export const ordinaPersone = (persone = []) =>
  [...persone].sort((a, b) => primaIProblemi(problemaPersona)(a, b) || perData('ultima')(a, b))

export const ordinaDatabase = (database = []) =>
  [...database].sort((a, b) => primaIProblemi(problemaDatabase)(a, b) || (b.query ?? 0) - (a.query ?? 0))

export const ordinaMacchine = (macchine = [], riferimento) =>
  [...macchine].sort(
    (a, b) => primaIProblemi((m) => problemaMacchina(m, riferimento))(a, b) || perData('quando')(a, b),
  )

export const ordinaSsh = (ssh = []) =>
  [...ssh].sort((a, b) => primaIProblemi(problemaSsh)(a, b) || perData('ultima')(a, b))

// Il filtro della tabella mostrata: «solo da guardare» più la ricerca. La ricerca guarda i campi che
// la vista dichiara, non tutta la riga: cercare «prod» non deve pescare un timestamp che contiene
// quelle lettere, e soprattutto non deve pescare campi che in tabella non si vedono.
export function filtraRighe(righe = [], { problema, cerca, query = '', soloProblemi = false } = {}) {
  const cercato = String(query ?? '').trim().toLowerCase()
  return righe.filter(
    (r) =>
      (!soloProblemi || !problema || problema(r)) &&
      (!cercato || !cerca || cerca(r).some((v) => String(v ?? '').toLowerCase().includes(cercato))),
  )
}

// Quante cose chiedono un intervento in TUTTA la pagina. Serve a due cose: decidere se la riga «tutto
// tranquillo» ha il diritto di esserci, e non farla comparire quando un dato manca (un errore di
// lettura non è «tutto bene»).
export function daGuardare(audit = {}, heartbeat = {}, riferimento = null) {
  const versioni = heartbeat.versioni?.length ?? 0
  return (
    (audit.loginFallite ?? 0) +
    (audit.sshAperte ?? 0) +
    (heartbeat.conToolMancanti ?? 0) +
    (versioni > 1 ? 1 : 0) +
    (tuttiIndietro(heartbeat.macchine ?? [], riferimento) ? 1 : 0)
  )
}

// Quanto è durata la raffica di login fallite di una persona: `null` quando non ce n'è o quando il
// server non manda i due istanti (heartbeat di una versione precedente).
//
// ⚠️ È la differenza fra «una persona ha sbagliato password» e «da nove minuti nessuno entra»: tre
// fallite in due minuti e tre in ventiquattro ore sono due guasti diversi, e il conteggio da solo le
// racconta identiche. Con una sola fallita la durata non esiste (non è zero: non c'è).
export function durataFallite(p) {
  if (!p?.primaFallita || !p?.ultimaFallita) return null
  if ((p.loginFallite ?? 0) < 2) return null
  const d = p.ultimaFallita - p.primaFallita
  return d > 0 ? d : null
}

// Il link «vai a vedere in Teleport» per una riga. Il MODELLO arriva dalla config, come `sshCommand`:
// qui non sta l'URL di nessuno, e senza modello il link non c'è (invece di portare a una pagina che
// su questa installazione non esiste). Il valore si scappa, perché finisce in una query string.
export function linkAudit(modello, segnaposto, valore) {
  if (!modello || !valore) return null
  const chiave = `{${segnaposto}}`
  if (!modello.includes(chiave)) return null
  return modello.replaceAll(chiave, encodeURIComponent(valore))
}

// Il nome da mostrare per una macchina, e gli altri con cui la stessa persona e' comparsa.
//
// L'heartbeat manda l'utente Teleport quando c'e' una sessione e quello di SISTEMA quando non c'e',
// quindi la stessa persona compare con due nomi e quale dei due finisce in tabella dipende da com'e'
// andato l'ultimo avvio (visto sui dati veri il 31/08/2026 su due macchine su cinque: l'utente del
// cluster e quello del portatile, che non si somigliano). Si preferisce il nome che Teleport CONOSCE,
// cioe' quello che compare anche nell'audit del
// cluster: e' l'unico dei due con cui la riga si collega al resto della pagina, e senza quel criterio
// la stessa persona sembra due.
export function personaMacchina(m, utentiNoti = new Set()) {
  const visti = m?.utenti?.length ? m.utenti : m?.utente ? [m.utente] : []
  const noto = visti.find((u) => utentiNoti.has(u))
  const nome = noto ?? m?.utente ?? null
  return { nome, altri: visti.filter((u) => u !== nome) }
}

// Le due frasi che vanno in cima: quel che la pagina ha TROVATO, e quel che ha guardato senza trovare
// niente. Senza, i cinque numeri grandi stanno tutti sulla stessa riga e tre sono spenti: l'occhio non
// ha un posto dove cadere, e per sapere cosa sono le «6 scritture» tocca aprire due tabelle e
// incrociarle a mano.
//
// Torna DATI e non testo: le frasi le compone la pagina, che ha il dizionario. `trovato` è ordinato per
// urgenza (chi non entra, chi è dentro adesso, chi ha scritto, chi è indietro), `tranquillo` sono le
// famiglie guardate e risultate a zero, che è un'informazione e non un vuoto.
export function riepilogo(audit = {}, heartbeat = {}, riferimento = null) {
  const trovato = []
  const tranquillo = []
  const spingi = (condizione, voce) => (condizione ? trovato : tranquillo).push(voce)

  spingi((audit.loginFallite ?? 0) > 0, { k: 'fallite', n: audit.loginFallite ?? 0, vista: 'persone' })
  spingi((audit.sshAperte ?? 0) > 0, { k: 'sshAperte', n: audit.sshAperte ?? 0, vista: 'ssh' })

  // Le scritture: non il totale, ma DOVE sono andate e su quale ambiente, che è la differenza fra il
  // mestiere di tutti i giorni e la cosa che si guarda.
  const scriventi = (audit.database ?? []).filter((d) => (d.scritture ?? 0) > 0)
  const prod = scriventi.filter((d) => d.ambiente === 'prod')
  spingi(scriventi.length > 0, {
    k: 'scritture',
    n: audit.scritture ?? 0,
    dove: (prod.length ? prod : scriventi).map((d) => (d.nome && d.nome !== '?' ? d.nome : d.servizio)),
    prod: prod.length > 0,
    vista: 'database',
  })

  spingi((heartbeat.conToolMancanti ?? 0) > 0, { k: 'tool', n: heartbeat.conToolMancanti ?? 0, vista: 'devEnv' })

  // Le versioni contano come «trovato» solo quando il confronto è un fatto, cioè con la versione attesa
  // in config: senza, sono una statistica, e una statistica in cima alla pagina si legge come un
  // problema che non c'è.
  const versioni = heartbeat.versioni?.length ?? 0
  const accusabile = riferimento?.fonte === 'config'
  spingi(accusabile && (versioni > 1 || tuttiIndietro(heartbeat.macchine ?? [], riferimento)), {
    k: 'versioni',
    n: versioni,
    tutti: tuttiIndietro(heartbeat.macchine ?? [], riferimento),
    vista: 'devEnv',
  })

  return { trovato, tranquillo }
}
