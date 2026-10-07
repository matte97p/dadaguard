// Le REGOLE della pagina Accessi, fuori dal componente: quali righe hanno un problema, in che ordine
// si mostrano, e come diventano l'elenco «da sistemare» in cima alla pagina.
//
// Le regole sulle MACCHINE del dev-env (immagine indietro, digest, uso) stanno in `shared/devEnv.js`
// dal 07/10/2026: il dev-env ha una pagina sua (Flotta), e quelle regole le applica il server.
//
// Stanno qui e non dentro `AccessiPage.jsx` per la stessa ragione di `deployRows.js` e `nowSignals.js`:
// una regola dentro un componente si può leggere, non si può provare. E qui le regole sono la parte
// che decide cosa una persona guarda per prima durante un guasto, cioè esattamente quello che non deve
// cambiare per sbaglio al primo ritocco della tabella. Le prove sono in `test/accessi.test.js`.
//
// Tutto puro: nessun React, nessuna fetch, nessuna data «adesso» letta da dentro.

// Chi ha un problema, per ciascuna delle tre liste. Sono le stesse funzioni che decidono il
// pallino sull'interruttore, l'ordine delle righe e cosa resta accendendo «solo da guardare»: se
// fossero tre copie, il pallino direbbe una cosa e il filtro un'altra.
// ⚠️ Anche un accesso al DATABASE negato e' un problema di questa persona, non solo una login
// fallita: e' lo stesso fatto (ha sbattuto contro un permesso) e finiva in nessuna delle due
// viste, perche' i rifiuti erano contati fra le sessioni riuscite (01/09/2026).
export const problemaPersona = (p) => (p?.loginFallite ?? 0) > 0 || (p?.sessioniDbNegate ?? 0) > 0
// Le SCRITTURE su un `prod`, non le query: un database di produzione letto da sei persone è il
// mestiere, scriverci è la cosa che si guarda.
export const problemaDatabase = (d) => (d?.scritture ?? 0) > 0 && d?.ambiente === 'prod'
export const problemaSsh = (m) => (m?.aperte ?? 0) > 0

// Ordinamento di default: prima le righe con un problema, poi le più recenti. In un guasto si guarda
// la PRIMA riga, non la settima, e l'ordine per data da solo mette in cima chi ha appena lavorato.
const primaIProblemi = (problema) => (a, b) => Number(problema(b)) - Number(problema(a))
const perData = (campo) => (a, b) => (b[campo] ?? 0) - (a[campo] ?? 0)

export const ordinaPersone = (persone = []) =>
  [...persone].sort((a, b) => primaIProblemi(problemaPersona)(a, b) || perData('ultima')(a, b))

export const ordinaDatabase = (database = []) =>
  [...database].sort((a, b) => primaIProblemi(problemaDatabase)(a, b) || (b.query ?? 0) - (a.query ?? 0))

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

// ── «Da sistemare»: UN elenco, in ordine di urgenza ────────────────────────────────────────────────
//
// La pagina di prima apriva con cinque riassunti uno sotto l'altro (titolo, «da guardare:», due card
// di numeri, «guardato e a posto») che ripetevano gli stessi conteggi, e poi le tabelle con le righe
// sane e quelle rotte con lo stesso peso. La domanda della pagina e' una sola, «c'e' qualcosa che non
// va negli accessi adesso?», e la risposta e' un elenco di cose, ognuna con chi, cosa, quando e il
// posto dove si agisce. Qui si costruisce quell'elenco; la pagina lo disegna e basta.
//
// Le voci, e perche' sono queste:
//   · `login`: le login fallite RAGGRUPPATE PER MOTIVO, non per persona. Lo stesso motivo per piu'
//     persone e' la configurazione, non qualcuno che ha sbagliato (il 28/08/2026 un ruolo inesistente
//     ha chiuso fuori tutto il team, e la pagina mostrava sette righe uguali invece di una causa);
//   · `ssh`: una sessione ancora aperta sulla macchina di qualcuno, l'unica cosa a cui si reagisce
//     subito;
//   · `scrittura`: le scritture su un database di PRODUZIONE (su staging e' il lavoro di tutti i
//     giorni); rosse sui dati dei clienti, gialle sulla sola struttura, come su Slack;
//   · `negato`: gli accessi a un database rifiutati, per persona, con la coppia utente+database.
//
// ⚠️ Un ruolo che sul cluster non esiste e' un problema di RUOLI anche quando capita a una persona
// sola: non si sistema riprovando, si sistema nel connector. Per questo la voce lo marca a parte.
const RUOLO_MANCANTE = /role\b.*\bnot found|ruolo\b.*\bnon (esiste|trovato)/i
const RANGO = { crit: 0, warn: 1, info: 2 }
const ORDINE_TIPO = { login: 0, ssh: 1, scrittura: 2, negato: 3 }

// `proprietari`: { macchina: [nomi] } da chi la avvia (l'heartbeat). Serve a dire «e' sulla sua
// macchina» invece di suonare come un'intrusione: la stessa regola del canale (`segnali()` in
// server/accessi.js), che non annuncia chi entra sul proprio Mac.
export function daSistemare(audit = {}, { proprietari = {} } = {}) {
  const voci = []
  const persone = audit.persone ?? []

  const perMotivo = new Map()
  for (const p of persone) {
    if (!((p?.loginFallite ?? 0) > 0)) continue
    const motivo = String(p.motivo ?? '').trim()
    perMotivo.set(motivo, [...(perMotivo.get(motivo) ?? []), p])
  }
  for (const [motivo, chi] of perMotivo) {
    // Chi non e' mai entrato nella finestra e' FUORI; chi ha anche delle login riuscite ha sbattuto
    // una volta e poi e' entrato, che e' un'altra notizia.
    const fuori = chi.filter((p) => !((p.loginOk ?? 0) > 0)).map((p) => p.utente)
    const ruolo = RUOLO_MANCANTE.test(motivo)
    const prime = chi.map((p) => p.primaFallita).filter(Number.isFinite)
    const ultime = chi.map((p) => p.ultimaFallita ?? p.ultima).filter(Number.isFinite)
    voci.push({
      id: `login:${motivo}`,
      tipo: 'login',
      ancora: 'login',
      livello: chi.length > 1 || fuori.length > 0 || ruolo ? 'crit' : 'warn',
      motivo: motivo || null,
      ruolo,
      // Piu' persone con lo stesso motivo: e' la frase che dice «guarda la config, non la persona».
      perTutti: chi.length > 1,
      chi: chi.map((p) => p.utente).sort(),
      fuori: fuori.sort(),
      quante: chi.reduce((n, p) => n + (p.loginFallite ?? 0), 0),
      prima: prime.length ? Math.min(...prime) : null,
      ultima: ultime.length ? Math.max(...ultime) : null,
    })
  }

  for (const m of audit.ssh ?? []) {
    if (!problemaSsh(m)) continue
    const suoi = proprietari[m.macchina] ?? []
    const estranei = (m.chi ?? []).filter((c) => !suoi.includes(c))
    voci.push({
      id: `ssh:${m.macchina}`,
      tipo: 'ssh',
      ancora: 'ssh',
      // Sulla propria macchina e' una cosa da sapere, non un allarme; su quella di un altro si'.
      livello: suoi.length && estranei.length === 0 ? 'warn' : 'crit',
      macchina: m.macchina,
      diChi: suoi,
      suaMacchina: suoi.length > 0 && estranei.length === 0,
      chi: [...(m.chi ?? [])].sort(),
      aperte: m.aperte,
      ultima: m.ultima ?? null,
    })
  }

  for (const d of audit.database ?? []) {
    if (!problemaDatabase(d)) continue
    // La divisione dati/struttura arriva dall'audit; un payload che non la porta (versione
    // precedente) si legge come scrittura sui dati, che e' il caso da non sottovalutare.
    const soloStruttura = (d.scrittureStruttura ?? 0) > 0 && !((d.scrittureDati ?? 0) > 0)
    voci.push({
      id: `scrittura:${d.servizio}/${d.nome}`,
      tipo: 'scrittura',
      ancora: 'scritture',
      livello: soloStruttura ? 'warn' : 'crit',
      db: d.nome && d.nome !== '?' ? d.nome : d.servizio,
      servizio: d.servizio,
      quante: d.scritture,
      soloStruttura,
      azioni: (d.azioni ?? []).slice(0, 3),
      tabelle: (d.bersagli ?? []).slice(0, 3),
      chi: [...((d.scriventi ?? []).length ? d.scriventi : (d.chi ?? []))].sort(),
      ultima: d.ultimaScrittura ?? null,
    })
  }

  for (const p of persone) {
    if (!((p?.sessioniDbNegate ?? 0) > 0)) continue
    const negati = p.negati ?? []
    const ultime = negati.map((n) => n.ultima).filter(Number.isFinite)
    voci.push({
      id: `negato:${p.utente}`,
      tipo: 'negato',
      ancora: 'login',
      livello: 'warn',
      utente: p.utente,
      chi: [p.utente],
      quante: p.sessioniDbNegate,
      negati: negati.slice(0, 3),
      ultima: ultime.length ? Math.max(...ultime) : (p.ultima ?? null),
    })
  }

  return voci.sort(
    (a, b) =>
      RANGO[a.livello] - RANGO[b.livello] ||
      ORDINE_TIPO[a.tipo] - ORDINE_TIPO[b.tipo] ||
      (b.ultima ?? 0) - (a.ultima ?? 0),
  )
}

// Chi avvia ogni macchina, secondo l'heartbeat: `{ macchina: [nomi] }`, con tutti i nomi visti
// (l'avvio manda l'utente Teleport o quello di sistema). Una macchina mai avviata non ha proprietari.
export function proprietariMacchine(heartbeat = {}) {
  const fuori = {}
  for (const m of heartbeat?.macchine ?? []) {
    if (!m?.macchina) continue
    const nomi = m.utenti?.length ? m.utenti : m.utente ? [m.utente] : []
    fuori[m.macchina] = [...new Set([...(fuori[m.macchina] ?? []), ...nomi])]
  }
  return fuori
}

// I campi di una voce su cui si cerca: le persone, il motivo, la macchina, il database.
export const cercaVoce = (v) => [
  ...(v.chi ?? []),
  v.motivo,
  v.macchina,
  v.db,
  v.servizio,
  ...(v.negati ?? []).flatMap((n) => [n.dbUser, n.nome, n.servizio]),
]

// Tutto il resto, cioe' quello che e' in ordine: le persone senza problemi, i database senza
// scritture in produzione, le macchine senza sessioni aperte. Sta chiuso sotto una riga sola, perche'
// una riga sana non deve pesare quanto una rotta.
// `voci`: l'elenco «da sistemare», perche' una persona che compare li' (chi ha scritto in produzione,
// chi e' dentro un Mac) non e' anche «in ordine» una riga sotto.
export function inOrdine(audit = {}, voci = []) {
  const nominati = new Set(voci.flatMap((v) => v.chi ?? []))
  return {
    persone: ordinaPersone((audit.persone ?? []).filter((p) => !problemaPersona(p) && !nominati.has(p.utente))),
    database: ordinaDatabase((audit.database ?? []).filter((d) => !problemaDatabase(d))),
    ssh: ordinaSsh((audit.ssh ?? []).filter((m) => !problemaSsh(m))),
  }
}

// I link di PRIMA, che restano validi come indirizzo: le viste della pagina vecchia (`?vista=persone`,
// `?vista=database`, …) e quelli dei messaggi Slack gia' nel canale. Un link rotto lo scopre chi lo
// riceve, non chi lo ha mandato. Ognuna porta dove sta oggi la stessa domanda:
//   · le login e le sessioni → la voce dell'elenco con quell'ancora;
//   · la mappa → la sezione «chi ha cosa», aperta;
//   · il dev-env → la pagina Flotta, che e' dove i Mac stanno ora.
// L'ancora dell'URL (`#scritture`, il link nuovo) vince sulla vista.
export const VISTE_VECCHIE = Object.freeze({
  chi: 'login',
  persone: 'login',
  ssh: 'ssh',
  database: 'scritture',
  chiHaCosa: 'chiHaCosa',
  mappa: 'chiHaCosa',
  team: 'chiHaCosa',
})

export function destinazioneVista(vista, hash = '') {
  if (vista === 'devEnv') return { flotta: '/flotta' }
  const ancora = String(hash ?? '').replace(/^#/, '')
  if (ancora) return { ancora }
  return VISTE_VECCHIE[vista] ? { ancora: VISTE_VECCHIE[vista] } : {}
}
