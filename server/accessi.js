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
          teleport.audit(conto(accounts, cfg.audit?.account), {
            logGroup: cfg.audit?.logGroup,
            ore: finestra,
            // Gli utenti di database che non possono scrivere, DICHIARATI: i loro statement di
            // scrittura sono tentativi, non scritture (vedi `rifiutata` in teleport.js).
            utentiSolaLettura: cfg.utentiSolaLettura ?? [],
          }),
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
  //    DUE segnali per database, non uno: una riga sui DATI dei clienti (`insert`/`update`/`delete`/
  //    `truncate`) e una sulla STRUTTURA (indici, view, grant). Finché la riga era una sola, con il
  //    colore deciso dal totale della finestra, la seconda ha insegnato a ignorare la prima, e poi ha
  //    fatto di peggio: sullo stesso database il colore alternava rosso e giallo a seconda di cosa
  //    fosse ancora dentro alle 24 ore, e una scrittura sui dati nuova poteva finire sotto un titolo
  //    giallo che parlava di indici. Separate, ognuna ha il suo colore per sempre, il suo istante e la
  //    sua calma: un `CREATE INDEX` non fa ripartire la riga rossa, e un `UPDATE` non aspetta che
  //    finisca la calma dei DDL.
  for (const d of audit.database ?? []) {
    if (d.ambiente !== 'prod') continue
    const riga = (natura, quante, quando, azioni, tabelle) => ({
      chiave: `scrittura-${natura}:${d.servizio}/${d.nome}`,
      tipo: 'scrittura',
      livello: natura === 'dati' ? 'allarme' : 'attenzione',
      natura,
      ambiente: d.ambiente,
      bersaglio: d.nome && d.nome !== '?' ? d.nome : d.servizio,
      servizio: d.servizio,
      quante,
      azioni,
      tabelle,
      utentiDb: d.utentiDb ?? [],
      chi: d.scriventi ?? [],
      // Le scritture mandate e rifiutate viaggiano con la riga, ma non ne sono la notizia: nessuna
      // riga NASCE da loro (una scrittura che non e' avvenuta non e' un allarme), e se c'e' gia' una
      // riga si dicono in coda, perche' spiegano il login che non torna.
      tentate: d.tentate ?? 0,
      motiviTentate: d.motiviTentate ?? [],
      quando: quando ?? null,
    })
    // ⚠️ Se la divisione non c'è (payload di una versione precedente, cioè un rilascio a metà) NON si
    // scende di livello: non sapere cosa è stato scritto non è la stessa cosa che sapere che era
    // struttura, e fra i due errori il silenzioso è quello che costa. Una riga sola, rossa, con la
    // chiave di prima.
    if (d.scrittureDati === undefined && d.scrittureStruttura === undefined) {
      if ((d.scritture ?? 0) > 0)
        fuori.push({
          ...riga('dati', d.scritture, d.ultimaScrittura, d.azioni ?? [], d.bersagli ?? []),
          chiave: `scrittura:${d.servizio}/${d.nome}`,
        })
      continue
    }
    // Le azioni si smistano per `tipo`. Senza `tipo` restano fuori da entrambe le righe invece di
    // finire in tutte e due: il conteggio è quello giusto lo stesso (viene da `scrittureDati` e
    // `scrittureStruttura`), e il messaggio dice «statement di scrittura» invece di una cifra falsa.
    const perTipo = (t) => (d.azioni ?? []).filter((a) => a.tipo === t)
    if ((d.scrittureDati ?? 0) > 0)
      fuori.push(riga('dati', d.scrittureDati, d.ultimaScritturaDati ?? d.ultimaScrittura, perTipo('dati'), d.bersagli ?? []))
    if ((d.scrittureStruttura ?? 0) > 0)
      fuori.push(riga('struttura', d.scrittureStruttura, d.ultimaScritturaStruttura ?? d.ultimaScrittura, perTipo('struttura'), []))
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

// Lo stato di un segnale già annunciato: l'istante dell'ultimo evento detto (serve al dedup), QUANTE
// erano allora e CON CHE COSA (servono al delta del giro dopo), e QUANDO lo si è detto (serve alla
// calma). Le vecchie forme (il solo istante, e la coppia istante + quante) si leggono ancora: senza, il
// primo giro dopo un rilascio ridirebbe il totale della finestra come se fosse tutto nuovo.
const precQuando = (v) => (typeof v === 'number' ? v : (v?.quando ?? 0))
const precQuante = (v) => (typeof v === 'number' ? 0 : (v?.quante ?? 0))
const precDetto = (v) => (typeof v === 'number' ? 0 : (v?.detto ?? 0))
const precAzioni = (v) => (typeof v === 'number' ? null : (v?.azioni ?? null))
const precChi = (v) => (typeof v === 'number' ? [] : (v?.chi ?? []))
const precTabelle = (v) => (typeof v === 'number' ? null : (v?.tabelle ?? null))

// Quante ne sono arrivate DALL'ULTIMO messaggio, che è la domanda a cui il totale non risponde: uno
// script che scrive per mezz'ora manda un messaggio ogni cinque minuti, e col totale delle 24h ogni
// messaggio ripete le cifre già lette.
//
// ⚠️ La finestra è mobile: il totale può SCENDERE quando gli eventi vecchi ne escono, e la sottrazione
// darebbe un numero negativo. Quando scende si riparte dal totale: al massimo dice più del vero una
// volta, e non dice mai meno di quello che è appena successo.
function delta(segnale, prec) {
  const prima = precQuante(prec)
  const ora = segnale.quante ?? 0
  return ora > prima ? ora - prima : ora
}

// Le azioni ARRIVATE dall'ultimo messaggio, non quelle della finestra, e QUANTE sono in tutto. È lo
// stesso conto di `delta`, fatto etichetta per etichetta: il 09/09/2026 sette messaggi di fila hanno
// riscritto «9 CREATE FUNCTION, 7 GRANT, +9» accanto a un «+1», cioè il totale delle 24h accanto al
// delta, che è come dire due numeri diversi nella stessa riga e lasciare a chi legge il compito di
// capire quale conta.
//
// ⚠️ Il numero e le azioni escono da QUI tutti e due, e non da due conti diversi. Con `delta()` per il
// numero e questo per le azioni bastava una finestra che scorre (`UPDATE` 15 → 11, `INSERT` 5 → 7) per
// stampare «+18 INSERT» dove gli INSERT arrivati erano 2: il totale scendeva, `delta()` ripiegava sul
// totale della finestra, e l'etichetta accanto era quella del delta. Due misure diverse nella stessa
// riga sono esattamente il difetto che questo giro doveva togliere.
//
// ⚠️ Se il conto non torna (nessuna etichetta è cresciuta, ma l'istante è avanzato: succede quando una
// scrittura vecchia esce dalla finestra e una nuova entra con la stessa etichetta) si ripiega sulla
// finestra, azioni e numero insieme. Meglio ridire una cifra che dire «+3» senza dire di che cosa.
function arrivate(segnale, prec) {
  const prima = precAzioni(prec)
  const ora = segnale.azioni ?? []
  const cresciute = prima
    ? ora.map((a) => ({ ...a, quante: a.quante - (prima[a.etichetta] ?? 0) })).filter((a) => a.quante > 0)
    : []
  if (!cresciute.length) return { azioni: ora, nuove: delta(segnale, prec) }
  return { azioni: cresciute, nuove: cresciute.reduce((n, a) => n + a.quante, 0) }
}

// Le azioni come vanno in stato: `{ etichetta: quante }`, cioè quello che si sa al momento in cui si
// parla. Si scrivono SOLO quando il messaggio parte davvero (vedi sotto), sennò il delta del giro dopo
// si misurerebbe da un messaggio che nessuno ha letto.
const azioniInStato = (segnale) =>
  Object.fromEntries((segnale.azioni ?? []).map((a) => [a.etichetta, a.quante]))

const vocePerStato = (segnale, adesso) => ({
  quando: segnale.quando ?? 0,
  quante: segnale.quante ?? 0,
  detto: adesso,
  azioni: azioniInStato(segnale),
  tabelle: segnale.tabelle ?? [],
  chi: segnale.chi ?? [],
  livello: segnale.livello ?? null,
})

// Le tabelle NUOVE, con lo stesso ripiego delle azioni: se non ce n'è nessuna mai vista prima si
// ridicono quelle della finestra, perché «+3 UPDATE» senza dire su cosa non è una notizia.
function tabelleNuove(segnale, prec) {
  const prima = precTabelle(prec)
  const ora = segnale.tabelle ?? []
  if (!prima) return ora
  const inedite = ora.filter((t) => !prima.includes(t))
  return inedite.length ? inedite : ora
}

// Quanto sta zitto un segnale che continua ad arrivare. Non è un filtro sul rumore: è il passo con cui
// una cosa che DURA (una sessione di migration, un backfill) si racconta. Il giro gira ogni cinque
// minuti, quindi senza calma una mezz'ora di lavoro su un database di produzione sono sei messaggi che
// dicono la stessa cosa con una cifra diversa, e il canale si legge come rumore proprio nei giorni in
// cui c'è qualcosa da leggere. Niente si perde: quello che succede nel silenzio finisce nel messaggio
// dopo, perché il delta si misura dall'ultimo messaggio MANDATO.
export const CALMA_MS = 30 * 60_000

// Quando la calma NON vale: scrive QUALCUNO CHE PRIMA NON C'ERA. «Anche Tizio sta scrivendo in
// produzione» è la riga che fa alzare il telefono, e farla aspettare mezz'ora vuol dire darla quando è
// già finita. Un'azione nuova o una tabella nuova invece NON rompono la calma: durante una migration ne
// arriva una ogni due minuti, e sarebbero di nuovo sei messaggi.
//
// Il passaggio dalla struttura ai dati dei clienti non è più un caso da trattare qui: sono due segnali
// con due chiavi, quindi il primo `UPDATE` è una chiave che non ha mai parlato e parla subito.
function rompeLaCalma(segnale, prec) {
  const gia = new Set(precChi(prec))
  return (segnale.chi ?? []).some((c) => !gia.has(c))
}

// Cosa NON è già stato annunciato, e cosa non è ancora il momento di annunciare. Lo stato è
// `{ chiave: { quando, quante, detto, azioni, chi } }`.
//
// ⚠️ Primo giro (stato assente) → si prende nota e non si annuncia niente. È la stessa scelta del
// watchdog dei servizi, e serve perché su ECS il filesystem del task è effimero: senza, a ogni
// rilascio il canale si riempirebbe di cose vecchie. Il prezzo è che un rilascio può mangiarsi un
// annuncio, e fra i due è il male minore.
//
// ⚠️ Lo stato di un segnale TACIUTO resta quello di prima, intero: se avanzasse, il messaggio dopo
// direbbe «+2» su mezz'ora di scritture, cioè meno di quello che è successo. Tacere è rimandare, non
// buttare.
export function daAnnunciare(segnaliOra = [], statoPrec = null, { adesso = Date.now(), calmaMs = CALMA_MS } = {}) {
  const stato = {}
  if (!statoPrec) {
    // `detto: 0` e non `adesso`: al primo giro non si è detto NIENTE, e datare il silenzio come se
    // fosse un messaggio terrebbe zitto per mezz'ora il primo allarme vero dopo ogni rilascio.
    for (const s of segnaliOra) stato[s.chiave] = { ...vocePerStato(s, adesso), detto: 0 }
    return { nuovi: [], stato }
  }
  const nuovi = []
  for (const s of segnaliOra) {
    const prec = statoPrec[s.chiave]
    const inedito = (s.quando ?? 0) > precQuando(prec)
    // Il segnale COM'È ADESSO: quante ne sono arrivate, quali e su cosa. Il colore non si ricalcola:
    // lo porta la chiave, che è per natura.
    const { azioni, nuove } = arrivate(s, prec)
    const adessoDetto = { ...s, nuove, azioni, tabelle: tabelleNuove(s, prec) }
    const zitto = inedito && adesso - precDetto(prec) < calmaMs && !rompeLaCalma(adessoDetto, prec)
    if (!inedito || zitto) {
      // Niente da dire, oppure non adesso: si tiene quello che c'era. Una chiave sconosciuta che non ha
      // niente di nuovo non esiste (`prec` è undefined solo se `inedito`), quindi il ramo è sicuro.
      stato[s.chiave] = prec ?? vocePerStato(s, adesso)
      continue
    }
    nuovi.push(adessoDetto)
    // ⚠️ In stato vanno i totali della FINESTRA (`s`), non il delta appena detto: il conto del giro
    // dopo si fa contro «quanto ne sapevo quando ho parlato». Con i numeri del delta il messaggio
    // seguente ricomincerebbe da capo a ogni giro.
    stato[s.chiave] = vocePerStato(s, adesso)
  }
  return { nuovi, stato }
}
