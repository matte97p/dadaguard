// Azioni di deploy fatte A MANO — quelle che CodeBuild non racconta.
//
// La pagina Deploy elenca le build dei progetti `*-deploy`. Va bene per il rilascio normale (la CI
// avvia una build), ma lascia fuori l'azione che si fa alle 3 di notte su un servizio incastrato:
// `ecs update-service --force-new-deployment`. Quella non costruisce niente, quindi non esiste
// nessuna build da elencare — e la vista resta muta proprio sull'intervento più intenzionale che
// esista. Chi guarda conclude che nessuno ha toccato niente.
//
// E per le build lanciate a mano (l'hotfix, che SALTA il gate della CI) l'etichetta era `manuale`,
// identica a qualunque build avviata da console: mancava il fatto che conta. Chi ha premuto, poi,
// non era chi risulta: `author` viene dalla variabile esportata DEPLOYER, che è l'autore del
// COMMIT — su un hotfix la persona che ha forzato il rilascio è un'altra.
//
// Fonte per entrambe: CloudTrail LookupEvents (event history, ~90 giorni, nessun trail da creare).
// Il permesso `cloudtrail:LookupEvents` è già concesso al ruolo readonly cross-account.
// Read-only, on-demand, zero storage.
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail'
import { clientOpts } from './runtime/awsClient.js'
import { cachedCall } from './util/cache.js'
import { actorKind, principalName } from './util/principal.js'
import { log } from './log.js'
import { stripOrgEnv } from './util/envToken.js'

// Finestra di 7 giorni, non 30 come il filtro più ampio della pagina, e la ragione è che 30 non si
// possono mantenere onestamente: `LookupEvents` non filtra per due attributi insieme, quindi per
// trovare i riavvii bisogna scorrere TUTTI gli `UpdateService` — e ogni rilascio della CI ne fa uno.
// Su 30 giorni sono centinaia di eventi, cioè decine di pagine per account a ogni refresh (CloudTrail
// sta a 2 chiamate al secondo): il cap sarebbe scattato quasi sempre, e avrebbe tagliato la coda del
// periodo SENZA dirlo — la pagina avrebbe mostrato "nessun riavvio" per i giorni che non ha guardato.
// Sette giorni ci stanno comodi sotto il cap, e sono la finestra in cui un riavvio a mano interessa
// ancora. Il limite è scritto nella UI, non nascosto qui.
const LOOKBACK_HOURS = 24 * 7
const TTL_MS = 60 * 1000 // la pagina si aggiorna ogni 15s: una lookup al minuto per account basta
const MAX_EVENTS = 300

const parse = (raw) => {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {} // payload non-JSON: si ignora, non si inventa
  }
}

// Il ruolo assunto dice COME è stata fatta l'azione: i ruoli `teleport-{restart,hotfix}-<env>`
// esistono solo per `acme-deploy`, quindi la loro presenza è la prova che l'azione è passata da
// Teleport (sessione registrata) e non da una console con AdministratorAccess. Puro/testabile.
export function viaTeleportRole(arn) {
  return /teleport-(restart|hotfix)-/i.test(String(arn ?? ''))
}

// Una build avviata con il ruolo `teleport-hotfix-*` è un HOTFIX: ricostruisce e rilascia FUORI
// dalla CI, senza test né dependency-audit. Distinguerlo da un `manuale` qualunque è il punto:
// è l'unica riga della pagina che significa "in produzione gira codice che nessun test ha visto".
// Puro/testabile.
export function isHotfixRole(arn) {
  return /teleport-hotfix-/i.test(String(arn ?? ''))
}

// Il nome del servizio ECS come lo chiama la pagina Deploy. Un eventuale prefisso `<org>-<env>-` va
// via, altrimenti lo stesso servizio comparirebbe due volte: una per la build e una per il riavvio.
// Puro/testabile. L'ancora è l'ambiente, non l'organizzazione — vedi util/envToken.js.
export function serviceFromEcs(name = '') {
  return stripOrgEnv(name) || String(name)
}

// Un `UpdateService` è un RIAVVIO a mano solo se forza un nuovo deployment SENZA cambiare task
// definition. Se la chiamata porta una `taskDefinition`, è il passo finale di una build (la CI
// registra la revision e poi aggiorna il servizio): quella build è già una riga della pagina, e
// contarla due volte farebbe sembrare doppi tutti i rilasci normali. Puro/testabile.
export function isForcedRestart(req = {}) {
  return req.forceNewDeployment === true && !req.taskDefinition
}

// Evento CloudTrail `UpdateService` → riga per la pagina Deploy, nella stessa forma delle build
// (`provider`/`service`/`status`/`startedAt`), così la vista può mescolarle senza casi speciali.
// Ritorna null se l'evento non è un riavvio forzato. Puro/testabile.
export function restartRow(event = {}) {
  const rec = parse(event.CloudTrailEvent)
  const req = rec.requestParameters ?? {}
  if (!isForcedRestart(req)) return null
  const at = event.EventTime ?? rec.eventTime ?? null
  const arn = rec.userIdentity?.arn ?? null
  return {
    id: `restart:${event.EventId ?? `${req.service}:${at}`}`,
    kind: 'restart',
    provider: 'ecs',
    service: serviceFromEcs(req.service ?? ''),
    cluster: req.cluster ?? null,
    // Un `UpdateService` con errorCode è un tentativo RESPINTO (permessi, servizio inesistente):
    // va mostrato, non nascosto — un restart negato spiega perché il servizio è ancora incastrato.
    status: rec.errorCode ? 'FAILED' : 'SUCCEEDED',
    inProgress: false,
    trigger: 'restart',
    forcedBy: principalName(arn),
    // Persona, pipeline o servizio AWS: nei dati veri i riavvii arrivano quasi tutti da CodeBuild (e' il
    // deploy che fa `update-service`) o da una lambda. Chiamarli «a mano» e' falso, e li contava fra le
    // azioni umane: un numero che esiste per far notare le poche volte in cui qualcuno tocca la produzione.
    actorKind: actorKind(arn),
    viaTeleport: viaTeleportRole(arn),
    startedAt: at,
    endedAt: at,
    durationMs: null,
    commit: null,
    failReason: rec.errorCode ? `${rec.errorCode}${rec.errorMessage ? `: ${rec.errorMessage}` : ''}` : null,
  }
}

// Evento CloudTrail `AuthorizeSecurityGroupIngress` → una porta APERTA a mano su un security group.
// È il break-glass (l'apertura a mano di una porta): serve quando Teleport o IAM sono giù, lascia drift rispetto a
// Terragrunt, e va richiuso. Finora non compariva da nessuna parte, quindi «chi ha aperto cosa e non
// l'ha richiuso» era una domanda senza risposta. Il gemello `Revoke...` è la chiusura: le due righe
// insieme raccontano se la porta è ancora aperta. Puro/testabile.
export function sgRow(event = {}) {
  const rec = parse(event.CloudTrailEvent)
  const req = rec.requestParameters ?? {}
  const at = event.EventTime ?? rec.eventTime ?? null
  const arn = rec.userIdentity?.arn ?? null
  const chiuso = /^Revoke/i.test(rec.eventName ?? event.EventName ?? '')
  // Le regole arrivano in due forme a seconda dell'SDK di chi ha chiamato: si leggono entrambe invece
  // di mostrare «porta ?» a chi ha usato l'altra.
  const set = req.ipPermissions?.items ?? req.ipPermissions ?? []
  const porte = [...new Set((Array.isArray(set) ? set : [set]).map((p) => p?.fromPort).filter((x) => x != null))]
  return {
    id: `sg:${event.EventId ?? `${req.groupId}:${at}`}`,
    kind: chiuso ? 'sg-close' : 'sg-open',
    provider: 'ec2',
    service: req.groupId ?? 'security group',
    cluster: null,
    status: rec.errorCode ? 'FAILED' : 'SUCCEEDED',
    inProgress: false,
    trigger: chiuso ? 'sg-close' : 'sg-open',
    forcedBy: principalName(arn),
    actorKind: actorKind(arn),
    viaTeleport: viaTeleportRole(arn),
    porte,
    startedAt: at,
    endedAt: at,
    durationMs: null,
    commit: null,
    failReason: rec.errorCode ? `${rec.errorCode}${rec.errorMessage ? `: ${rec.errorMessage}` : ''}` : null,
  }
}

// Evento CloudTrail `ExecuteCommand` → una shell APERTA dentro a un container che gira (il wrapper `exec` del dev-env).
// Quella shell vede tutti i segreti del servizio e può cambiare lo stato a mano: è l'azione più
// invasiva che passa da Teleport, e finora non lasciava traccia in nessuna vista. Puro/testabile.
export function execRow(event = {}) {
  const rec = parse(event.CloudTrailEvent)
  const req = rec.requestParameters ?? {}
  const at = event.EventTime ?? rec.eventTime ?? null
  const arn = rec.userIdentity?.arn ?? null
  return {
    id: `exec:${event.EventId ?? `${req.task}:${at}`}`,
    kind: 'exec',
    provider: 'ecs',
    // Il servizio è il CONTAINER in cui si è entrati (`backend`), non il cluster: prendendo il cluster
    // la riga si chiamava col nome dell'ambiente (`acme-production`), quindi sei righe di shell
    // sembravano sei volte la stessa cosa e non si capiva DOVE fosse entrato qualcuno. CloudTrail lo
    // dà in `requestParameters.container`; il cluster resta nel campo suo.
    service: req.container || serviceFromEcs(req.cluster ?? ''),
    cluster: req.cluster ?? null,
    status: rec.errorCode ? 'FAILED' : 'SUCCEEDED',
    inProgress: false,
    trigger: 'exec',
    forcedBy: principalName(arn),
    actorKind: actorKind(arn),
    viaTeleport: viaTeleportRole(arn),
    startedAt: at,
    endedAt: at,
    durationMs: null,
    commit: null,
    failReason: rec.errorCode ? `${rec.errorCode}${rec.errorMessage ? `: ${rec.errorMessage}` : ''}` : null,
  }
}

// Evento CloudTrail `StartBuild` → chi ha premuto, per build. La chiave è l'ARN della build (esatta);
// in fallback l'id, che CloudTrail a volte riporta al posto dell'ARN. Puro/testabile.
export function startEntry(event = {}) {
  const rec = parse(event.CloudTrailEvent)
  if (rec.errorCode) return null // tentativo respinto: nessuna build da attribuire
  const build = rec.responseElements?.build ?? {}
  const key = build.arn || build.id
  if (!key) return null
  const arn = rec.userIdentity?.arn ?? null
  return [key, { forcedBy: principalName(arn), actorKind: actorKind(arn), viaTeleport: viaTeleportRole(arn), hotfix: isHotfixRole(arn) }]
}

// Una lookup per nome-evento. CloudTrail è a 2 TPS per account: una chiamata per evento, cachata.
// Se il cap scatta si TAGLIA la coda del periodo, e allora lo si dice nei log: un troncamento
// silenzioso qui si legge in pagina come "in quei giorni non è successo niente".
async function lookup(aws, eventName, { hours, now }) {
  const ct = new CloudTrailClient(clientOpts(aws))
  const end = new Date(now)
  const start = new Date(now - hours * 3600 * 1000)
  const events = []
  let token
  do {
    const out = await ct.send(
      new LookupEventsCommand({
        LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: eventName }],
        StartTime: start,
        EndTime: end,
        NextToken: token,
      }),
    )
    events.push(...(out.Events ?? []))
    token = out.NextToken
  } while (token && events.length < MAX_EVENTS)
  if (token) log.warn('cloudtrail lookup troncata: il periodo mostrato è più corto di quello chiesto', { eventName, hours, kept: events.length })
  return { events, truncated: Boolean(token) }
}

// Azioni a mano di un account: i riavvii forzati (righe nuove) e chi ha avviato ogni build
// (arricchimento delle righe che già esistono).
//
// Best-effort per scelta: se CloudTrail nega o va in throttle si ritorna vuoto e la pagina mostra
// quello che sa dalle build. Una vista che si spegne perché una fonte secondaria non risponde è
// peggio di una vista incompleta — e questo permesso può mancare su un account appena aggiunto.
export async function manualActions(aws = {}, { hours = LOOKBACK_HOURS, now = Date.now() } = {}) {
  // La chiave contiene identità E regione: CloudTrail è per-regione, e due letture dello stesso
  // account in regioni diverse non sono la stessa risposta. Con la sola identità, l'account senza
  // ruolo né profilo (in cloud: management, che legge in-account) sarebbe finito su una chiave
  // condivisa con qualunque altro nella stessa condizione.
  const key = `manual:${aws.roleArn ?? ''}|${aws.profile ?? ''}|${aws.region ?? ''}:${hours}`
  return cachedCall(key, TTL_MS, async () => {
    try {
      // Quattro lookup, non due: CloudTrail non filtra per due attributi insieme, quindi un evento in
      // più è una chiamata in più. Restano dietro la stessa cache, e il cap di 2 TPS per account vale
      // per tutte: se scatta, `lookup` lo dice nei log invece di accorciare il periodo in silenzio.
      const [updates, starts, sgOpen, sgClose, execs] = await Promise.all([
        lookup(aws, 'UpdateService', { hours, now }),
        lookup(aws, 'StartBuild', { hours, now }),
        lookup(aws, 'AuthorizeSecurityGroupIngress', { hours, now }),
        lookup(aws, 'RevokeSecurityGroupIngress', { hours, now }),
        lookup(aws, 'ExecuteCommand', { hours, now }),
      ])
      return {
        restarts: [
          ...updates.events.map(restartRow),
          ...sgOpen.events.map(sgRow),
          ...sgClose.events.map(sgRow),
          ...execs.events.map(execRow),
        ].filter(Boolean),
        startedBy: new Map(starts.events.map(startEntry).filter(Boolean)),
      }
    } catch (err) {
      // Permesso mancante, throttle, account appena aggiunto: la pagina resta in piedi con le sole
      // build. Ma nei log si dice, altrimenti "nessun riavvio" e "non ho potuto guardare" diventano
      // la stessa cosa — e sono opposte.
      log.warn('azioni a mano non leggibili da CloudTrail: la vista Deploy mostra solo le build', {
        region: aws.region ?? null,
        reason: err?.name ?? String(err),
      })
      return { restarts: [], startedBy: new Map() }
    }
  })
}
