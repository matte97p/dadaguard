import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segnali, daAnnunciare, CALMA_MS } from '../server/accessi.js'
import { messaggioAccessi } from '../server/notify/slack.js'

// Le tre regole che meritano un messaggio, e il dedup che decide se dirlo. Sono la parte che, se
// sbaglia, riempie un canale di rumore: e un canale che grida per il lavoro normale si spegne da se'
// nella testa di chi legge, che e' il modo piu' veloce di rendere inutile un watchdog.

const NUOVA = 'sha256:45486f792f3f0f2a7d8ad363b7b72528945a2868c0316ca3079e8bb2ee970c7c'
const ATTESA = 'sha256:9b0e73d4a1c86f52e7d09a4b31c5f860aa11bb22cc33dd44ee55ff6600112233'
const base = (dentro = {}) => ({ configurato: true, audit: {}, heartbeat: {}, ...dentro })

test('segnali: senza la sezione teleport in config non si inventa niente', () => {
  assert.deepEqual(segnali({ configurato: false }), [])
  assert.deepEqual(segnali({}), [])
})

test('segnali: una scrittura su un database di PRODUZIONE parla, e porta chi e quante', () => {
  const dati = base({
    audit: {
      database: [
        { servizio: 'orders-prod-db-ro', nome: 'orders', ambiente: 'prod', scritture: 4, scriventi: ['tizio'], ultimaScrittura: 9000 },
      ],
    },
  })
  const out = segnali(dati)
  assert.equal(out.length, 1)
  assert.deepEqual(
    { tipo: out[0].tipo, bersaglio: out[0].bersaglio, quante: out[0].quante, chi: out[0].chi, quando: out[0].quando },
    { tipo: 'scrittura', bersaglio: 'orders', quante: 4, chi: ['tizio'], quando: 9000 },
  )
})

// ⚠️ La regola che tiene il canale leggibile: su staging si scrive tutti i giorni. Sui dati veri del
// 31/08/2026 le scritture erano tutte fuori produzione tranne quattro, e avvisare su staging avrebbe
// voluto dire un messaggio al giorno per il lavoro normale.
test('segnali: su staging non si avvisa, e le query senza scritture nemmeno', () => {
  const dati = base({
    audit: {
      database: [
        { servizio: 'app-staging-db', nome: 'postgres', ambiente: 'staging', scritture: 40, scriventi: ['tizio'], ultimaScrittura: 9000 },
        { servizio: 'orders-prod-db-ro', nome: 'orders', ambiente: 'prod', scritture: 0, query: 2918, scriventi: [], ultimaScrittura: null },
      ],
    },
  })
  assert.deepEqual(segnali(dati), [])
})

test('segnali: una sessione SSH aperta su una macchina di un ALTRO parla', () => {
  const dati = base({
    audit: { ssh: [{ macchina: 'mac-uno', chi: ['tizio'], aperte: 1, ultima: 7000 }] },
    heartbeat: { macchine: [{ macchina: 'mac-uno', utente: 'caio', utenti: ['caio'] }] },
  })
  const out = segnali(dati)
  assert.equal(out.length, 1)
  assert.deepEqual(
    { tipo: out[0].tipo, bersaglio: out[0].bersaglio, chi: out[0].chi, diChi: out[0].diChi, livello: out[0].livello },
    { tipo: 'ssh', bersaglio: 'mac-uno', chi: ['tizio'], diChi: ['caio'], livello: 'allarme' },
  )
})

// Entrare sul proprio computer non e' una notizia, ed e' il caso di TUTTI i giorni: senza questa
// riga il primo dev che apre una sessione sul suo Mac fa suonare il canale.
test('segnali: entrare sulla PROPRIA macchina non e una notizia', () => {
  const dati = base({
    audit: { ssh: [{ macchina: 'mac-uno', chi: ['caio'], aperte: 1, ultima: 7000 }] },
    heartbeat: { macchine: [{ macchina: 'mac-uno', utente: 'caio', utenti: ['caio', 'caio-locale'] }] },
  })
  assert.deepEqual(segnali(dati), [])
})

test('segnali: una sessione chiusa non parla, solo quelle APERTE', () => {
  const dati = base({
    audit: { ssh: [{ macchina: 'mac-uno', chi: ['tizio'], aperte: 0, sessioni: 9, ultima: 7000 }] },
    heartbeat: { macchine: [{ macchina: 'mac-uno', utente: 'caio', utenti: ['caio'] }] },
  })
  assert.deepEqual(segnali(dati), [])
})

// Una macchina che non ha mai mandato un avvio non ha un proprietario noto: si annuncia comunque,
// perche' una sessione aperta su una macchina che non conosciamo e' piu' interessante, non meno.
test('segnali: macchina senza proprietario noto parla lo stesso, e lo dice', () => {
  const dati = base({ audit: { ssh: [{ macchina: 'mac-ignota', chi: ['tizio'], aperte: 1, ultima: 7000 }] }, heartbeat: {} })
  const out = segnali(dati)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].diChi, [])
})

test('segnali: «la versione attesa non ce l ha nessuno» solo con l attesa in config', () => {
  const macchine = [{ macchina: 'a', immagine: NUOVA, quando: 5 }, { macchina: 'b', immagine: NUOVA, quando: 9 }]
  // Senza attesa non si accusa nessuno: il riferimento sarebbe scelto dall'orologio.
  assert.deepEqual(segnali(base({ heartbeat: { macchine } })), [])
  const out = segnali(base({ heartbeat: { macchine, attesa: ATTESA } }))
  assert.equal(out.length, 1)
  assert.equal(out[0].tipo, 'versione')
  assert.equal(out[0].quante, 2)
  // ⚠️ Istante COSTANTE e chiave col digest: sennò la notizia tornerebbe a ogni avvio di un dev-env.
  assert.equal(out[0].quando, 1)
  assert.equal(out[0].chiave, `versione:${ATTESA}`)
  // Se qualcuno ce l'ha, non sono «tutti».
  const conUno = [...macchine, { macchina: 'c', immagine: ATTESA, quando: 9 }]
  assert.deepEqual(segnali(base({ heartbeat: { macchine: conUno, attesa: ATTESA } })), [])
})

test('segnali: una versione non dichiarata non conta ne da una parte ne dall altra', () => {
  const macchine = [{ macchina: 'a', immagine: 'sconosciuta', quando: 5 }]
  assert.deepEqual(segnali(base({ heartbeat: { macchine, attesa: ATTESA } })), [])
})

// ⚠️ Il primo giro tace: su ECS il filesystem del task e' effimero, quindi a ogni rilascio lo stato
// riparte da zero. Senza questa regola il canale si riempirebbe di cose vecchie a ogni deploy.
test('daAnnunciare: il primo giro prende nota e non annuncia', () => {
  const ora = [{ chiave: 'scrittura:x', quando: 100, quante: 3 }]
  const { nuovi, stato } = daAnnunciare(ora, null, { adesso: 5_000 })
  assert.deepEqual(nuovi, [])
  // ⚠️ `detto: 0` e non l'ora del giro: non si e' detto niente, e datare il silenzio come un messaggio
  // terrebbe zitta la calma per mezz'ora dopo ogni rilascio, cioe' proprio quando il canale serve.
  assert.deepEqual(stato, { 'scrittura:x': { quando: 100, quante: 3, detto: 0, azioni: {}, tabelle: [], chi: [], livello: null } })
})

test('daAnnunciare: si annuncia solo cio che e piu recente di quanto gia detto', () => {
  const prec = { 'scrittura:x': { quando: 100, quante: 1 } }
  assert.deepEqual(daAnnunciare([{ chiave: 'scrittura:x', quando: 100 }], prec).nuovi, [])
  assert.equal(daAnnunciare([{ chiave: 'scrittura:x', quando: 101 }], prec).nuovi.length, 1)
  // Una chiave mai vista e' nuova.
  assert.equal(daAnnunciare([{ chiave: 'ssh:mac', quando: 1 }], prec).nuovi.length, 1)
})

test('daAnnunciare: lo stato nuovo contiene solo i segnali di ADESSO, non la storia', () => {
  const { stato } = daAnnunciare([{ chiave: 'ssh:mac', quando: 5 }], { 'scrittura:vecchia': 1 }, { adesso: 5_000 })
  assert.deepEqual(Object.keys(stato), ['ssh:mac'])
  assert.equal(stato['ssh:mac'].quando, 5)
})

// Il numero che si annuncia e' il DELTA: uno script che scrive per mezz'ora manda un messaggio ogni
// cinque minuti, e col totale della finestra ogni messaggio ripete le cifre del precedente.
test('daAnnunciare: si annuncia quante ne sono arrivate dall ultimo messaggio, non il totale', () => {
  const prec = { 'scrittura:x': { quando: 100, quante: 40 } }
  const { nuovi } = daAnnunciare([{ chiave: 'scrittura:x', quando: 200, quante: 220 }], prec)
  assert.equal(nuovi[0].nuove, 180)
  // Primo messaggio in assoluto per quella chiave: il delta e' tutto quello che c'e'.
  assert.equal(daAnnunciare([{ chiave: 'scrittura:y', quando: 200, quante: 7 }], prec).nuovi[0].nuove, 7)
})

// ⚠️ La finestra e' mobile: quando gli eventi vecchi ne escono il totale SCENDE, e la sottrazione
// darebbe un negativo («-12 UPDATE»). Si riparte dal totale, che al massimo dice piu' del vero.
test('daAnnunciare: se il totale della finestra SCENDE il delta non va sotto zero', () => {
  const prec = { 'scrittura:x': { quando: 100, quante: 40 } }
  const { nuovi } = daAnnunciare([{ chiave: 'scrittura:x', quando: 200, quante: 3 }], prec)
  assert.equal(nuovi[0].nuove, 3)
})

// I due livelli: i dati dei clienti chiamano, la struttura si legge. Finche' erano la stessa riga
// gialla, la seconda ha insegnato a ignorare la prima.
test('segnali: le scritture sui DATI sono un allarme, quelle sulla STRUTTURA un avviso', () => {
  const db = (dentro) => base({ audit: { database: [{ servizio: 's', nome: 'n', ambiente: 'prod', scriventi: ['tizio'], ultimaScrittura: 9000, ...dentro }] } })
  const dati = segnali(db({ scritture: 2, scrittureDati: 2, scrittureStruttura: 0 }))[0]
  const struttura = segnali(db({ scritture: 15, scrittureDati: 0, scrittureStruttura: 15 }))[0]
  assert.deepEqual([dati.livello, dati.natura], ['allarme', 'dati'])
  assert.deepEqual([struttura.livello, struttura.natura], ['attenzione', 'struttura'])
})

// ⚠️ Payload di una versione precedente (rilascio a metà): la divisione non c'e'. Non sapere cosa e'
// stato scritto non e' sapere che era struttura, e fra i due errori il silenzioso e' quello che costa.
test('segnali: senza la divisione dati/struttura NON si scende di livello', () => {
  const out = segnali(base({ audit: { database: [{ servizio: 's', nome: 'n', ambiente: 'prod', scritture: 4, scriventi: ['tizio'], ultimaScrittura: 9000 }] } }))
  assert.deepEqual([out[0].livello, out[0].natura], ['allarme', 'dati'])
})

// ── La CALMA ────────────────────────────────────────────────────────────────────────────────────────
//
// Il giro gira ogni cinque minuti. Senza calma, mezz'ora di migration su un database di produzione
// sono sei messaggi che dicono la stessa cosa con una cifra diversa: il 09/09/2026 ne sono arrivati
// sette in cinque ore sullo stesso database, e chi li ha letti ha chiesto cosa fossero, non cosa
// dicessero.
const SCRITTURA = (dentro = {}) => ({
  chiave: 'scrittura:s/n',
  tipo: 'scrittura',
  livello: 'attenzione',
  natura: 'struttura',
  quante: 10,
  quando: 1_000,
  chi: ['tizio'],
  tabelle: [],
  azioni: [{ etichetta: 'CREATE INDEX', quante: 10, tipo: 'struttura' }],
  ...dentro,
})

test('daAnnunciare: dentro alla calma un segnale che continua NON si ridice', () => {
  const prec = { 'scrittura:s/n': { quando: 500, quante: 2, detto: 0, azioni: {}, tabelle: [], chi: ['tizio'], livello: 'attenzione' } }
  const primo = daAnnunciare([SCRITTURA()], prec, { adesso: CALMA_MS + 10_000 })
  assert.equal(primo.nuovi.length, 1)
  const dopo = daAnnunciare([SCRITTURA({ quando: 2_000, quante: 14 })], primo.stato, { adesso: CALMA_MS + 10_000 + 5 * 60_000 })
  assert.deepEqual(dopo.nuovi, [])
  // ⚠️ Lo stato di un segnale taciuto resta INTERO quello di prima: se avanzasse, il messaggio dopo
  // direbbe «+4» su mezz'ora di scritture, cioe' meno di quello che e' successo. Tacere e' rimandare.
  assert.deepEqual(dopo.stato['scrittura:s/n'], primo.stato['scrittura:s/n'])
})

test('daAnnunciare: passata la calma si parla UNA volta, con tutto quello che e successo nel silenzio', () => {
  const prec = { 'scrittura:s/n': { quando: 500, quante: 0, detto: 0, azioni: {}, tabelle: [], chi: ['tizio'], livello: 'attenzione' } }
  const via = CALMA_MS + 10_000
  const primo = daAnnunciare([SCRITTURA()], prec, { adesso: via })
  assert.equal(primo.nuovi.length, 1)
  let stato = primo.stato
  // Cinque giri dentro alla calma: zero messaggi.
  for (let i = 1; i <= 5; i++) {
    const giro = daAnnunciare([SCRITTURA({ quando: 1_000 + i, quante: 10 + i * 4 })], stato, { adesso: via + i * 5 * 60_000 })
    assert.deepEqual(giro.nuovi, [], `giro ${i}`)
    stato = giro.stato
  }
  const fuori = daAnnunciare([SCRITTURA({ quando: 2_000, quante: 34 })], stato, { adesso: via + CALMA_MS + 1 })
  assert.equal(fuori.nuovi.length, 1)
  // 34 meno le 10 dell'ultimo messaggio: niente si perde nel silenzio.
  assert.equal(fuori.nuovi[0].nuove, 24)
})

// La cosa che non aspetta: scrive qualcuno che prima non c'era.
test('daAnnunciare: la calma si rompe se scrive qualcuno di nuovo', () => {
  const prec = {
    'scrittura:s/n': { quando: 500, quante: 10, detto: 9_000, azioni: { 'CREATE INDEX': 10 }, tabelle: [], chi: ['tizio'], livello: 'attenzione' },
  }
  const subito = { adesso: 10_000 }
  // Solo altri indici, sempre della stessa persona: aspetta.
  assert.deepEqual(daAnnunciare([SCRITTURA({ quando: 1_000, quante: 12, azioni: [{ etichetta: 'CREATE INDEX', quante: 12, tipo: 'struttura' }] })], prec, subito).nuovi, [])
  // «Anche caio sta scrivendo in produzione» e' la riga che fa alzare il telefono, e darla mezz'ora
  // dopo vuol dire darla a cose finite.
  const inPiu = daAnnunciare([SCRITTURA({ quando: 1_000, quante: 12, chi: ['tizio', 'caio'] })], prec, subito)
  assert.equal(inPiu.nuovi.length, 1)
})

// ⚠️ E il primo `UPDATE` sui dati dei clienti non aspetta nemmeno lui, ma per una ragione strutturale e
// non per un'eccezione: e' un'altra chiave, che non ha mai parlato. Una migration rumorosa non puo'
// zittire la riga rossa, che e' il modo in cui una calma fatta male fa danno.
test('daAnnunciare: la calma dei DDL non zittisce la riga dei DATI, che e un altra chiave', () => {
  const dati = base({
    audit: {
      database: [
        {
          servizio: 's', nome: 'n', ambiente: 'prod',
          scritture: 12, scrittureDati: 2, scrittureStruttura: 10,
          azioni: [{ etichetta: 'CREATE INDEX', quante: 10, tipo: 'struttura' }, { etichetta: 'UPDATE', quante: 2, tipo: 'dati' }],
          bersagli: ['clienti'], scriventi: ['tizio'],
          ultimaScritturaDati: 2_000, ultimaScritturaStruttura: 1_000, ultimaScrittura: 2_000,
        },
      ],
    },
  })
  // Dei DDL si e' appena parlato; dei dati mai.
  const prec = {
    'scrittura-struttura:s/n': { quando: 900, quante: 8, detto: 9_000, azioni: { 'CREATE INDEX': 8 }, tabelle: [], chi: ['tizio'], livello: 'attenzione' },
  }
  const { nuovi } = daAnnunciare(segnali(dati), prec, { adesso: 10_000 })
  assert.deepEqual(nuovi.map((n) => [n.chiave, n.livello, n.nuove]), [['scrittura-dati:s/n', 'allarme', 2]])
})

// Il conto etichetta per etichetta, che e' quello che rendeva ogni messaggio la copia del precedente:
// «+1» accanto a «9 CREATE FUNCTION, 7 GRANT», cioe' il delta accanto al totale delle 24h.
test('daAnnunciare: le azioni annunciate sono quelle ARRIVATE, non quelle della finestra', () => {
  const prec = {
    'scrittura:s/n': { quando: 500, quante: 16, detto: 0, azioni: { 'CREATE FUNCTION': 9, GRANT: 7 }, tabelle: [], chi: ['tizio'], livello: 'attenzione' },
  }
  const { nuovi } = daAnnunciare(
    [SCRITTURA({ quando: 1_000, quante: 18, azioni: [{ etichetta: 'CREATE FUNCTION', quante: 10, tipo: 'struttura' }, { etichetta: 'GRANT', quante: 8, tipo: 'struttura' }] })],
    prec,
    { adesso: CALMA_MS + 10_000 },
  )
  assert.deepEqual(nuovi[0].azioni, [
    { etichetta: 'CREATE FUNCTION', quante: 1, tipo: 'struttura' },
    { etichetta: 'GRANT', quante: 1, tipo: 'struttura' },
  ])
})

// ⚠️ Il colore non si ricalcola mai: lo porta la chiave. Prima lo decideva la finestra di 24 ore, e
// sullo stesso database il canale alternava rosso e giallo senza che il colore dicesse niente su quel
// messaggio (rosso perche' ieri c'era stato un UPDATE, giallo di nuovo quando usciva dalla finestra).
// E una scrittura sui dati NUOVA che entrava mentre una vecchia usciva (stesso totale, delta zero)
// finiva sotto un titolo giallo che parlava di indici, cioe' il caso che non deve succedere mai.
test('daAnnunciare: due chiavi, due colori, e la riga rossa non riparte per un CREATE INDEX', () => {
  const dati = (dentro) =>
    base({
      audit: {
        database: [
          {
            servizio: 's', nome: 'n', ambiente: 'prod',
            scritture: 12, scrittureDati: 2, scrittureStruttura: 10,
            azioni: [{ etichetta: 'CREATE INDEX', quante: 10, tipo: 'struttura' }, { etichetta: 'UPDATE', quante: 2, tipo: 'dati' }],
            bersagli: ['clienti'], scriventi: ['tizio'], ...dentro,
          },
        ],
      },
    })
  const due = segnali(dati({ ultimaScritturaDati: 2_000, ultimaScritturaStruttura: 2_000 }))
  assert.deepEqual(due.map((s) => [s.chiave, s.livello, s.natura, s.quante]), [
    ['scrittura-dati:s/n', 'allarme', 'dati', 2],
    ['scrittura-struttura:s/n', 'attenzione', 'struttura', 10],
  ])
  // La tabella sta solo sulla riga rossa: accanto a un elenco di DDL si leggerebbe come la tabella che
  // le DDL hanno toccato, che non e' quello che dice.
  assert.deepEqual([due[0].tabelle, due[1].tabelle], [['clienti'], []])
  // Un `CREATE INDEX` in piu' muove solo l'istante della struttura: la riga rossa non ha niente di
  // nuovo da dire e sta zitta.
  const prec = {
    'scrittura-dati:s/n': { quando: 2_000, quante: 2, detto: 0, azioni: { UPDATE: 2 }, tabelle: ['clienti'], chi: ['tizio'], livello: 'allarme' },
    'scrittura-struttura:s/n': { quando: 2_000, quante: 10, detto: 0, azioni: { 'CREATE INDEX': 10 }, tabelle: [], chi: ['tizio'], livello: 'attenzione' },
  }
  const dopo = segnali(dati({ ultimaScritturaDati: 2_000, ultimaScritturaStruttura: 3_000, scritture: 13, scrittureStruttura: 11, azioni: [{ etichetta: 'CREATE INDEX', quante: 11, tipo: 'struttura' }, { etichetta: 'UPDATE', quante: 2, tipo: 'dati' }] }))
  const { nuovi } = daAnnunciare(dopo, prec, { adesso: CALMA_MS + 10_000 })
  assert.deepEqual(nuovi.map((n) => [n.chiave, n.nuove]), [['scrittura-struttura:s/n', 1]])
})

// ⚠️ Il numero e le azioni escono dallo stesso conto. Con due conti diversi bastava una finestra che
// scorre (`UPDATE` 15 → 11, `INSERT` 5 → 7) per stampare «+18 INSERT» dove gli INSERT arrivati erano 2.
test('daAnnunciare: il numero annunciato e la somma delle azioni annunciate, anche se la finestra scende', () => {
  const prec = { 'scrittura:s/n': { quando: 500, quante: 20, detto: 0, azioni: { UPDATE: 15, INSERT: 5 }, tabelle: [], chi: ['tizio'], livello: 'allarme' } }
  const { nuovi } = daAnnunciare(
    [SCRITTURA({ quando: 1_000, quante: 18, azioni: [{ etichetta: 'UPDATE', quante: 11, tipo: 'dati' }, { etichetta: 'INSERT', quante: 7, tipo: 'dati' }] })],
    prec,
    { adesso: CALMA_MS + 10_000 },
  )
  assert.deepEqual(nuovi[0].azioni, [{ etichetta: 'INSERT', quante: 2, tipo: 'dati' }])
  assert.equal(nuovi[0].nuove, 2)
})

// ⚠️ La regola di non scendere resta, dove serve davvero: un payload senza la divisione dati/struttura
// (versione precedente, cioe' un rilascio a meta') fa UNA riga sola e ROSSA, con la chiave di prima.
// Non sapere cosa e' stato scritto non e' sapere che era struttura.
test('segnali: senza la divisione la riga e una sola, rossa, e tiene la chiave vecchia', () => {
  const out = segnali(base({ audit: { database: [{ servizio: 's', nome: 'n', ambiente: 'prod', scritture: 4, scriventi: ['tizio'], ultimaScrittura: 9000 }] } }))
  assert.equal(out.length, 1)
  assert.deepEqual([out[0].chiave, out[0].livello, out[0].natura], ['scrittura:s/n', 'allarme', 'dati'])
})

// Senza `tipo` sulle azioni (stesso caso, mezzo rilascio) le azioni non si smistano: restano fuori da
// entrambe le righe invece di finire in tutte e due, e il conteggio resta quello vero.
test('segnali: azioni senza tipo non finiscono in nessuna delle due righe, e i numeri restano giusti', () => {
  const out = segnali(
    base({
      audit: {
        database: [
          {
            servizio: 's', nome: 'n', ambiente: 'prod',
            scritture: 5, scrittureDati: 2, scrittureStruttura: 3,
            azioni: [{ etichetta: 'UPDATE', quante: 2 }, { etichetta: 'CREATE INDEX', quante: 3 }],
            scriventi: ['tizio'], ultimaScrittura: 9000,
          },
        ],
      },
    }),
  )
  assert.deepEqual(out.map((s) => [s.natura, s.quante, s.azioni.length]), [['dati', 2, 0], ['struttura', 3, 0]])
})

// ── i guasti del dev-env ──────────────────────────────────────────────────────────────────────────
//
// ⚠️ La ragione per cui queste due righe esistono, ed e' la stessa per cui il canale non deve gridare:
// un avvio che non parte sul Mac di qualcun altro oggi si scopre SOLO se quella persona lo racconta.
// Ma un inciampo non e' una persona ferma, e appiattirli su una riga sola rende inutile quella rossa.

test('segnali: una classe di guasto MAI VISTA merita una riga, con la riga d errore', () => {
  const dati = base({
    heartbeat: {
      classiNuove: [
        { classe: 'compose-up', passo: 'avvio-stack', macchina: 'mac-di-gio', utente: 'gio',
          primaRiga: 'listen tcp4 <host>:<n>: bind: address already in use', quando: 7000 },
      ],
    },
  })
  const s = segnali(dati).filter((x) => x.tipo === 'guasto')
  assert.equal(s.length, 1)
  assert.equal(s[0].chiave, 'guasto:compose-up')
  assert.equal(s[0].livello, 'attenzione')
  assert.equal(s[0].dettaglio, 'listen tcp4 <host>:<n>: bind: address already in use')
  assert.deepEqual(s[0].chi, ['gio'])
})

test('segnali: una riga per CLASSE, anche se la stessa classe colpisce piu macchine', () => {
  // Se l'immagine nuova rompe l'avvio a tutti e nove, la notizia e' una sola: nove righe la
  // nasconderebbero, ed e' cosi' che un canale diventa rumore.
  const dati = base({
    heartbeat: {
      classiNuove: [
        { classe: 'compose-up', macchina: 'mac-1', quando: 7000 },
        { classe: 'compose-up', macchina: 'mac-2', quando: 8000 },
      ],
    },
  })
  const chiavi = segnali(dati).filter((x) => x.tipo === 'guasto').map((x) => x.chiave)
  assert.deepEqual(chiavi, ['guasto:compose-up'])
})

test('segnali: due avvii KO di fila sono una persona FERMA, e sono rossi', () => {
  const dati = base({
    heartbeat: {
      macchine: [{ macchina: 'mac-di-ste', lato: 'host', utente: 'ste', immagine: NUOVA, esito: 'ko', quando: 9000 }],
      bloccate: [{ macchina: 'mac-di-ste', lato: 'host', classe: 'compose-up', quando: 9000 }],
    },
  })
  const s = segnali(dati).filter((x) => x.tipo === 'dev-fermo')
  assert.equal(s.length, 1)
  assert.equal(s[0].livello, 'allarme')
  assert.equal(s[0].chiave, 'dev-fermo:mac-di-ste/host')
  assert.equal(s[0].bersaglio, 'mac-di-ste')
})

test('segnali: senza guasti il dev-env non dice niente', () => {
  const s = segnali(base({ heartbeat: { macchine: [{ macchina: 'mac-1', immagine: NUOVA, esito: 'ok', quando: 9000 }] } }))
  assert.deepEqual(s.filter((x) => x.tipo === 'guasto' || x.tipo === 'dev-fermo'), [])
})

// Il messaggio che arriva in chat: non e' decorazione, e' l'unico posto in cui quel guasto esiste per
// chi lo legge. `messaggioAccessi` non aveva un ramo per questi due tipi e cadeva nel ripiego, che
// stampa il tipo e basta: un `dev-env — guasto` non dice ne' cosa si e' rotto ne' a chi.
test('messaggio: un guasto mai visto porta classe, passo e riga d errore', () => {
  const m = messaggioAccessi(
    { tipo: 'guasto', livello: 'attenzione', bersaglio: 'dev-env', classe: 'compose-up', passo: 'avvio-stack',
      chi: ['gio'], dettaglio: 'listen tcp4 <host>:<n>: bind: address already in use' },
    { publicUrl: 'https://dg' },
  )
  assert.match(m, /GUASTO MAI VISTO/)
  assert.match(m, /`compose-up`/)
  assert.match(m, /`avvio-stack`/)
  assert.match(m, /bind: address already in use/)
})

test('messaggio: due avvii falliti di fila dicono che quella persona e ferma', () => {
  const m = messaggioAccessi(
    { tipo: 'dev-fermo', livello: 'allarme', bersaglio: 'mac-di-ste', classe: 'compose-up', chi: ['ste'] },
    { publicUrl: 'https://dg' },
  )
  assert.match(m, /IL DEV-ENV NON PARTE/)
  assert.match(m, /due avvii di fila/)
  assert.match(m, /ste/)
})
