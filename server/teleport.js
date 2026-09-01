// Superficie "Accessi" — chi entra dove, cosa si e' rotto, e chi ha il dev-env indietro.
//
// Perche' esiste: i dati ci sono gia' tutti e non li guarda nessuno. L'audit di Teleport registra ogni
// login con esito e motivo, ogni sessione verso un database e ogni tunnel AWS, col nome della persona;
// il dev-env manda una riga per avvio con la versione dell'immagine. Il 28/08/2026 il connector e'
// stato applicato nominando ruoli che sul cluster non esistevano: Teleport ha rifiutato l'INTERA login
// di chi passava da quelle mappature, il team e' rimasto fuori due ore, e la notizia e' arrivata come
// un messaggio in chat («non riesco a entrare, puo' essere GitHub?») mentre la riga con la causa era
// nel log dal primo tentativo.
//
// Read-only, come tutto il resto di Dadaguard: due `FilterLogEvents` e nessuna scrittura.
//
// ⚠️ Niente nomi nostri qui dentro: log group e account arrivano dalla config (`teleport:` in
// services.yaml o DADAGUARD_CONFIG). Senza quella sezione la superficie non esiste e la pagina lo dice.
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { clientOpts } from './runtime/awsClient.js'

export const key = 'teleport'

const ORE_DEFAULT = 24
const MAX_EVENTI = 5000 // tetto duro: una giornata storta non deve diventare una pagina che non carica

// La prima parola di una query dice il mestiere. Serve per separare «ha guardato» da «ha scritto», che
// e' la domanda vera su un database di produzione.
// ⚠️ Della query si tiene SOLO questa parola, mai il testo: dentro a una `WHERE` ci sono i dati dei
// clienti, e questa pagina la guarda chi non ha (e non deve avere) accesso a quei dati.
const SCRITTURE = new Set(['insert', 'update', 'delete', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke'])

// Una versione VERA e' un digest. L'heartbeat manda anche la parola con cui dichiara di non sapere
// («sconosciuta», quando l'avvio non ha potuto leggere l'immagine), e sui dati veri del 31/08/2026 ce
// n'erano: contandola come versione diceva «cinque versioni in giro» su quattro versioni e una riga
// senza il dato. Si riconosce la FORMA e non la parola, perche' la parola la scrive un altro script.
const FORMA_DIGEST = /^(?:[a-z0-9]+:)?[A-Fa-f0-9]{12,}$/
const versioneNota = (v) => FORMA_DIGEST.test(String(v ?? '').trim())
function mestiere(query) {
  const prima = String(query ?? '').trim().toLowerCase().match(/^[a-z]+/)
  return prima ? prima[0] : ''
}

// Una riga di log JSON, o null se non e' JSON (il cluster scrive anche righe di testo).
function comeJson(messaggio) {
  const grezzo = String(messaggio ?? '').trim()
  if (!grezzo.startsWith('{')) return null
  try {
    return JSON.parse(grezzo)
  } catch {
    return null
  }
}

// Gli eventi che ci interessano, in UNA chiamata: `?a ?b` in un filter pattern e' un OR.
// Il tetto vale sia sul numero sia sul tempo: senza, un log group grosso si porta via il minuto.
async function eventi(aws, { logGroup, filterPattern, da, limite = MAX_EVENTI }) {
  const cw = new CloudWatchLogsClient(clientOpts(aws))
  const fuori = []
  let token
  do {
    const out = await cw.send(
      new FilterLogEventsCommand({
        logGroupName: logGroup,
        startTime: da,
        filterPattern,
        limit: Math.min(1000, limite - fuori.length),
        nextToken: token,
      }),
    )
    fuori.push(...(out.events ?? []))
    token = out.nextToken
  } while (token && fuori.length < limite)
  return fuori
}

// Chi ha provato a entrare, com'e' andata, e chi sta usando i database.
//
// ⚠️ Il motivo della login fallita si tiene per intero, e non si accorcia a «errore»: e' la differenza
// fra «una sessione scaduta» (normale) e «un ruolo che sul cluster non esiste» (tutto il team fuori).
export async function audit(aws, { logGroup, ore = ORE_DEFAULT } = {}) {
  if (!logGroup) return null
  const da = Date.now() - ore * 3600_000
  // `session.start` e `session.end` sono le sessioni SSH sulle macchine (nodi `mac-dev`): la parte che
  // risponde a «chi e' entrato sul computer di chi», che per un accesso del genere non e' un extra.
  const righe = await eventi(aws, { logGroup, filterPattern: '?"user.login" ?"db.session.start" ?"db.session.query" ?"session.start" ?"session.end"', da })

  const persone = new Map()
  const chiave = (nome) => {
    if (!persone.has(nome)) {
      // `primaFallita`/`ultimaFallita`: i due istanti della raffica, non solo quante sono. Tre fallite
      // in due minuti sono un guasto in corso, tre in ventiquattro ore sono tre giornate diverse, e il
      // conteggio da solo le racconta identiche. Sono separati da `ultima`, che e' l'ultimo evento di
      // QUALSIASI tipo: una persona che dopo le fallite e' entrata ha `ultima` recente e la raffica
      // finita mezz'ora prima.
      persone.set(nome, { utente: nome, loginOk: 0, loginFallite: 0, motivo: null, primaFallita: null, ultimaFallita: null, sessioniDb: 0, sessioniDbNegate: 0, query: 0, scritture: 0, sessioniSsh: 0, ultima: null, teams: null, organizzazione: null, ultimoLoginOk: null })
    }
    return persone.get(nome)
  }
  // Per database: quante query, quante scritture, e QUANTE PERSONE. Un database toccato da una persona
  // sola e' una cosa; lo stesso numero fatto da sei persone e' un'altra.
  const database = new Map()
  const perDatabase = (servizio, nome) => {
    const k = `${servizio ?? '?'}/${nome ?? '?'}`
    if (!database.has(k))
      database.set(k, {
        servizio: servizio ?? '?',
        nome: nome ?? '?',
        query: 0,
        scritture: 0,
        persone: new Set(),
        scriventi: new Set(),
        // L'istante dell'ultima scrittura su questo database: serve a chi annuncia, per dire una cosa
        // sola una volta invece di ripeterla a ogni giro per tutta la finestra.
        ultimaScrittura: null,
        ambiente: null,
      })
    return database.get(k)
  }

  // Sessioni SSH per MACCHINA: chi e' entrato, quante volte, e quando l'ultima. La chiave e' il nodo e
  // non la persona, perche' la domanda arriva sempre da quel verso: «chi e' stato sul mio Mac?».
  const macchine = new Map()
  const perMacchina = (nodo) => {
    const k = nodo ?? '?'
    if (!macchine.has(k))
      macchine.set(k, { macchina: k, sessioni: 0, chi: new Set(), ultima: null, iniziate: new Set(), finite: new Set() })
    return macchine.get(k)
  }

  for (const ev of righe) {
    const dati = comeJson(ev.message)
    const campi = dati?.fields ?? dati
    const tipo = campi?.event ?? dati?.event_type
    const utente = campi?.user ?? dati?.user
    if (!tipo || !utente) continue
    const p = chiave(utente)
    p.ultima = Math.max(p.ultima ?? 0, ev.timestamp ?? 0)
    if (tipo === 'user.login') {
      if (campi.success === false) {
        p.loginFallite += 1
        const quando = ev.timestamp ?? 0
        p.primaFallita = p.primaFallita == null ? quando : Math.min(p.primaFallita, quando)
        p.ultimaFallita = Math.max(p.ultimaFallita ?? 0, quando)
        // L'ultimo motivo vince: durante un guasto la gente riprova, e la riga utile e' la piu' recente.
        // ⚠️ «L'ultimo» per TEMPO, non «l'ultimo letto»: `FilterLogEvents` ordina per stream, non fra
        // stream diversi, quindi senza il confronto sull'istante il motivo mostrato dipende da come sono
        // spezzati i log. E' lo stesso inciampo delle sessioni SSH aperte (piu' sotto), scoperto la' e
        // corretto qui prima che succedesse.
        const motivo = String(campi.error ?? '').split('\n').pop().trim()
        if (motivo && quando >= (p.motivoQuando ?? 0)) {
          p.motivo = motivo
          p.motivoQuando = quando
        }
      } else {
        p.loginOk += 1
        const quando = ev.timestamp ?? 0
        p.ultimoLoginOk = Math.max(p.ultimoLoginOk ?? 0, quando)
        // I TEAM che il connector ha visto al login, dentro `attributes` come { organizzazione: [team] }.
        // E' la fonte viva di «di che team fa parte questa persona» senza un token GitHub, ed e' anche
        // quella giusta: i ruoli del certificato li decide esattamente questa lista, non l'organigramma.
        // ⚠️ Sono i team di cui e' membro DIRETTO: GitHub, all'endpoint che Teleport usa, non risale ai
        // team padre, ed e' il motivo per cui la scala dei ruoli ripete il baseline su ogni gradino.
        const org = campi.attributes && Object.keys(campi.attributes)[0]
        const teams = org ? campi.attributes[org] : null
        // L'ultimo login per TEMPO vince: se qualcuno e' entrato in un team stamattina, la lista di
        // stamattina e' quella vera, e `FilterLogEvents` non ordina fra stream diversi.
        if (Array.isArray(teams) && quando >= (p.teamsQuando ?? 0)) {
          p.teams = [...teams].sort()
          p.organizzazione = org
          p.teamsQuando = quando
        }
      }
    } else if (tipo === 'db.session.start') {
      // ⚠️ Un tentativo RIFIUTATO non e' una sessione, e sommarlo alle altre e' il modo in cui
      // sparisce: chi ha sbattuto contro un permesso finisce dentro il numero di chi e' entrato. Il
      // 01/09/2026 sette tentativi negati in un giorno, due persone, tre utenti di database diversi,
      // e questa pagina diceva soltanto «sessioni». Il motivo lo porta il log dal primo tentativo.
      if (campi.success === false) {
        p.sessioniDbNegate += 1
        const quando = ev.timestamp ?? 0
        // L'ultimo motivo per TEMPO, e nella stessa colonna delle login fallite: la domanda che
        // quella colonna risponde e' «perche' questa persona ha sbattuto», e un utente di database
        // che il ruolo non concede e' una risposta come «ruolo che non esiste». Il confronto sugli
        // istanti c'e' per la stessa ragione di la': `FilterLogEvents` ordina per stream, non fra
        // stream diversi, quindi senza di lui il motivo mostrato dipende da come sono spezzati i log.
        if (quando >= (p.motivoQuando ?? 0)) {
          p.motivo = String(campi.error ?? '').split('\n').pop().trim() || null
          p.motivoQuando = quando
        }
      } else {
        p.sessioniDb += 1
      }
    } else if (tipo === 'session.start' || tipo === 'session.end') {
      // ⚠️ Il nodo si legge da `server_hostname`, non da `server_id`: il secondo e' un UUID, cioe'
      // esattamente il nome che non aiuta chi legge «chi e' entrato dove».
      const m = perMacchina(campi.server_hostname ?? campi.server_id)
      // ⚠️ Si appaiano gli ID di sessione, NON si conta piu' o meno uno. La prima stesura teneva un
      // contatore (`+1` allo start, `-1` all'end, con una guardia per non andare sotto zero) e il
      // 31/08/2026 la pagina ha detto «1 aperta adesso» su due sessioni entrambe chiuse: un contatore
      // dipende dall'ORDINE, e `FilterLogEvents` restituisce le righe ordinate per stream, non fra
      // stream diversi, quindi un `end` letto prima del suo `start` non decrementava (la guardia) e lo
      // `start` poi incrementava. Con gli insiemi l'ordine non conta.
      const sid = campi.sid ?? null
      if (tipo === 'session.start') {
        m.sessioni += 1
        m.chi.add(utente)
        p.sessioniSsh += 1
        if (sid) m.iniziate.add(sid)
      } else if (sid) {
        m.finite.add(sid)
      }
      m.ultima = Math.max(m.ultima ?? 0, ev.timestamp ?? 0)
    } else if (tipo === 'db.session.query') {
      const d = perDatabase(campi.db_service, campi.db_name)
      d.query += 1
      d.persone.add(utente)
      d.ambiente = d.ambiente ?? campi.db_labels?.env ?? null
      p.query += 1
      if (SCRITTURE.has(mestiere(campi.db_query))) {
        d.scritture += 1
        d.scriventi.add(utente)
        d.ultimaScrittura = Math.max(d.ultimaScrittura ?? 0, ev.timestamp ?? 0)
        p.scritture += 1
      }
    }
  }

  const elenco = [...persone.values()]
    .map(({ motivoQuando, teamsQuando, ...p }) => p)
    .sort((a, b) => (b.ultima ?? 0) - (a.ultima ?? 0))
  const db = [...database.values()]
    .map((d) => ({ ...d, persone: d.persone.size, scriventi: [...d.scriventi] }))
    .sort((a, b) => b.query - a.query)
  // Aperta = ha uno `start` e nessun `end` con lo STESSO id. Un `end` il cui `start` e' fuori dalla
  // finestra non conta come apertura (non sta in `iniziate`), e uno `start` senza `end` resta aperto,
  // che e' l'informazione giusta: qualcuno e' dentro adesso.
  const ssh = [...macchine.values()]
    .map(({ iniziate, finite, ...m }) => ({
      ...m,
      chi: [...m.chi],
      aperte: [...iniziate].filter((sid) => !finite.has(sid)).length,
    }))
    .sort((a, b) => (b.ultima ?? 0) - (a.ultima ?? 0))
  return {
    ore,
    persone: elenco,
    database: db,
    ssh,
    sessioniSsh: ssh.reduce((n, m) => n + m.sessioni, 0),
    sshAperte: ssh.reduce((n, m) => n + m.aperte, 0),
    loginFallite: elenco.reduce((n, p) => n + p.loginFallite, 0),
    query: elenco.reduce((n, p) => n + p.query, 0),
    scritture: elenco.reduce((n, p) => n + p.scritture, 0),
    sessioniDb: elenco.reduce((n, p) => n + p.sessioniDb, 0),
    // I rifiuti stanno a parte dal totale delle sessioni, non dentro: sono la domanda opposta.
    sessioniDbNegate: elenco.reduce((n, p) => n + p.sessioniDbNegate, 0),
    // ⚠️ Se si e' toccato il tetto, quelli sotto sono un CAMPIONE e non un totale: dirlo, perche' un
    // numero parziale spacciato per totale e' peggio di nessun numero.
    troncato: righe.length >= MAX_EVENTI,
    // Il motivo piu' frequente fra le fallite: e' la riga che risponde a «cosa sta succedendo adesso».
    motivoPiuComune: piuComune(elenco.filter((p) => p.motivo).map((p) => p.motivo)),
  }
}

function piuComune(valori) {
  const conta = new Map()
  for (const v of valori) conta.set(v, (conta.get(v) ?? 0) + 1)
  let top = null
  for (const [v, n] of conta) if (!top || n > top.quante) top = { motivo: v, quante: n }
  return top
}

// L'ultima riga di heartbeat per MACCHINA: chi e' partito, con che versione dell'immagine, con che
// esito, e quanti tool gli mancano sul Mac.
//
// ⚠️ Per macchina e non per persona: la stessa persona ha il portatile e il container, e sono due
// stati diversi. Una versione vecchia su una sola delle due e' esattamente il caso che spiega meta'
// dei «a me non funziona».
export async function heartbeat(aws, { logGroup, giorni = 7, immagineAttesa = null } = {}) {
  if (!logGroup) return null
  const da = Date.now() - giorni * 86_400_000
  const righe = await eventi(aws, { logGroup, filterPattern: '', da })

  const perMacchina = new Map()
  // Tutti i nomi visti per quella macchina, non solo quello dell'ultimo avvio: l'heartbeat manda
  // l'utente Teleport se c'e' una sessione e altrimenti quello di SISTEMA, quindi la stessa persona
  // compare con due nomi (visto il 31/08/2026 su due macchine su cinque: l'utente del cluster e quello
  // del portatile, che non si somigliano) e quale dei due finisce in tabella dipende
  // da com'e' andato l'ultimo avvio. La pagina sceglie quello che Teleport conosce.
  const nomiVisti = new Map()
  for (const ev of righe) {
    const r = comeJson(ev.message)
    if (!r?.macchina) continue
    const chiave = `${r.macchina}/${r.lato ?? '?'}`
    if (r.utente) {
      if (!nomiVisti.has(chiave)) nomiVisti.set(chiave, new Set())
      nomiVisti.get(chiave).add(r.utente)
    }
    const precedente = perMacchina.get(chiave)
    if (!precedente || (ev.timestamp ?? 0) > precedente.quando) {
      perMacchina.set(chiave, {
        macchina: r.macchina,
        lato: r.lato ?? null,
        utente: r.utente ?? null,
        immagine: r.immagine ?? null,
        // QUANDO e' stata costruita quell'immagine, se l'avvio l'ha mandata: e' il campo con cui
        // «indietro» diventa un ordine invece di una stima, perche' fra due digest diversi non si sa
        // quale sia il piu' nuovo mentre due date si confrontano.
        creata: r.creata ?? null,
        esito: r.esito ?? null,
        toolMancanti: Number(r.tool_mancanti ?? 0),
        durata: r.durata != null ? Number(r.durata) : null,
        quando: ev.timestamp ?? 0,
      })
    }
  }

  const elenco = [...perMacchina.entries()]
    .map(([chiave, m]) => ({ ...m, utenti: [...(nomiVisti.get(chiave) ?? [])] }))
    .sort((a, b) => b.quando - a.quando)
  // Le versioni in giro: solo quelle DICHIARATE, perche' «sconosciuta» non e' una versione e contarla
  // gonfia il numero che la pagina mostra piu' grande di tutti.
  const versioni = new Map()
  for (const m of elenco) if (versioneNota(m.immagine)) versioni.set(m.immagine, (versioni.get(m.immagine) ?? 0) + 1)
  return {
    giorni,
    // La versione ATTESA, se la config la dice. Serve a rispondere alla domanda che il ripiego non puo'
    // porsi: se nessuno ha ancora aggiornato, «la piu' nuova che qualcuno ha visto» e' la vecchia, e la
    // pagina direbbe che vanno tutti bene. Senza questo campo resta il ripiego, dichiarato come tale.
    attesa: immagineAttesa,
    macchine: elenco,
    versioni: [...versioni.entries()].map(([immagine, quante]) => ({ immagine, quante })).sort((a, b) => b.quante - a.quante),
    conToolMancanti: elenco.filter((m) => m.toolMancanti > 0).length,
    // Le macchine che non hanno dichiarato la versione: non sono indietro, sono senza il dato, e
    // vanno contate a parte invece di sparire dentro «versioni in giro».
    senzaVersione: elenco.filter((m) => !versioneNota(m.immagine)).length,
  }
}
