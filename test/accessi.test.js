import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  avvioStorto,
  daGuardare,
  digestCorto,
  durataFallite,
  filtraRighe,
  immagineRiferimento,
  linkAudit,
  macchinaIndietro,
  ordinaDatabase,
  ordinaMacchine,
  ordinaPersone,
  ordinaSsh,
  problemaDatabase,
  problemaMacchina,
  problemaPersona,
  problemaSsh,
  tuttiIndietro,
  personaMacchina,
  riepilogo,
  ritardo,
  dataRiferimento,
  giorniIndietro,
  senzaVersione,
  versioneNota,
} from '../web/accessi.js'

// Digest VERI nella forma (`algo:esadecimale`): con fixture tipo 'sha256:vecchia' le prove passavano
// e il codice sbagliava, perché nessuna assomigliava a quello che manda l'heartbeat.
const NUOVA = 'sha256:45486f792f3f0f2a7d8ad363b7b72528945a2868c0316ca3079e8bb2ee970c7c'
const VECCHIA = 'sha256:36b245a818c0f6b370feb916fca1374e0064c3b8b58f7698715e791d15afe2fc'
const ATTESA = 'sha256:9b0e73d4a1c86f52e7d09a4b31c5f860aa11bb22cc33dd44ee55ff6600112233'
const CONFIG = (immagine = ATTESA) => ({ immagine, fonte: 'config' })
const VISTA = (immagine = NUOVA) => ({ immagine, fonte: 'vista' })

// Le regole della pagina Accessi. Stavano dentro il componente, dove si potevano leggere e non
// provare: sono quelle che decidono cosa una persona guarda per PRIMA durante un guasto, quindi sono
// anche quelle che non devono cambiare per sbaglio al primo ritocco della tabella.

test('digestCorto: via il prefisso dell algoritmo, che su ogni riga e identico', () => {
  assert.equal(digestCorto('sha256:45486f792f3f2a1b9c8d'), '45486f792f3f')
  assert.equal(digestCorto('45486f792f3f2a1b9c8d'), '45486f792f3f')
  assert.equal(digestCorto(null), '')
})

// ⚠️ L'heartbeat manda anche la parola con cui dichiara di NON sapere («sconosciuta»), e sui dati veri
// del 31/08/2026 c'era: trattarla come una versione la fa entrare nel conteggio delle «versioni in
// giro» e fa marcare «indietro» una macchina che sta solo senza il dato.
test('versioneNota: una versione e un digest, non una parola', () => {
  assert.equal(versioneNota(NUOVA), true)
  assert.equal(versioneNota('45486f792f3f0f2a'), true)
  assert.equal(versioneNota('sconosciuta'), false)
  assert.equal(versioneNota(''), false)
  assert.equal(versioneNota(null), false)
  // Mezza parola non e' mezza versione: si mostra «non dichiarata», non 'sconosciut'.
  assert.equal(digestCorto('sconosciuta'), '')
  assert.equal(senzaVersione({ immagine: 'sconosciuta' }), true)
  assert.equal(senzaVersione({ immagine: NUOVA }), false)
})

test('immagineRiferimento: senza versione attesa si usa l avvio piu RECENTE, non il primo dell elenco', () => {
  const macchine = [
    { macchina: 'a', immagine: VECCHIA, quando: 1000 },
    { macchina: 'b', immagine: NUOVA, quando: 9000 },
  ]
  assert.deepEqual(immagineRiferimento(macchine), { immagine: NUOVA, fonte: 'vista' })
})

test('immagineRiferimento: una versione non dichiarata non diventa il riferimento', () => {
  const macchine = [
    { macchina: 'a', immagine: NUOVA, quando: 1000 },
    { macchina: 'b', immagine: 'sconosciuta', quando: 9000 },
  ]
  assert.deepEqual(immagineRiferimento(macchine), { immagine: NUOVA, fonte: 'vista' })
})

// ⚠️ La funzione non deve dipendere dall'ordine di chi la chiama: il server oggi ordina per `quando`
// decrescente, ma una regola che si appoggia a quell'ordine si rompe in silenzio il giorno che cambia.
test('immagineRiferimento: l ordine dell elenco non conta', () => {
  const giu = [
    { immagine: NUOVA, quando: 9000 },
    { immagine: VECCHIA, quando: 1000 },
  ]
  assert.equal(immagineRiferimento(giu).immagine, immagineRiferimento([...giu].reverse()).immagine)
})

test('immagineRiferimento: la versione attesa dalla config vince, e lo dice', () => {
  const macchine = [{ immagine: VECCHIA, quando: 9000 }]
  assert.deepEqual(immagineRiferimento(macchine, ATTESA), { immagine: ATTESA, fonte: 'config' })
})

test('immagineRiferimento: nessuna macchina non inventa un riferimento', () => {
  assert.deepEqual(immagineRiferimento([]), { immagine: null, fonte: 'vista' })
  assert.deepEqual(immagineRiferimento([{ macchina: 'a', quando: 1 }]), { immagine: null, fonte: 'vista' })
})

test('macchinaIndietro: si accusa solo con la versione ATTESA dalla config in mano', () => {
  assert.equal(macchinaIndietro({ immagine: VECCHIA }, CONFIG()), true)
  assert.equal(macchinaIndietro({ immagine: ATTESA }, CONFIG()), false)
  // Col ripiego («la piu' recente vista») non si accusa nessuno, e non si mette nemmeno un'etichetta:
  // che i digest siano diversi si vede dai digest, e sei etichette «diversa» direbbero solo «non lo
  // sappiamo» su ogni riga.
  assert.equal(macchinaIndietro({ immagine: VECCHIA }, VISTA()), false)
  // Senza riferimento, o senza versione sulla riga, non si e' «indietro»: si e' senza dato.
  assert.equal(macchinaIndietro({ immagine: VECCHIA }, null), false)
  assert.equal(macchinaIndietro({ immagine: 'sconosciuta' }, CONFIG()), false)
  assert.equal(macchinaIndietro({}, CONFIG()), false)
})

// ⚠️ REGRESSIONE dai dati veri del 31/08/2026. Cinque macchine, cinque digest diversi: alle 12:37 una
// aveva avviato l'immagine pubblicata DOPO, alle 12:42 un'altra quella pubblicata PRIMA. Il ripiego
// elegge il riferimento con l'orologio, quindi la seconda diventava il riferimento e la prima veniva
// marcata «indietro» pur avendo la piu' nuova: quattro righe su cinque accusate da un ordine di avvio.
test('macchinaIndietro: il ripiego non accusa, perche eleggerebbe il riferimento con l orologio', () => {
  const macchine = [
    { macchina: 'stefano', immagine: VECCHIA, quando: 1237 }, // ha avviato prima, immagine piu' nuova
    { macchina: 'gabriele', immagine: NUOVA, quando: 1242 }, // ha avviato dopo, immagine piu' vecchia
  ]
  const rif = immagineRiferimento(macchine)
  assert.equal(rif.fonte, 'vista')
  assert.equal(macchine.filter((m) => macchinaIndietro(m, rif)).length, 0)
  assert.equal(macchine.filter((m) => problemaMacchina(m, rif)).length, 0)
})

// Il buco che il ripiego non puo' vedere: se la versione attesa la sa la config e non ce l'ha nessuno,
// sono indietro TUTTI, mentre «la piu' nuova che qualcuno ha visto» direbbe che vanno tutti bene.
test('tuttiIndietro: con la versione attesa dalla config, nessuno che la ha vuol dire tutti indietro', () => {
  const macchine = [{ immagine: VECCHIA }, { immagine: VECCHIA }]
  assert.equal(tuttiIndietro(macchine, CONFIG()), true)
  assert.equal(tuttiIndietro(macchine, CONFIG(VECCHIA)), false)
  // Macchine senza il dato non contano ne' da una parte ne' dall'altra.
  assert.equal(tuttiIndietro([{ immagine: 'sconosciuta' }], CONFIG()), false)
})

test('tuttiIndietro: senza versione attesa la domanda non si pone, e non si risponde si per prudenza', () => {
  assert.equal(tuttiIndietro([{ immagine: VECCHIA }], VISTA(VECCHIA)), false)
  assert.equal(tuttiIndietro([{ immagine: VECCHIA }], null), false)
  assert.equal(tuttiIndietro([], CONFIG()), false)
})

test('avvioStorto: solo un esito DIVERSO da ok, e il campo assente non e un problema inventato', () => {
  assert.equal(avvioStorto({ esito: 'parziale' }), true)
  assert.equal(avvioStorto({ esito: 'ok' }), false)
  assert.equal(avvioStorto({}), false)
})

test('problemi: una riga per tabella, e sono gli stessi criteri del pallino e del filtro', () => {
  assert.equal(problemaPersona({ loginFallite: 1 }), true)
  assert.equal(problemaPersona({ loginFallite: 0, query: 900 }), false)
  // Le query su un database di produzione sono il mestiere: e' la SCRITTURA che si guarda.
  assert.equal(problemaDatabase({ scritture: 2, ambiente: 'prod' }), true)
  assert.equal(problemaDatabase({ scritture: 0, ambiente: 'prod', query: 9000 }), false)
  assert.equal(problemaDatabase({ scritture: 9, ambiente: 'staging' }), false)
  assert.equal(problemaSsh({ aperte: 1 }), true)
  assert.equal(problemaSsh({ aperte: 0, sessioni: 40 }), false)
})

test('problemaMacchina: indietro (solo con la config), tool mancanti o avvio storto', () => {
  assert.equal(problemaMacchina({ immagine: VECCHIA }, CONFIG()), true)
  // Col ripiego una versione diversa NON e' un problema di quella macchina.
  assert.equal(problemaMacchina({ immagine: VECCHIA }, VISTA()), false)
  assert.equal(problemaMacchina({ immagine: NUOVA, toolMancanti: 2 }, VISTA()), true)
  assert.equal(problemaMacchina({ immagine: NUOVA, esito: 'parziale' }, VISTA()), true)
  assert.equal(problemaMacchina({ immagine: NUOVA, toolMancanti: 0, esito: 'ok' }, VISTA()), false)
})

test('ordina*: prima le righe con un problema, poi le piu recenti', () => {
  const persone = [
    { utente: 'a', loginFallite: 0, ultima: 9000 },
    { utente: 'b', loginFallite: 2, ultima: 1000 },
    { utente: 'c', loginFallite: 0, ultima: 5000 },
  ]
  assert.deepEqual(ordinaPersone(persone).map((p) => p.utente), ['b', 'a', 'c'])

  const db = [
    { nome: 'x', query: 900, scritture: 0, ambiente: 'prod' },
    { nome: 'y', query: 3, scritture: 1, ambiente: 'prod' },
    { nome: 'z', query: 400, scritture: 0, ambiente: 'staging' },
  ]
  assert.deepEqual(ordinaDatabase(db).map((d) => d.nome), ['y', 'x', 'z'])

  const ssh = [
    { macchina: 'a', aperte: 0, ultima: 9000 },
    { macchina: 'b', aperte: 1, ultima: 100 },
  ]
  assert.deepEqual(ordinaSsh(ssh).map((m) => m.macchina), ['b', 'a'])

  const macchine = [
    { macchina: 'pari', immagine: ATTESA, quando: 9000 },
    { macchina: 'indietro', immagine: VECCHIA, quando: 100 },
  ]
  assert.deepEqual(ordinaMacchine(macchine, CONFIG()).map((m) => m.macchina), ['indietro', 'pari'])
  // Col ripiego nessuno e' «indietro», quindi l'ordine e' quello delle date.
  assert.deepEqual(ordinaMacchine(macchine, VISTA(ATTESA)).map((m) => m.macchina), ['pari', 'indietro'])
})

test('ordina*: non modificano l elenco che ricevono', () => {
  const persone = [
    { utente: 'a', loginFallite: 0, ultima: 1 },
    { utente: 'b', loginFallite: 3, ultima: 2 },
  ]
  ordinaPersone(persone)
  assert.deepEqual(persone.map((p) => p.utente), ['a', 'b'])
})

test('filtraRighe: la ricerca guarda solo i campi che la vista dichiara', () => {
  const righe = [
    { utente: 'alex', motivo: null, segreto: 'sam' },
    { utente: 'sam', motivo: 'MFA required', segreto: null },
  ]
  const cerca = (r) => [r.utente, r.motivo]
  assert.deepEqual(filtraRighe(righe, { cerca, query: 'sam' }).map((r) => r.utente), ['sam'])
  assert.deepEqual(filtraRighe(righe, { cerca, query: 'mfa' }).map((r) => r.utente), ['sam'])
  assert.deepEqual(filtraRighe(righe, { cerca, query: '  ' }).length, 2)
})

test('filtraRighe: «solo da guardare» e la ricerca si sommano', () => {
  const righe = [
    { utente: 'alex', loginFallite: 0 },
    { utente: 'sam', loginFallite: 3 },
    { utente: 'noa', loginFallite: 1 },
  ]
  const opts = { problema: problemaPersona, cerca: (r) => [r.utente] }
  assert.deepEqual(filtraRighe(righe, { ...opts, soloProblemi: true }).map((r) => r.utente), ['sam', 'noa'])
  assert.deepEqual(filtraRighe(righe, { ...opts, soloProblemi: true, query: 'no' }).map((r) => r.utente), ['noa'])
})

test('daGuardare: zero solo quando non c e davvero niente', () => {
  assert.equal(daGuardare({}, {}), 0)
  assert.equal(daGuardare({ loginFallite: 2 }, {}), 2)
  assert.equal(daGuardare({ sshAperte: 1 }, {}), 1)
  assert.equal(daGuardare({}, { conToolMancanti: 3 }), 3)
  // Una sola versione in giro non e' un problema; due si.
  assert.equal(daGuardare({}, { versioni: [{ immagine: 'a', quante: 5 }] }), 0)
  assert.equal(daGuardare({}, { versioni: [{ immagine: 'a' }, { immagine: 'b' }] }), 1)
  // E «sono indietro tutti» conta anche quando in giro c'e' una versione sola.
  const heartbeat = { versioni: [{ immagine: VECCHIA, quante: 2 }], macchine: [{ immagine: VECCHIA }] }
  assert.equal(daGuardare({}, heartbeat, CONFIG()), 1)
})

test('durataFallite: tre fallite in due minuti e tre in un giorno non sono lo stesso guasto', () => {
  assert.equal(durataFallite({ loginFallite: 3, primaFallita: 1000, ultimaFallita: 121_000 }), 120_000)
  // Una sola fallita non ha una durata: non e' zero, non c'e'.
  assert.equal(durataFallite({ loginFallite: 1, primaFallita: 1000, ultimaFallita: 1000 }), null)
  // Server di una versione precedente: i due istanti non arrivano, e non si inventa una durata.
  assert.equal(durataFallite({ loginFallite: 4 }), null)
  assert.equal(durataFallite(null), null)
})

test('linkAudit: senza modello nella config il link non c e, e il valore si scappa', () => {
  assert.equal(linkAudit(null, 'utente', 'alex'), null)
  assert.equal(linkAudit('https://x/audit?u={utente}', 'utente', null), null)
  // Modello che non contiene il segnaposto: meglio nessun link che un link identico per ogni riga.
  assert.equal(linkAudit('https://x/audit', 'utente', 'alex'), null)
  assert.equal(linkAudit('https://x/audit?u={utente}', 'utente', 'a b'), 'https://x/audit?u=a%20b')
  assert.equal(linkAudit('https://x/{macchina}/a/{macchina}', 'macchina', 'm1'), 'https://x/m1/a/m1')
})

// ⚠️ Dai dati veri del 31/08/2026, su due macchine su cinque: l'utente del cluster e quello del
// portatile, che non si somigliano. Sono la stessa persona, e quale nome finiva in tabella
// dipendeva da se l'ultimo avvio aveva trovato una sessione Teleport aperta.
test('personaMacchina: fra due nomi della stessa persona vince quello che Teleport conosce', () => {
  const m = { utente: 'nome-locale', utenti: ['nome-locale', 'nome-cluster'] }
  const noti = new Set(['nome-cluster', 'altra-persona'])
  assert.deepEqual(personaMacchina(m, noti), { nome: 'nome-cluster', altri: ['nome-locale'] })
})

test('personaMacchina: se Teleport non ne conosce nessuno resta quello dell ultimo avvio', () => {
  const m = { utente: 'nome-locale', utenti: ['nome-locale', 'altro-nome-locale'] }
  assert.deepEqual(personaMacchina(m, new Set()), { nome: 'nome-locale', altri: ['altro-nome-locale'] })
  // Heartbeat di una versione precedente, senza l'elenco: si usa il nome che c'e'.
  assert.deepEqual(personaMacchina({ utente: 'nome-locale' }, new Set()), { nome: 'nome-locale', altri: [] })
  assert.deepEqual(personaMacchina({}, new Set()), { nome: null, altri: [] })
})

// ⚠️ Il caso di TUTTI i giorni, preso dai dati veri del 31/08/2026: niente login fallite, niente
// sessioni aperte, niente tool mancanti, e le uniche due cose vere sono delle scritture e le versioni
// in giro. Prima la pagina metteva cinque numeri grandi in fila, tre spenti, e per sapere cosa fossero
// le «6 scritture» bisognava aprire due tabelle e incrociarle a mano.
test('riepilogo: dice DOVE sono andate le scritture, e manda gli zeri fra le cose a posto', () => {
  const audit = {
    loginFallite: 0,
    sshAperte: 0,
    scritture: 6,
    database: [
      { nome: 'postgres', servizio: 'app-staging-db', ambiente: 'staging', scritture: 2 },
      { nome: 'orders', servizio: 'orders-prod-db-ro', ambiente: 'prod', scritture: 4 },
    ],
  }
  const { trovato, tranquillo } = riepilogo(audit, { conToolMancanti: 0, versioni: [{}, {}], macchine: [] }, VISTA())
  assert.equal(trovato.length, 1)
  // Fra i database che hanno scritture si nominano quelli di PRODUZIONE, non tutti.
  // ⚠️ Il numero e' quello dei database NOMINATI, non il totale della finestra: con 4 su produzione e
  // 2 su staging, «6 scritture su <produzione>» sarebbe falso due volte. Le altre si dicono in coda.
  assert.deepEqual(trovato[0], { k: 'scritture', n: 4, dove: ['orders'], prod: true, altrove: 1, vista: 'database' })
  // Sei versioni in giro non sono «a posto»: da qui non si sa, e lo dice l'avviso, non la riga muta.
  assert.deepEqual(tranquillo.map((v) => v.k), ['fallite', 'sshAperte', 'tool'])
})

test('riepilogo: le versioni in giro non sono «da guardare» senza la versione attesa', () => {
  const hb = { versioni: [{}, {}, {}], macchine: [{ immagine: VECCHIA }] }
  const senzaAttesa = riepilogo({}, hb, VISTA())
  assert.equal(senzaAttesa.trovato.length, 0)
  // E nemmeno «a posto»: tre versioni in giro non sono una cosa a posto, sono una cosa non sapibile.
  assert.equal(senzaAttesa.tranquillo.some((v) => v.k === 'versioni'), false)
  // Con la versione attesa dalla config diventano un fatto, e allora salgono.
  const conConfig = riepilogo({}, hb, CONFIG())
  // La voce si chiama «indietro» e non «versioni»: e' il fatto contabile (quante macchine), non la
  // statistica (quante versioni in giro), che e' una cosa su cui non si agisce.
  assert.deepEqual(conConfig.trovato.map((v) => v.k), ['indietro'])
  assert.equal(conConfig.trovato[0].tutti, true)
  assert.equal(conConfig.trovato[0].n, 1)
})

test('riepilogo: la giornata in cui non c e niente non lascia la riga vuota', () => {
  const { trovato, tranquillo } = riepilogo({ loginFallite: 0, sshAperte: 0, database: [] }, {}, VISTA())
  assert.equal(trovato.length, 0)
  // Con UNA versione sola (o nessuna) la riga muta la nomina, perche' li' e' davvero un a posto.
  // Cinque famiglie guardate e tutte a zero: e' una risposta, e va scritta come tale invece di
  // lasciare la riga vuota.
  assert.deepEqual(tranquillo.map((v) => v.k), ['fallite', 'sshAperte', 'scritture', 'tool', 'versioni'])
})

test('riepilogo: ordina per urgenza, chi non entra prima di chi ha scritto', () => {
  const audit = {
    loginFallite: 3,
    sshAperte: 1,
    scritture: 2,
    database: [{ nome: 'x', ambiente: 'prod', scritture: 2 }],
  }
  const { trovato } = riepilogo(audit, { conToolMancanti: 4 }, VISTA())
  assert.deepEqual(trovato.map((v) => v.k), ['fallite', 'sshAperte', 'scritture', 'tool'])
})

// ── La data dell'immagine: «indietro» come ORDINE, non come stima ──────────────────────────────────
//
// ⚠️ E' la correzione strutturale del difetto del 31/08/2026: fra due digest non c'e' un ordine, e
// confrontarli col piu' recente AVVIATO fa eleggere il riferimento dall'orologio. Fra due date l'ordine
// c'e', quindi «indietro di otto giorni» e' vero da solo, anche se nessuno ha la piu' nuova che esiste.
const GIORNO = 86_400_000
const ISO = (ms) => new Date(ms).toISOString()

test('dataRiferimento: e il massimo delle date viste, e ignora chi non la manda', () => {
  const macchine = [
    { macchina: 'a', creata: ISO(10 * GIORNO) },
    { macchina: 'b', creata: ISO(30 * GIORNO) },
    { macchina: 'c' },
    { macchina: 'd', creata: 'sconosciuta' },
  ]
  assert.equal(dataRiferimento(macchine), 30 * GIORNO)
  assert.equal(dataRiferimento([{ macchina: 'a' }]), null)
  assert.equal(dataRiferimento([]), null)
})

test('giorniIndietro: giorni interi, e null quando una delle due date manca', () => {
  const rif = 30 * GIORNO
  assert.equal(giorniIndietro({ creata: ISO(22 * GIORNO) }, rif), 8)
  assert.equal(giorniIndietro({ creata: ISO(30 * GIORNO) }, rif), 0)
  // Sotto le 24 ore non e' «indietro»: e' la stessa immagine ricostruita.
  assert.equal(giorniIndietro({ creata: ISO(30 * GIORNO - 3600_000) }, rif), 0)
  assert.equal(giorniIndietro({}, rif), null)
  assert.equal(giorniIndietro({ creata: ISO(1 * GIORNO) }, null), null)
})

test('ritardo: sette giorni e la soglia, e sotto non si accusa nessuno', () => {
  const rif = 30 * GIORNO
  assert.equal(ritardo({ creata: ISO(22 * GIORNO) }, VISTA(), rif).indietro, true)
  assert.equal(ritardo({ creata: ISO(24 * GIORNO) }, VISTA(), rif).indietro, false)
  assert.equal(ritardo({ creata: ISO(23 * GIORNO) }, VISTA(), rif).giorni, 7)
  assert.equal(ritardo({ creata: ISO(23 * GIORNO) }, VISTA(), rif).indietro, true)
  // Senza date non si accusa: e' il caso di chi non ha ancora aggiornato l'avvio.
  assert.equal(ritardo({ immagine: VECCHIA }, VISTA(), null).indietro, false)
  // La versione attesa dalla config resta la forma piu' forte: accusa anche a un giorno di distanza.
  assert.equal(ritardo({ immagine: VECCHIA, creata: ISO(29 * GIORNO) }, CONFIG(), rif).indietro, true)
})

test('problemaMacchina: una macchina indietro di piu di una settimana e un problema', () => {
  const rif = 30 * GIORNO
  assert.equal(problemaMacchina({ immagine: NUOVA, creata: ISO(20 * GIORNO) }, VISTA(), rif), true)
  assert.equal(problemaMacchina({ immagine: NUOVA, creata: ISO(29 * GIORNO) }, VISTA(), rif), false)
})

test('riepilogo: con le date dice quante macchine sono indietro e di quanto', () => {
  const macchine = [
    { macchina: 'a', immagine: NUOVA, creata: ISO(30 * GIORNO) },
    { macchina: 'b', immagine: VECCHIA, creata: ISO(20 * GIORNO) },
    { macchina: 'c', immagine: VECCHIA, creata: ISO(18 * GIORNO) },
  ]
  const { trovato, tranquillo } = riepilogo({}, { macchine, versioni: [{}, {}] }, VISTA())
  const voce = trovato.find((v) => v.k === 'indietro')
  assert.deepEqual({ n: voce.n, giorni: voce.giorni }, { n: 2, giorni: 12 })
  assert.equal(tranquillo.some((v) => v.k === 'indietro'), false)
})

test('riepilogo: nessuno indietro e un a posto VERO, e si puo dire', () => {
  const macchine = [
    { macchina: 'a', immagine: NUOVA, creata: ISO(30 * GIORNO) },
    { macchina: 'b', immagine: VECCHIA, creata: ISO(29 * GIORNO) },
  ]
  const { trovato, tranquillo } = riepilogo({}, { macchine, versioni: [{}, {}] }, VISTA())
  assert.equal(trovato.some((v) => v.k === 'indietro'), false)
  assert.deepEqual(tranquillo.find((v) => v.k === 'indietro'), { k: 'indietro', n: 0, vista: 'devEnv' })
})
