// I SEGNALI degli accessi, e il pezzo di codice che li tiene insieme alla pagina.
//
// Due mestieri in un file solo, perché sono due facce dello stesso dato:
//   · `statoAccessi()` compone la risposta di `/api/teleport`. Stava dentro la route, e il watchdog non
//     poteva riusarla: una regola che deve parlare su Slack ha bisogno esattamente di quei numeri.
//   · `segnali()` decide cosa MERITA un messaggio, e `daAnnunciare()` cosa non è già stato detto.
//
// Perché queste tre regole e non altre: gli allarmi sul login esistono già come metric filter sul log
// del cluster (login fallite, ruolo mancante, callback SSO, sessioni DB negate, applicati il
// 29/08/2026). Qui stanno solo le cose che un filtro sul log NON può sapere: il verbo della query
// separato dal suo testo (che non teniamo da nessuna parte), e l'incrocio fra due sorgenti diverse.
import { loadConfig } from './config.js'
import { resolveServices } from './status.js'
import { cached } from './util/ttlcache.js'
import { cleanAwsReason } from './runtime/awsClient.js'
import * as teleport from './teleport.js'

// ⚠️ Le credenziali di un account si compongono dai suoi CAMPI (`roleArn` + `externalId` in cloud,
// `profile` in locale), come fa `awsForAccount` in iam.js.
export const conto = (accounts, nome) => {
  const acc = accounts?.[nome]
  if (!acc) return null
  return { profile: acc.profile, roleArn: acc.roleArn, externalId: acc.externalId, region: acc.region || 'eu-central-1' }
}

const mancante = (nome) => ({
  errore: `account "${nome}" non configurato in accounts: aggiungilo, oppure correggi teleport.*.account`,
})

// La risposta di `/api/teleport`, condivisa fra la pagina e il watchdog. Cache breve: è una vista che
// si guarda durante un guasto, dove due minuti di ritardo sono tanti.
export async function statoAccessi({ ore = 24 } = {}) {
  const { accounts } = await resolveServices()
  const cfg = loadConfig().teleport
  if (!cfg) return { configurato: false }
  const finestra = Math.min(168, Math.max(1, Number(ore) || 24))
  const [audit, heartbeat] = await Promise.all([
    conto(accounts, cfg.audit?.account)
      ? cached(`teleport:audit:${finestra}`, 120_000, () =>
          teleport.audit(conto(accounts, cfg.audit?.account), { logGroup: cfg.audit?.logGroup, ore: finestra }),
        ).catch((err) => ({ errore: cleanAwsReason(err) }))
      : mancante(cfg.audit?.account ?? '?'),
    conto(accounts, cfg.heartbeat?.account)
      ? cached('teleport:heartbeat', 120_000, () =>
          teleport.heartbeat(conto(accounts, cfg.heartbeat?.account), {
            logGroup: cfg.heartbeat?.logGroup,
            immagineAttesa: cfg.heartbeat?.immagineAttesa ?? null,
          }),
        ).catch((err) => ({ errore: cleanAwsReason(err) }))
      : mancante(cfg.heartbeat?.account ?? '?'),
  ])
  return {
    configurato: true,
    webUrl: cfg.webUrl ?? null,
    sshCommand: cfg.sshCommand ?? null,
    auditUserUrl: cfg.auditUserUrl ?? null,
    auditNodeUrl: cfg.auditNodeUrl ?? null,
    audit,
    heartbeat,
  }
}

// Una versione VERA è un digest: la parola con cui l'avvio dichiara di non sapere non è una versione.
const FORMA_DIGEST = /^(?:[a-z0-9]+:)?[A-Fa-f0-9]{12,}$/
const versioneNota = (v) => FORMA_DIGEST.test(String(v ?? '').trim())

// Il proprietario di una macchina, secondo l'heartbeat: chi la avvia. `null` se quella macchina non ha
// mai mandato un avvio, che è un'informazione e non un buco da riempire indovinando.
function proprietari(heartbeat = {}) {
  const mappa = new Map()
  for (const m of heartbeat.macchine ?? []) {
    if (!m?.macchina) continue
    const nomi = m.utenti?.length ? m.utenti : m.utente ? [m.utente] : []
    if (!mappa.has(m.macchina)) mappa.set(m.macchina, new Set())
    for (const n of nomi) mappa.get(m.macchina).add(n)
  }
  return mappa
}

// Cosa merita un messaggio. Puro: prende il payload e torna dei segnali, senza sapere dove finiranno.
//
// Ogni segnale porta una `chiave` stabile (serve al dedup) e un `quando` (l'istante dell'ultimo evento
// che lo giustifica): si annuncia solo quello che è più RECENTE di quanto già detto, sennò una
// scrittura di stamattina tornerebbe a ogni giro per tutta la finestra.
export function segnali(dati = {}) {
  if (!dati.configurato) return []
  const audit = dati.audit ?? {}
  const battito = dati.heartbeat ?? {}
  const fuori = []

  // 1. Scritture su un database di PRODUZIONE. Su staging non si avvisa: è il lavoro di tutti i giorni,
  //    e un canale che parla del lavoro normale si spegne da solo nella testa di chi legge.
  for (const d of audit.database ?? []) {
    if ((d.scritture ?? 0) <= 0 || d.ambiente !== 'prod') continue
    fuori.push({
      chiave: `scrittura:${d.servizio}/${d.nome}`,
      tipo: 'scrittura',
      livello: 'attenzione',
      ambiente: d.ambiente,
      bersaglio: d.nome && d.nome !== '?' ? d.nome : d.servizio,
      servizio: d.servizio,
      quante: d.scritture,
      chi: d.scriventi ?? [],
      quando: d.ultimaScrittura ?? null,
    })
  }

  // 2. Una sessione SSH APERTA su una macchina che non è di chi è entrato. La macchina dice chi la
  //    avvia (heartbeat), l'audit dice chi c'è entrato: l'incrocio esiste solo qui.
  const chiLaAvvia = proprietari(battito)
  for (const m of audit.ssh ?? []) {
    if ((m.aperte ?? 0) <= 0) continue
    const suoi = chiLaAvvia.get(m.macchina) ?? null
    const estranei = (m.chi ?? []).filter((c) => !suoi || !suoi.has(c))
    // Nessun estraneo: è entrato sulla propria macchina, e non è una notizia.
    if (suoi && estranei.length === 0) continue
    fuori.push({
      chiave: `ssh:${m.macchina}`,
      tipo: 'ssh',
      livello: 'allarme',
      bersaglio: m.macchina,
      chi: estranei.length ? estranei : (m.chi ?? []),
      diChi: suoi ? [...suoi] : [],
      aperte: m.aperte,
      quando: m.ultima ?? null,
    })
  }

  // 3. La versione attesa non ce l'ha NESSUNO: si può dire solo con la versione attesa in config, e
  //    senza quella non si accusa nessuno (il ripiego eleggerebbe il riferimento con l'orologio).
  const attesa = battito.attesa ?? null
  const conVersione = (battito.macchine ?? []).filter((m) => versioneNota(m.immagine))
  if (attesa && conVersione.length > 0 && conVersione.every((m) => m.immagine !== attesa)) {
    fuori.push({
      chiave: `versione:${attesa}`,
      tipo: 'versione',
      livello: 'attenzione',
      bersaglio: 'dev-env',
      quante: conVersione.length,
      // Costante di proposito: la notizia e' «la versione attesa non ce l'ha nessuno», e non cambia
      // perche' qualcuno ha riavviato il suo dev-env. Cambia quando cambia l'attesa, e allora cambia
      // la chiave. Con l'istante dell'ultimo avvio si sarebbe ripetuta a ogni avvio di chiunque.
      quando: 1,
    })
  }

  return fuori
}

// Cosa NON è già stato annunciato. Lo stato è `{ chiave: quando }`.
//
// ⚠️ Primo giro (stato assente) → si prende nota e non si annuncia niente. È la stessa scelta del
// watchdog dei servizi, e serve perché su ECS il filesystem del task è effimero: senza, a ogni
// rilascio il canale si riempirebbe di cose vecchie. Il prezzo è che un rilascio può mangiarsi un
// annuncio, e fra i due è il male minore.
export function daAnnunciare(segnaliOra = [], statoPrec = null) {
  const stato = {}
  for (const s of segnaliOra) stato[s.chiave] = s.quando ?? 0
  if (!statoPrec) return { nuovi: [], stato }
  const nuovi = segnaliOra.filter((s) => (s.quando ?? 0) > (statoPrec[s.chiave] ?? 0))
  return { nuovi, stato }
}
