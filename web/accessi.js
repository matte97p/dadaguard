// Le REGOLE della pagina Accessi, fuori dal componente: quali righe hanno un problema, in che ordine
// si mostrano, qual è l'immagine di riferimento e come si accorcia un digest.
//
// Stanno qui e non dentro `AccessiPage.jsx` per la stessa ragione di `deployRows.js` e `nowSignals.js`:
// una regola dentro un componente si può leggere, non si può provare. E qui le regole sono la parte
// che decide cosa una persona guarda per prima durante un guasto, cioè esattamente quello che non deve
// cambiare per sbaglio al primo ritocco della tabella. Le prove sono in `test/accessi.test.js`.
//
// Tutto puro: nessun React, nessuna fetch, nessuna data «adesso» letta da dentro.

// `sha256:45486f792f3f2a…` → `45486f792f3f`. Il prefisso è identico su ogni riga: occupa la colonna
// per niente, e sono i caratteri che servirebbero a distinguere due immagini a colpo d'occhio.
export function digestCorto(immagine, quanti = 12) {
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
    if (!m?.immagine) continue
    if (!piuRecente || (m.quando ?? 0) > (piuRecente.quando ?? 0)) piuRecente = m
  }
  return { immagine: piuRecente?.immagine ?? null, fonte: 'vista' }
}

export const macchinaIndietro = (m, riferimento) =>
  Boolean(riferimento && m?.immagine && m.immagine !== riferimento)

// Un avvio con esito diverso da `ok` è una macchina che è partita male, e va detto anche se il resto
// della riga sembra sano. `null` (heartbeat vecchio, senza il campo) NON è un avvio storto: inventare
// un problema dove il dato manca è peggio che non dirlo.
export const avvioStorto = (m) => Boolean(m?.esito && m.esito !== 'ok')

// «Tutti indietro»: la versione attesa la sa la config e non ce l'ha NESSUNA macchina. Senza versione
// attesa la domanda non si può porre, e la risposta è `false` (non «sì per prudenza»: un allarme che
// non sa distinguere è un allarme che si impara a ignorare).
export function tuttiIndietro(macchine = [], riferimento) {
  if (!riferimento || riferimento.fonte !== 'config') return false
  const conImmagine = macchine.filter((m) => m?.immagine)
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
  macchinaIndietro(m, riferimento?.immagine ?? riferimento) || (m?.toolMancanti ?? 0) > 0 || avvioStorto(m)
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
