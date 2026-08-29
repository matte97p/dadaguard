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
const MAX_EVENTI = 3000 // tetto duro: una giornata storta non deve diventare una pagina che non carica

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
  const righe = await eventi(aws, { logGroup, filterPattern: '?"user.login" ?"db.session.start"', da })

  const persone = new Map()
  const chiave = (nome) => {
    if (!persone.has(nome)) persone.set(nome, { utente: nome, loginOk: 0, loginFallite: 0, motivo: null, sessioniDb: 0, ultima: null })
    return persone.get(nome)
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
    }
  }

  const elenco = [...persone.values()].sort((a, b) => (b.ultima ?? 0) - (a.ultima ?? 0))
  return {
    ore,
    persone: elenco,
    loginFallite: elenco.reduce((n, p) => n + p.loginFallite, 0),
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
