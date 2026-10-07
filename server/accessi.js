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
import { entroLimiti, tetto } from './finestre.js'
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
  // La finestra e il tetto NON stanno piu' qui: li dichiara `finestre.conf`, che e' l'unico posto
  // dove si decide quanto indietro guarda una chiamata e quante righe puo' scaricare. Prima erano
  // due numeri scritti a mano in questo file e in `teleport.js`, e nessuno dei due lo sapeva
  // dell'altro. Il default e' sceso da 24 ore a 1: questa pagina si apre durante un guasto.
  const finestra = entroLimiti('teleport', ore)
  const cfgSalute = configSalute(cfg)
  const [audit, heartbeat, salute] = await Promise.all([
    conto(accounts, cfg.audit?.account)
      ? cached(`teleport:audit:${finestra}`, 120_000, () =>
          teleport.audit(conto(accounts, cfg.audit?.account), {
            logGroup: cfg.audit?.logGroup,
            ore: finestra,
            limite: tetto('teleport'),
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
    // La salute delle macchine (memoria e OOM della VM, container non sani): 24 ore e non la finestra
    // della pagina, perche' la domanda e' «oggi questa macchina ha finito la memoria?».
    !cfgSalute
      ? null
      : conto(accounts, cfgSalute.account)
        ? cached('teleport:salute', 120_000, () =>
            teleport.salute(conto(accounts, cfgSalute.account), { logGroup: cfgSalute.logGroup, ore: 24 }),
          ).catch((err) => ({ errore: cleanAwsReason(err) }))
        : mancante(cfgSalute.account ?? '?'),
  ])
  return {
    configurato: true,
    webUrl: cfg.webUrl ?? null,
    sshCommand: cfg.sshCommand ?? null,
    auditUserUrl: cfg.auditUserUrl ?? null,
    auditNodeUrl: cfg.auditNodeUrl ?? null,
    audit,
    heartbeat,
    salute,
  }
}

// Dove sta la salute delle macchine. `teleport.salute: { account, logGroup }` se la config la dice;
// altrimenti si ricava dal heartbeat quando il suo log group finisce in `/heartbeat` (la convenzione
// del dev-env: `…/dev-env/heartbeat` e `…/dev-env/salute`, stesso account). Senza nessuno dei
// due la sezione non c'e', e la pagina non mostra un vuoto che sembri «tutto sano».
export function configSalute(cfg = {}) {
  if (cfg?.salute?.logGroup) return { account: cfg.salute.account ?? cfg.heartbeat?.account, logGroup: cfg.salute.logGroup }
  const hb = cfg?.heartbeat
  if (hb?.account && /\/heartbeat$/.test(hb.logGroup ?? '')) {
    return { account: hb.account, logGroup: hb.logGroup.replace(/\/heartbeat$/, '/salute') }
  }
  return null
}

// Le SOGLIE degli allarmi sul dev-env, in config come `teleport.soglieDevEnv` (vedi
// services.example.yaml). Si decidono li' perche' le decide chi legge il canale: il giorno in cui la
// squadra passa a OrbStack, `motoriAmmessi` prende una parola in piu' e il codice non cambia.
//   · giorniIndietro: di quanti giorni l'immagine di una macchina puo' essere piu' vecchia della piu'
//     nuova in giro. Sette come sulla pagina (`GIORNI_INDIETRO` in web/accessi.js): l'immagine si
//     ricostruisce a ogni modifica, e due giorni sono il caso normale.
//   · motoriAmmessi: i motori di Docker supportati. Gli altri hanno un avviso alla settimana.
//   · vmSottoGb: quanti GB sotto l'obiettivo la VM puo' stare. Due, perche' Docker arrotonda e un
//     mezzo GB di differenza fra impostata e vista e' normale.
//   · comandiSulMac: quanti comandi dei repo sul Mac in 24 ore (bloccati + forzati) fanno un avviso.
export const SOGLIE_DEV_ENV = Object.freeze({
  giorniIndietro: 7,
  motoriAmmessi: Object.freeze(['docker-desktop']),
  vmSottoGb: 2,
  comandiSulMac: 10,
})

// ⚠️ Come `calmaMinuti` in watch.js: un valore assente o che non e' un numero tiene il default,
// invece di diventare `0` passando da `Number` (che spegnerebbe la soglia, cioe' il contrario).
export function soglieDevEnv(cfg = {}) {
  const dentro = cfg?.soglieDevEnv ?? {}
  const numero = (v, d) => {
    if (v === null || v === undefined || v === '') return d
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : d
  }
  const motori = Array.isArray(dentro.motoriAmmessi) && dentro.motoriAmmessi.length
    ? dentro.motoriAmmessi.map((m) => String(m).trim().toLowerCase()).filter(Boolean)
    : SOGLIE_DEV_ENV.motoriAmmessi
  return {
    giorniIndietro: numero(dentro.giorniIndietro, SOGLIE_DEV_ENV.giorniIndietro),
    motoriAmmessi: motori,
    vmSottoGb: numero(dentro.vmSottoGb, SOGLIE_DEV_ENV.vmSottoGb),
    comandiSulMac: numero(dentro.comandiSulMac, SOGLIE_DEV_ENV.comandiSulMac),
  }
}

export const ORA_MS = 3_600_000
export const GIORNO_MS = 24 * ORA_MS
export const SETTIMANA_MS = 7 * GIORNO_MS
// Gli avvisi a CADENZA (una volta alla settimana, una volta al giorno) hanno un `quando` che e' l'inizio
// del periodo, non l'istante dell'ultima riga. E' quello che li fa reggere a un rilascio: lo stato del
// watchdog riparte da zero a ogni deploy, il primo giro prende nota del periodo in corso, e la cosa si
// ridice al periodo dopo invece che al giro dopo. Il periodo parte il lunedi' alle 07:00 UTC (le 9 in
// Italia d'estate, le 8 d'inverno), cosi' il promemoria della settimana arriva quando c'e' qualcuno.
const ANCORA_PERIODO = Date.UTC(1970, 0, 5, 7)
export const inizioPeriodo = (adesso, periodoMs) =>
  ANCORA_PERIODO + Math.floor((adesso - ANCORA_PERIODO) / periodoMs) * periodoMs

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
// I nomi di chi ha scritto, per natura. Il conteggio per persona arriva dall'audit: quando manca
// (payload di una versione precedente) si ripiega sull'insieme di tutti gli scriventi del database.
function chiDiNatura(d, natura) {
  const suoi = natura === 'dati' ? d.scriventiDati : d.scriventiStruttura
  if (!suoi) return d.scriventi ?? []
  return Object.keys(suoi).sort()
}

export function segnali(dati = {}, { adesso = Date.now(), soglie = SOGLIE_DEV_ENV } = {}) {
  if (!dati.configurato) return []
  const sg = { ...SOGLIE_DEV_ENV, ...soglie }
  const audit = dati.audit ?? {}
  const battito = dati.heartbeat ?? {}
  const fuori = []
  // La lettura dell'audit ha un tetto (`finestre.conf`, riga `teleport`), e quando lo tocca quello che
  // segue e' un CAMPIONE degli eventi piu' recenti, non la finestra intera. Il conteggio allora dice
  // MENO del vero, e il delta contro il giro prima puo' dire meno ancora, perche' si misura contro un
  // campione diverso. Non si corregge, si DICE: il messaggio scrive «almeno +N». Il 18/09/2026, col
  // tetto a 1500 e una finestra di 24 ore, 776 DDL su produzione sono state annunciate come 324 + 267,
  // e i due numeri sembravano esatti.
  const parziale = Boolean(audit.troncato)

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
    const riga = (natura, quante, quando, azioni, tabelle, oggetti = []) => ({
      chiave: `scrittura-${natura}:${d.servizio}/${d.nome}`,
      tipo: 'scrittura',
      livello: natura === 'dati' ? 'allarme' : 'attenzione',
      natura,
      // Vedi `parziale` qui sopra: viaggia con la riga perche' solo chi scrive il messaggio sa come
      // dirlo, e un numero parziale spacciato per esatto e' peggio di un numero assente.
      parziale,
      ambiente: d.ambiente,
      bersaglio: d.nome && d.nome !== '?' ? d.nome : d.servizio,
      servizio: d.servizio,
      quante,
      azioni,
      tabelle,
      // I nomi degli oggetti toccati dalle DDL (`public.foo`), che stanno a parte dalle tabelle: un
      // `CREATE FUNCTION` non dice su quale tabella ha lavorato, e il suo nome non e' una tabella.
      oggetti,
      utentiDb: d.utentiDb ?? [],
      // I nomi di CHI ha fatto le scritture di QUESTA natura, e quante ne ha fatte ciascuno. Il
      // conteggio non finisce nel messaggio: serve al giro dopo per dire i soli nomi arrivati
      // dall'ultimo messaggio (vedi `chiNuovi`).
      // ⚠️ Se il payload non porta la divisione (rilascio a meta') si ripiega su tutti gli scriventi
      // del database, che e' quello che si diceva prima: un nome in piu' e' meglio di nessun nome.
      chi: chiDiNatura(d, natura),
      chiQuante: (natura === 'dati' ? d.scriventiDati : d.scriventiStruttura) ?? null,
      // TUTTI quelli che hanno scritto nella finestra, non solo i nomi che finiranno nella riga.
      // ⚠️ Serve a riconoscere i login PERSONALI (`dev_tizio`) e a non ridirli fra parentesi: con i
      // soli nomi del delta, il login di chi era fuori dal delta tornava fra gli «estranei», cioe'
      // `da tizio (dev_caio su writer)`, che e' di nuovo il nome sbagliato accanto alla scrittura
      // sbagliata.
      chiTutti: d.scriventi ?? [],
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
      fuori.push(riga('struttura', d.scrittureStruttura, d.ultimaScritturaStruttura ?? d.ultimaScrittura, perTipo('struttura'), [], d.oggettiStruttura ?? []))
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

  // 3b. La STESSA domanda («chi ha il dev-env indietro?»), macchina per macchina e con la data di
  //     costruzione invece del digest. Il 3 qui sopra dice «la versione attesa non ce l'ha nessuno» e
  //     senza `immagineAttesa` in config tace; questo non ha bisogno della config, perche' due date si
  //     ordinano da sole (vedi `dataImmagine` in web/accessi.js, che fa lo stesso conto sulla pagina).
  //     Il riferimento e' la `creata` piu' nuova vista nei sette giorni del heartbeat. Una macchina
  //     senza `creata` (dev-env vecchio) non si accusa. Una volta alla settimana per macchina.
  const creataDi = (m) => {
    const t = Date.parse(String(m?.creata ?? ''))
    return Number.isFinite(t) ? t : null
  }
  const ultimaPerMacchina = new Map()
  for (const m of battito.macchine ?? []) {
    if (!m?.macchina || creataDi(m) == null) continue
    const gia = ultimaPerMacchina.get(m.macchina)
    if (!gia || (m.quando ?? 0) > (gia.quando ?? 0)) ultimaPerMacchina.set(m.macchina, m)
  }
  const creataPiuNuova = Math.max(-Infinity, ...[...ultimaPerMacchina.values()].map(creataDi))
  for (const m of ultimaPerMacchina.values()) {
    const dietroMs = creataPiuNuova - creataDi(m)
    if (!(dietroMs > sg.giorniIndietro * GIORNO_MS)) continue
    fuori.push({
      chiave: `immagine-vecchia:${m.macchina}`,
      tipo: 'immagine-vecchia',
      livello: 'attenzione',
      bersaglio: m.macchina,
      chi: [...(chiLaAvvia.get(m.macchina) ?? [])],
      giorni: Math.floor(dietroMs / GIORNO_MS),
      creata: m.creata,
      quando: inizioPeriodo(adesso, SETTIMANA_MS),
      calmaMs: SETTIMANA_MS,
    })
  }

  // 4. Un guasto del dev-env MAI VISTO prima. E' la riga per cui questo canale esiste: un avvio che non
  //    parte sulla macchina di qualcun altro oggi si scopre solo se quel qualcuno lo racconta.
  //    ⚠️ Una riga per CLASSE e non per macchina: se domani l'immagine nuova rompe l'avvio a tutti e
  //    nove, la notizia e' una sola e nove righe la nasconderebbero.
  const classiDette = new Set()
  for (const g of battito.classiNuove ?? []) {
    // ⚠️ Il dedup sta anche QUI e non solo nella sonda: la chiave e' la classe, e due righe con la
    // stessa chiave sono una riga detta due volte. La sonda gia' raggruppa, ma un payload di una
    // versione precedente puo' arrivare non raggruppato, e la riga doppia si vedrebbe in chat.
    if (classiDette.has(g.classe)) continue
    classiDette.add(g.classe)
    fuori.push({
      chiave: `guasto:${g.classe}`,
      tipo: 'guasto',
      livello: 'attenzione',
      bersaglio: 'dev-env',
      classe: g.classe,
      passo: g.passo ?? null,
      chi: g.utente ? [g.utente] : [],
      macchina: g.macchina ?? null,
      // La riga d'errore arriva gia' ripulita dal dev-env: qui e' quello che fa capire in un secondo
      // se e' roba nostra o del Mac di quella persona.
      dettaglio: g.primaRiga ?? null,
      quando: g.quando ?? null,
    })
  }

  // 5. Una macchina che non parte PIU': due avvii di fila finiti male. Rosso, perche' li' qualcuno non
  //    sta lavorando, e la differenza con la riga qui sopra e' voluta: una dice «c'e' un guasto nuovo»,
  //    l'altra «c'e' una persona ferma», e sono due cose da fare diverse.
  for (const m of battito.bloccate ?? []) {
    fuori.push({
      chiave: `dev-fermo:${m.macchina}/${m.lato ?? '?'}`,
      tipo: 'dev-fermo',
      livello: 'allarme',
      bersaglio: m.macchina,
      classe: m.classe ?? null,
      // ⚠️ `chiLaAvvia` è una Map<macchina, Set>: avvolgere il Set in un array invece di espanderlo
      // stampa `[object Set]` in chat, cioè un allarme rosso che non dice di chi è la macchina.
      chi: [...(chiLaAvvia.get(m.macchina) ?? [])],
      // La riga d'errore ripulita: `porta-occupata` da sola non dice quale porta, e la porta e' la
      // sola cosa su cui chi legge puo' agire.
      dettaglio: m.dettaglio ?? null,
      quando: m.quando ?? null,
    })
  }

  // 6. La VM di Docker ha FINITO LA MEMORIA: il kernel ha ucciso dei processi. E' il guasto che si
  //    vede come «il backend si e' spento da solo» e che nessun log dell'app racconta. Il `quando` e'
  //    l'ultima riga in cui il contatore e' salito, quindi un OOM nuovo riparla e uno vecchio no.
  const salute = dati.salute ?? {}
  for (const m of salute.macchine ?? []) {
    if (!(m.oomNuovi > 0)) continue
    fuori.push({
      chiave: `oom:${m.macchina}`,
      tipo: 'oom',
      livello: 'attenzione',
      bersaglio: m.macchina,
      chi: m.utente ? [m.utente] : [...(chiLaAvvia.get(m.macchina) ?? [])],
      quante: m.oomNuovi,
      vmMemGb: m.vmMemGb ?? null,
      ramMacGb: m.ramMacGb ?? null,
      uccisi: m.uccisiPerMemoria ?? [],
      quando: m.oomQuando ?? m.quando ?? null,
    })
  }

  // 7. Container del dev-env NON SANI per almeno due giri di fila (~15 minuti): uno solo e' un riavvio
  //    in corso. Il `quando` e' l'inizio della serie, quindi la stessa serie si dice una volta sola.
  for (const m of salute.macchine ?? []) {
    if (!(m.nonSaniGiri >= 2)) continue
    fuori.push({
      chiave: `container:${m.macchina}`,
      tipo: 'container',
      livello: 'attenzione',
      bersaglio: m.macchina,
      chi: m.utente ? [m.utente] : [...(chiLaAvvia.get(m.macchina) ?? [])],
      dettaglio: m.nonSani.join(', '),
      giri: m.nonSaniGiri,
      quando: m.nonSaniDa ?? null,
    })
  }

  // Dal 07/10/2026 la riga di salute dice anche il motore di Docker, la memoria che la VM DOVREBBE
  // avere, gli opt-out accesi, l'ultimo doctor e quante volte Claude ha provato a lavorare sul Mac.
  // Ogni campo e' facoltativo: un campo che manca e' «non lo so», e da un «non lo so» non nasce una riga.
  const chiDi = (m) => (m.utente ? [m.utente] : [...(chiLaAvvia.get(m.macchina) ?? [])])
  const settimana = inizioPeriodo(adesso, SETTIMANA_MS)
  for (const m of salute.macchine ?? []) {
    // 8. Un motore di Docker che non e' fra quelli ammessi. Non e' un guasto, e' la causa piu' comune
    //    dei guasti che nessuno sa riprodurre: una volta alla settimana. Dai soli candidati (vedi
    //    `motoreDocker` in teleport.js) si parla quando NESSUNO dei due e' ammesso: «colima o OrbStack»
    //    con OrbStack in elenco non e' un'accusa che si possa fare.
    const candidati = m.motoreCandidati ?? (m.motore ? [m.motore] : [])
    if (candidati.length && !candidati.some((c) => sg.motoriAmmessi.includes(String(c).toLowerCase()))) {
      fuori.push({
        chiave: `motore-non-supportato:${m.macchina}`,
        tipo: 'motore-non-supportato',
        livello: 'info',
        bersaglio: m.macchina,
        chi: chiDi(m),
        motore: m.motore ?? null,
        candidati,
        ammessi: sg.motoriAmmessi,
        quando: settimana,
        calmaMs: SETTIMANA_MS,
      })
    }

    // 9. La VM ha MENO memoria di quella che il dev-env le chiede. `vm_mem_impostata_gb` e' quella
    //    scritta nelle impostazioni; senza, si stima da quella vista dentro la VM piu' mezzo GB, che e'
    //    quanto il kernel della VM si tiene per se'. Senza obiettivo non si confronta niente.
    const impostata = m.vmMemImpostataGb ?? (m.vmMemGb != null ? m.vmMemGb + 0.5 : null)
    const obiettivo = m.vmMemObiettivoGb ?? null
    if (impostata != null && obiettivo != null && obiettivo - impostata >= sg.vmSottoGb) {
      fuori.push({
        chiave: `vm-sotto-obiettivo:${m.macchina}`,
        tipo: 'vm-sotto-obiettivo',
        livello: 'info',
        bersaglio: m.macchina,
        chi: chiDi(m),
        vmGb: Math.round(impostata * 10) / 10,
        stimata: m.vmMemImpostataGb == null,
        obiettivoGb: obiettivo,
        quando: settimana,
        calmaMs: SETTIMANA_MS,
      })
    }

    // 10. Opt-out ACCESI (le variabili `*_NO_*` dell'avvio): ognuno spegne un passo dell'avvio, e un passo
    //     spento da mesi e' un dev-env diverso da quello degli altri. Una volta alla settimana, e
    //     subito se l'insieme cambia: l'`impronta` e' l'elenco ordinato.
    const optOut = [...new Set(m.optOut ?? [])].sort()
    if (optOut.length) {
      fuori.push({
        chiave: `opt-out-attivi:${m.macchina}`,
        tipo: 'opt-out-attivi',
        livello: 'info',
        bersaglio: m.macchina,
        chi: chiDi(m),
        nomi: optOut,
        impronta: optOut.join(','),
        quando: settimana,
        calmaMs: SETTIMANA_MS,
      })
    }

    // 11. Claude continua a lanciare i comandi dei repo SUL MAC invece che nel container: o li ferma
    //     l'hook (`bloccati`), o passano con la variabile di fuga (`forzati`). Dieci in un giorno sono
    //     un'abitudine, o un container che non risponde e una sessione che ripiega. Una volta al giorno.
    const cm = m.comandiMac
    const sulMac = cm ? (cm.bloccati ?? 0) + (cm.forzati ?? 0) : 0
    if (cm && sulMac >= sg.comandiSulMac) {
      fuori.push({
        chiave: `lavoro-sul-mac:${m.macchina}`,
        tipo: 'lavoro-sul-mac',
        livello: 'attenzione',
        bersaglio: m.macchina,
        chi: chiDi(m),
        quante: sulMac,
        bloccati: cm.bloccati ?? 0,
        forzati: cm.forzati ?? 0,
        quando: inizioPeriodo(adesso, GIORNO_MS),
        calmaMs: GIORNO_MS,
      })
    }

    // 12. L'ultimo doctor del dev-env ha dei KO. Il `quando` e' quello del doctor, quindi lo stesso
    //     risultato riportato da cento righe di salute si dice una volta, e un doctor nuovo riparla.
    //     Un doctor di piu' di una settimana fa non e' una notizia, e senza data non si sa se lo e'.
    const d = m.doctor
    const dQuando = Date.parse(String(d?.quando ?? ''))
    if (d && d.ko > 0 && Number.isFinite(dQuando) && adesso - dQuando < SETTIMANA_MS) {
      fuori.push({
        chiave: `doctor-ko:${m.macchina}`,
        tipo: 'doctor-ko',
        livello: 'attenzione',
        bersaglio: m.macchina,
        chi: chiDi(m),
        quante: d.ko,
        falliti: d.falliti ?? [],
        quando: dQuando,
      })
    }
  }

  // 13. La SALUTE MUTA: l'agent del login che manda la riga ogni 15 minuti si e' rotto. Il difficile e'
  //     non scambiarlo per un Mac chiuso, che non manda niente nemmeno lui. La regola, e perche':
  //       · la macchina ha mandato almeno una riga di salute negli ultimi 7 giorni (`ultime`): l'agent
  //         ce l'ha. Senza questa condizione suonerebbe per tutta la flotta finche' il dev-env che lo
  //         ripara non arriva a tutti, e per chi non aggiorna per sempre;
  //       · nessuna riga nelle ultime 24 ore, cosi' un giro saltato (l'agent che si ricarica dopo un
  //         update) non e' un guasto;
  //       · ALTRE macchine le righe le hanno mandate: se tacciono tutte e' il log group o la lettura,
  //         non l'agent di qualcuno;
  //       · e la prova che il Mac era ACCESO: un avvio del dev-env (heartbeat) negli ultimi 3
  //         giorni, DOPO l'ultima riga di salute e da almeno un'ora. Un Mac chiuso non avvia il
  //         dev-env, e un agent sano dopo un avvio manda la sua riga entro 15 minuti.
  //     Il `quando` e' l'ultima riga di salute: lo stesso silenzio si dice una volta sola, e se l'agent
  //     riparte e poi si rompe di nuovo e' un silenzio nuovo.
  const ultime = salute.ultime
  const mandanoOggi = new Set((salute.macchine ?? []).filter((m) => adesso - (m.quando ?? 0) < GIORNO_MS).map((m) => m.macchina))
  if (ultime && typeof ultime === 'object' && mandanoOggi.size > 0) {
    const avvio = new Map()
    for (const m of battito.macchine ?? []) {
      if (!m?.macchina) continue
      avvio.set(m.macchina, Math.max(avvio.get(m.macchina) ?? 0, m.quando ?? 0))
    }
    for (const [macchina, avviata] of avvio) {
      const ultimaSalute = Number(ultime[macchina])
      if (!Number.isFinite(ultimaSalute) || ultimaSalute <= 0) continue
      if (mandanoOggi.has(macchina) || adesso - ultimaSalute < GIORNO_MS) continue
      if (adesso - avviata > 3 * GIORNO_MS || avviata <= ultimaSalute || adesso - avviata < ORA_MS) continue
      fuori.push({
        chiave: `salute-muta:${macchina}`,
        tipo: 'salute-muta',
        livello: 'attenzione',
        bersaglio: macchina,
        chi: [...(chiLaAvvia.get(macchina) ?? [])],
        oreZitta: Math.floor((adesso - ultimaSalute) / ORA_MS),
        oreDallAvvio: Math.floor((adesso - avviata) / ORA_MS),
        quando: ultimaSalute,
      })
    }
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
// Se la lettura da cui e' nato lo stato precedente era TRONCATA. Serve al giro dopo, non a quello che
// l'ha scritta: il delta si misura contro quei totali, e se quelli erano un campione il delta puo'
// dire molto PIU' del vero (campione 324 su 776 veri, poi una lettura completa a 800 → «+476» dove ne
// sono arrivate 24). Senza ricordarlo, l'unico giro che si dichiara parziale e' quello sbagliato.
const precParziale = (v) => (typeof v === 'number' ? false : Boolean(v?.parziale))
// Quante scritture aveva fatto CIASCUNO quando si e' parlato l'ultima volta. Serve a nominare nel
// messaggio i soli nomi di chi ha scritto DA ALLORA: con l'insieme dei nomi non si poteva, e chi
// aveva scritto ore prima tornava in ogni riga accanto a chi aveva appena scritto.
const precChiQuante = (v) => (typeof v === 'number' ? null : (v?.chiQuante ?? null))

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
  // `ripiego`: il numero NON e' quello che e' arrivato, e' la finestra ridetta. Succede quando si
  // sapeva gia' qualcosa e nessuna etichetta e' cresciuta, ed e' l'unico caso in cui il numero puo'
  // dire piu' del vero. Chi scrive il messaggio deve saperlo: «almeno» su un numero che sovrastima e'
  // una bugia nell'altro verso. Il primo messaggio di una chiave non e' un ripiego: li' la finestra
  // e' tutto quello che e' successo.
  if (!cresciute.length) return { azioni: ora, nuove: delta(segnale, prec), ripiego: Boolean(prima) }
  return { azioni: cresciute, nuove: cresciute.reduce((n, a) => n + a.quante, 0), ripiego: false }
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
  // Vedi `precChiQuante`: non serve a questo messaggio, serve al prossimo delta.
  chiQuante: segnale.chiQuante ?? null,
  livello: segnale.livello ?? null,
  // Vedi `precParziale`: non serve a questo messaggio, serve al prossimo delta.
  parziale: Boolean(segnale.parziale),
  // Solo per gli avvisi a cadenza (vedi `calmaDi` e `tenuti`), e solo quando ci sono: la forma dello
  // stato degli altri segnali resta quella di prima.
  ...(segnale.calmaMs != null ? { calmaMs: segnale.calmaMs } : {}),
  ...(segnale.impronta != null ? { impronta: segnale.impronta } : {}),
})

// La calma di un segnale: quella del giro, o la SUA per gli avvisi a cadenza (una settimana, un
// giorno), che sono il passo con cui quella notizia si ripete e non il rumore di una cosa che dura.
const calmaDi = (segnale, calmaMs) => (Number.isFinite(segnale.calmaMs) ? segnale.calmaMs : calmaMs)
// L'insieme che l'avviso descrive e' CAMBIATO (un opt-out in piu', uno in meno): si ridice subito,
// cadenza o no. Un'impronta che prima non c'era non e' un cambio: e' uno stato di una versione prima.
const improntaCambiata = (segnale, prec) =>
  segnale.impronta != null && prec != null && typeof prec === 'object' && prec.impronta != null && prec.impronta !== segnale.impronta

// Le tabelle NUOVE, con lo stesso ripiego delle azioni: se non ce n'è nessuna mai vista prima si
// ridicono quelle della finestra, perché «+3 UPDATE» senza dire su cosa non è una notizia.
// Chi ha scritto DALL'ULTIMO messaggio: le persone il cui conteggio e' cresciuto. Stesso ripiego
// delle azioni e delle tabelle: se nessuno e' cresciuto (succede quando una scrittura vecchia esce
// dalla finestra e una nuova entra) si ridicono i nomi della finestra, perche' «+1 DELETE» senza dire
// da chi non e' una notizia.
// ⚠️ Non si confrontano gli INSIEMI di nomi: chi aveva gia' scritto ieri non risulterebbe mai nuovo,
// ed e' il difetto che questa funzione toglie.
function chiNuovi(segnale, prec) {
  const prima = precChiQuante(prec)
  const ora = segnale.chiQuante ?? null
  const nomi = segnale.chi ?? []
  if (!prima || !ora) return nomi
  const cresciuti = Object.keys(ora).filter((c) => (ora[c] ?? 0) > (prima[c] ?? 0)).sort()
  return cresciuti.length ? cresciuti : nomi
}

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
    const cambiata = improntaCambiata(s, prec)
    const inedito = (s.quando ?? 0) > precQuando(prec) || cambiata
    // Il segnale COM'È ADESSO: quante ne sono arrivate, quali e su cosa. Il colore non si ricalcola:
    // lo porta la chiave, che è per natura.
    const { azioni, nuove, ripiego } = arrivate(s, prec)
    // Quanto ci si puo' fidare del numero, in una parola sola, decisa QUI perche' dipende dai due
    // giri e non da come si scrive la riga. `almeno`: il numero e' un pavimento (campione, ma le
    // etichette cresciute sono crescite vere). `circa`: puo' dire piu' del vero, perche' e' la
    // finestra ridetta oppure perche' si misura contro un campione. `null`: e' esatto.
    const stima = precParziale(prec) ? 'circa' : s.parziale ? (ripiego ? 'circa' : 'almeno') : null
    const adessoDetto = { ...s, nuove, azioni, ripiego, stima, parziale: Boolean(s.parziale) || precParziale(prec), tabelle: tabelleNuove(s, prec), chi: chiNuovi(s, prec) }
    // ⚠️ Per gli avvisi a cadenza la calma la rompe solo un'impronta cambiata, non un nome nuovo: il
    // nome di una macchina arriva dal heartbeat, che a volte manda l'utente di Teleport e a volte
    // quello del Mac, e un avviso settimanale tornerebbe a ogni cambio di nome.
    const rompe = s.calmaMs != null ? cambiata : rompeLaCalma(adessoDetto, prec)
    const zitto = inedito && adesso - precDetto(prec) < calmaDi(s, calmaMs) && !rompe
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
  // ⚠️ Gli avvisi a cadenza RESTANO in stato anche quando un giro non li vede, finche' non e' passata
  // la loro calma. Un giro senza la salute (una lettura fallita, un Mac chiuso per una notte) li
  // toglierebbe, e al giro dopo la stessa macchina sarebbe una chiave mai vista: l'avviso settimanale
  // diventerebbe quotidiano. Gli altri segnali no: lo stato e' quello di ADESSO, come prima.
  for (const [chiave, prec] of Object.entries(statoPrec)) {
    if (chiave in stato || !prec || typeof prec !== 'object' || !Number.isFinite(prec.calmaMs)) continue
    if (adesso - Math.max(precDetto(prec), precQuando(prec)) < prec.calmaMs) stato[chiave] = prec
  }
  return { nuovi, stato }
}
