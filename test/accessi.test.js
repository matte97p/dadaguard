import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  avvioStorto,
  digestCorto,
  immagineRiferimento,
  macchinaIndietro,
  tuttiIndietro,
  ritardo,
  dataRiferimento,
  giorniIndietro,
  senzaVersione,
  versioneNota,
} from '../shared/devEnv.js'
import {
  cercaVoce,
  daSistemare,
  destinazioneVista,
  durataFallite,
  filtraRighe,
  inOrdine,
  linkAudit,
  ordinaDatabase,
  ordinaPersone,
  ordinaSsh,
  problemaDatabase,
  problemaPersona,
  problemaSsh,
  proprietariMacchine,
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
  assert.equal(macchine.filter((m) => ritardo(m, rif, null).indietro).length, 0)
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

test('problemi: una riga per lista, e sono gli stessi criteri del pallino e del filtro', () => {
  assert.equal(problemaPersona({ loginFallite: 1 }), true)
  assert.equal(problemaPersona({ loginFallite: 0, query: 900 }), false)
  // Le query su un database di produzione sono il mestiere: e' la SCRITTURA che si guarda.
  assert.equal(problemaDatabase({ scritture: 2, ambiente: 'prod' }), true)
  assert.equal(problemaDatabase({ scritture: 0, ambiente: 'prod', query: 9000 }), false)
  assert.equal(problemaDatabase({ scritture: 9, ambiente: 'staging' }), false)
  assert.equal(problemaSsh({ aperte: 1 }), true)
  assert.equal(problemaSsh({ aperte: 0, sessioni: 40 }), false)
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

// ── La data dell'immagine: «indietro» come ORDINE, non come stima ──────────────────────────────────
//
// ⚠️ E' la correzione strutturale del difetto del 31/08/2026: fra due digest non c'e' un ordine, e
// confrontarli col piu' recente AVVIATO fa eleggere il riferimento dall'orologio. Fra due date l'ordine
// c'e', quindi «indietro di otto giorni» e' vero da solo, anche se nessuno ha la piu' nuova che esiste.
// (Queste regole stanno in shared/devEnv.js dal 07/10/2026: le applica il server per la pagina Flotta.)
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

test('ritardo: la soglia arriva da chi chiama (la config), e il default resta sette giorni', () => {
  const rif = 30 * GIORNO
  assert.equal(ritardo({ creata: ISO(27 * GIORNO) }, VISTA(), rif, 3).indietro, true)
  assert.equal(ritardo({ creata: ISO(27 * GIORNO) }, VISTA(), rif).indietro, false)
})

// ── «Da sistemare»: l'elenco in cima alla pagina Accessi (07/10/2026) ───────────────────────────────

// ⚠️ Il caso del 28/08/2026: un ruolo inesistente nel connector, e tutto il team fuori. Sette righe
// uguali nella tabella di prima; qui una voce sola, con il motivo e la frase «e' la configurazione».
test('daSistemare: le login fallite si raggruppano per MOTIVO, e lo stesso motivo per piu persone e config', () => {
  const motivo = 'role "db-writer" is not found'
  const audit = {
    persone: [
      { utente: 'sam', loginFallite: 3, loginOk: 0, motivo, primaFallita: 1000, ultimaFallita: 5000 },
      { utente: 'kim', loginFallite: 2, loginOk: 0, motivo, primaFallita: 2000, ultimaFallita: 4000 },
      { utente: 'noa', loginFallite: 1, loginOk: 4, motivo: 'access denied: MFA required', primaFallita: 900, ultimaFallita: 900 },
      { utente: 'alex', loginFallite: 0, loginOk: 9 },
    ],
  }
  const voci = daSistemare(audit)
  assert.equal(voci.length, 2)
  const [ruolo, mfa] = voci
  assert.equal(ruolo.motivo, motivo)
  assert.deepEqual(ruolo.chi, ['kim', 'sam'])
  assert.equal(ruolo.quante, 5)
  assert.equal(ruolo.perTutti, true)
  assert.equal(ruolo.ruolo, true)
  assert.equal(ruolo.livello, 'crit')
  assert.deepEqual([ruolo.prima, ruolo.ultima], [1000, 5000])
  // Una persona che ha sbagliato e poi e' entrata: da guardare, non un allarme.
  assert.equal(mfa.livello, 'warn')
  assert.deepEqual(mfa.fuori, [])
})

test('daSistemare: un ruolo che non esiste e urgente anche per una persona sola', () => {
  const [v] = daSistemare({ persone: [{ utente: 'sam', loginFallite: 1, loginOk: 3, motivo: 'role db-team-read is not found' }] })
  assert.equal(v.ruolo, true)
  assert.equal(v.livello, 'crit')
})

test('daSistemare: in ordine di urgenza, e le scritture solo in produzione', () => {
  const audit = {
    persone: [
      { utente: 'noa', loginFallite: 1, loginOk: 4, motivo: 'MFA', ultimaFallita: 10 },
      { utente: 'rin', sessioniDbNegate: 2, negati: [{ dbUser: 'postgres', nome: 'orders', servizio: 'orders-db', quante: 2, ultima: 50 }] },
    ],
    ssh: [{ macchina: 'mac-di-noa', chi: ['rin'], aperte: 1, ultima: 30 }, { macchina: 'mac-chiuso', chi: ['alex'], aperte: 0 }],
    database: [
      { servizio: 'app-prod-db', nome: 'postgres', ambiente: 'prod', scritture: 2, scrittureDati: 2, azioni: [{ etichetta: 'UPDATE', quante: 2 }], scriventi: ['kim'], ultimaScrittura: 40 },
      { servizio: 'app-staging-db', nome: 'postgres', ambiente: 'staging', scritture: 9 },
      { servizio: 'report-prod-db', nome: 'report', ambiente: 'prod', scritture: 3, scrittureDati: 0, scrittureStruttura: 3, scriventi: ['lee'] },
    ],
  }
  const voci = daSistemare(audit, { proprietari: proprietariMacchine({ macchine: [{ macchina: 'mac-di-noa', utente: 'noa' }] }) })
  assert.deepEqual(
    voci.map((v) => `${v.livello}:${v.tipo}`),
    ['crit:ssh', 'crit:scrittura', 'warn:login', 'warn:scrittura', 'warn:negato'],
  )
  const ssh = voci[0]
  assert.deepEqual([ssh.macchina, ssh.chi, ssh.diChi, ssh.suaMacchina], ['mac-di-noa', ['rin'], ['noa'], false])
  assert.equal(voci[1].db, 'postgres')
  assert.deepEqual(voci[1].chi, ['kim'])
  // Solo DDL: gialla, come la riga del canale, e lo dice.
  assert.equal(voci[3].soloStruttura, true)
  assert.deepEqual(voci[4].negati.map((n) => n.dbUser), ['postgres'])
})

test('daSistemare: chi entra sulla PROPRIA macchina e da sapere, non un allarme', () => {
  const [v] = daSistemare(
    { ssh: [{ macchina: 'mac-di-noa', chi: ['noa'], aperte: 1 }] },
    { proprietari: { 'mac-di-noa': ['noa', 'noa-locale'] } },
  )
  assert.equal(v.livello, 'warn')
  assert.equal(v.suaMacchina, true)
  // Senza heartbeat non si sa di chi sia: si resta prudenti.
  assert.equal(daSistemare({ ssh: [{ macchina: 'x', chi: ['noa'], aperte: 1 }] })[0].livello, 'crit')
})

test('daSistemare: niente da sistemare e un elenco vuoto, non un errore', () => {
  assert.deepEqual(daSistemare({}), [])
  assert.deepEqual(daSistemare({ persone: [{ utente: 'a', loginOk: 3 }], database: [{ ambiente: 'prod', scritture: 0 }] }), [])
})

test('inOrdine: chi e gia nominato nell elenco non e anche «in ordine» una riga sotto', () => {
  const audit = {
    persone: [
      { utente: 'kim', loginOk: 3, ultima: 5 },
      { utente: 'alex', loginOk: 9, ultima: 9 },
      { utente: 'sam', loginFallite: 2 },
    ],
    database: [{ nome: 'orders', ambiente: 'prod', scritture: 0, query: 10 }, { nome: 'postgres', ambiente: 'prod', scritture: 1, scriventi: ['kim'] }],
    ssh: [{ macchina: 'a', aperte: 0 }, { macchina: 'b', aperte: 1, chi: ['x'] }],
  }
  const voci = daSistemare(audit)
  const r = inOrdine(audit, voci)
  assert.deepEqual(r.persone.map((p) => p.utente), ['alex'])
  assert.deepEqual(r.database.map((d) => d.nome), ['orders'])
  assert.deepEqual(r.ssh.map((m) => m.macchina), ['a'])
})

test('cercaVoce: la ricerca trova una voce per persona, motivo, macchina o utente del database', () => {
  const voci = daSistemare({
    persone: [{ utente: 'rin', sessioniDbNegate: 1, negati: [{ dbUser: 'dev_readwrite', nome: 'orders', servizio: 'orders-db', quante: 1 }] }],
    ssh: [{ macchina: 'mac-di-noa', chi: ['rin'], aperte: 1 }],
  })
  assert.equal(filtraRighe(voci, { cerca: cercaVoce, query: 'readwrite' }).length, 1)
  assert.equal(filtraRighe(voci, { cerca: cercaVoce, query: 'mac-di' }).length, 1)
  assert.equal(filtraRighe(voci, { cerca: cercaVoce, query: 'rin' }).length, 2)
})

test('destinazioneVista: i link di prima portano dove sta oggi la stessa domanda', () => {
  assert.deepEqual(destinazioneVista('devEnv'), { flotta: '/flotta' })
  assert.deepEqual(destinazioneVista('database'), { ancora: 'scritture' })
  assert.deepEqual(destinazioneVista('persone'), { ancora: 'login' })
  assert.deepEqual(destinazioneVista('chi'), { ancora: 'login' })
  assert.deepEqual(destinazioneVista('ssh'), { ancora: 'ssh' })
  assert.deepEqual(destinazioneVista('mappa'), { ancora: 'chiHaCosa' })
  assert.deepEqual(destinazioneVista('team'), { ancora: 'chiHaCosa' })
  // L'ancora del link nuovo vince, e una vista che non esiste non porta da nessuna parte.
  assert.deepEqual(destinazioneVista('persone', '#scritture'), { ancora: 'scritture' })
  assert.deepEqual(destinazioneVista('inventata'), {})
  assert.deepEqual(destinazioneVista(null, ''), {})
})

test('proprietariMacchine: tutti i nomi visti per macchina, host e container insieme', () => {
  const p = proprietariMacchine({
    macchine: [
      { macchina: 'm1', lato: 'host', utente: 'nome-locale', utenti: ['nome-locale', 'nome-cluster'] },
      { macchina: 'm1', lato: 'container', utente: 'nome-cluster' },
      { macchina: 'm2' },
    ],
  })
  assert.deepEqual(p, { m1: ['nome-locale', 'nome-cluster'], m2: [] })
})
