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
      persone.set(nome, { utente: nome, loginOk: 0, loginFallite: 0, motivo: null, sessioniDb: 0, query: 0, scritture: 0, sessioniSsh: 0, ultima: null })
    }
    return persone.get(nome)
  }
  // Per database: quante query, quante scritture, e QUANTE PERSONE. Un database toccato da una persona
  // sola e' una cosa; lo stesso numero fatto da sei persone e' un'altra.
  const database = new Map()
  const perDatabase = (servizio, nome) => {
    const k = `${servizio ?? '?'}/${nome ?? '?'}`
    if (!database.has(k)) database.set(k, { servizio: servizio ?? '?', nome: nome ?? '?', query: 0, scritture: 0, persone: new Set(), ambiente: null })
    return database.get(k)
  }

  // Sessioni SSH per MACCHINA: chi e' entrato, quante volte, e quando l'ultima. La chiave e' il nodo e
  // non la persona, perche' la domanda arriva sempre da quel verso: «chi e' stato sul mio Mac?».
  const macchine = new Map()
  const perMacchina = (nodo) => {
    const k = nodo ?? '?'
    if (!macchine.has(k)) macchine.set(k, { macchina: k, sessioni: 0, chi: new Set(), ultima: null, aperte: 0 })
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
        // L'ultimo motivo vince: durante un guasto la gente riprova, e la riga utile e' la piu' recente.
        p.motivo = String(campi.error ?? '').split('\n').pop().trim() || p.motivo
      } else {
        p.loginOk += 1
      }
    } else if (tipo === 'db.session.start') {
      p.sessioniDb += 1
    } else if (tipo === 'session.start' || tipo === 'session.end') {
      // ⚠️ Il nodo si legge da `server_hostname`, non da `server_id`: il secondo e' un UUID, cioe'
      // esattamente il nome che non aiuta chi legge «chi e' entrato dove».
      const m = perMacchina(campi.server_hostname ?? campi.server_id)
      if (tipo === 'session.start') {
        m.sessioni += 1
        m.chi.add(utente)
        p.sessioniSsh += 1
        // `aperte` sale allo start e scende all'end: senza il secondo evento la sessione risulta
        // ancora aperta, che e' l'informazione giusta (qualcuno e' dentro adesso).
        m.aperte += 1
      } else if (m.aperte > 0) {
        m.aperte -= 1
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
        p.scritture += 1
      }
    }
  }

  const elenco = [...persone.values()].sort((a, b) => (b.ultima ?? 0) - (a.ultima ?? 0))
  const db = [...database.values()]
    .map((d) => ({ ...d, persone: d.persone.size }))
    .sort((a, b) => b.query - a.query)
  const ssh = [...macchine.values()]
    .map((m) => ({ ...m, chi: [...m.chi] }))
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
export async function heartbeat(aws, { logGroup, giorni = 7 } = {}) {
  if (!logGroup) return null
  const da = Date.now() - giorni * 86_400_000
  const righe = await eventi(aws, { logGroup, filterPattern: '', da })

  const perMacchina = new Map()
  for (const ev of righe) {
    const r = comeJson(ev.message)
    if (!r?.macchina) continue
    const chiave = `${r.macchina}/${r.lato ?? '?'}`
    const precedente = perMacchina.get(chiave)
    if (!precedente || (ev.timestamp ?? 0) > precedente.quando) {
      perMacchina.set(chiave, {
        macchina: r.macchina,
        lato: r.lato ?? null,
        utente: r.utente ?? null,
        immagine: r.immagine ?? null,
        esito: r.esito ?? null,
        toolMancanti: Number(r.tool_mancanti ?? 0),
        durata: r.durata != null ? Number(r.durata) : null,
        quando: ev.timestamp ?? 0,
      })
    }
  }

  const elenco = [...perMacchina.values()].sort((a, b) => b.quando - a.quando)
  // Le versioni in giro: se sono piu' di una, qualcuno e' indietro e la mappa deve dirlo subito.
  const versioni = new Map()
  for (const m of elenco) if (m.immagine) versioni.set(m.immagine, (versioni.get(m.immagine) ?? 0) + 1)
  return {
    giorni,
    macchine: elenco,
    versioni: [...versioni.entries()].map(([immagine, quante]) => ({ immagine, quante })).sort((a, b) => b.quante - a.quante),
    conToolMancanti: elenco.filter((m) => m.toolMancanti > 0).length,
  }
}
