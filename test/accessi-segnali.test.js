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
  // `parziale` sta in stato per il giro DOPO: dice se i totali qui sopra erano un campione.
  assert.deepEqual(stato, { 'scrittura:x': { quando: 100, quante: 3, detto: 0, azioni: {}, tabelle: [], chi: [], chiQuante: null, livello: null, parziale: false } })
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
      bloccate: [{ macchina: 'mac-di-ste', lato: 'host', classe: 'porta-occupata', dettaglio: '3000|PID <n>|node', quando: 9000 }],
    },
  })
  const s = segnali(dati).filter((x) => x.tipo === 'dev-fermo')
  assert.equal(s.length, 1)
  assert.equal(s[0].livello, 'allarme')
  assert.equal(s[0].chiave, 'dev-fermo:mac-di-ste/host')
  assert.equal(s[0].bersaglio, 'mac-di-ste')
  // ⚠️ Nomi ESPANSI, non il Set: `proprietari()` torna una Map<macchina, Set>, e avvolgerlo in un
  // array stampava `[object Set]` al posto del nome di chi e' fermo (visto in chat il 16/09/2026).
  assert.deepEqual(s[0].chi, ['ste'])
  const m = messaggioAccessi(s[0], { publicUrl: 'https://dg' })
  assert.match(m, /\(ste\)/)
  // ⚠️ La porta nel messaggio: `porta-occupata` da sola non dice su cosa agire, ed e' quello che il
  // 16/09/2026 ha reso l'allarme inutile a chi lo leggeva.
  assert.match(m, /3000/)
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

// ⚠️ La riga d'errore arriva da un'altra macchina e da una versione del dev-env che non scegliamo noi:
// quella che spedisce oggi taglia a 120 caratteri e toglie path, host e token, una precedente puo' non
// farlo. Qui si difende la FORMA (una riga sola, senza backtick, con un tetto), che e' l'unica cosa che
// questa pagina puo' garantire: la redazione resta in `pulisci_riga`, e duplicarla qui darebbe due
// pulizie che un giorno non dicono piu' la stessa cosa.
test('messaggio: una riga d errore multilinea, lunga o con backtick non sfonda il formato', () => {
  const sporca = `avvio KO\n  at /src/x.js:1\n  \`docker compose up\` ${'x'.repeat(400)}`
  for (const segnale of [
    { tipo: 'guasto', livello: 'attenzione', bersaglio: 'dev-env', classe: 'compose-up', chi: ['gio'], dettaglio: sporca },
    { tipo: 'dev-fermo', livello: 'allarme', bersaglio: 'mac-di-ste', classe: 'porta-occupata', chi: ['ste'], dettaglio: sporca },
  ]) {
    const m = messaggioAccessi(segnale, { publicUrl: 'https://dg' })
    assert.equal(m.includes('\n'), false)
    // I backtick della riga d'errore chiuderebbero il code span che la ospita, e il resto del
    // messaggio (il link in coda compreso) uscirebbe storto.
    // Sei: bersaglio, classe e riga d'errore, due per ciascuno. Con un backtick dentro alla riga
    // sarebbero sette, cioe' uno spaiato, e il resto del messaggio uscirebbe storto.
    assert.equal((m.match(/`/g) ?? []).length, 6)
    assert.ok(m.length < 400, `messaggio lungo ${m.length}`)
    assert.match(m, /…/)
  }
})

// ── La lettura PARZIALE ─────────────────────────────────────────────────────────────────────────────
//
// L'audit ha un tetto di righe (`finestre.conf`, riga `teleport`). Quando lo tocca, quello che arriva
// qui sono gli eventi PIU RECENTI e non la finestra intera: i conteggi dicono meno del vero, e il
// delta contro il giro prima dice meno ancora, perche' i due campioni non sono la stessa cosa.
// Non si corregge (il dato che manca non c'e'), si DICE.
//
// Il 18/09/2026 il canale ha annunciato «+324» e poi «+267» sullo stesso database di produzione, e nel
// log ce n'erano 776 in dieci minuti: due numeri che sembravano esatti e che non si sommano.
test('segnali: audit troncato → la riga si dichiara parziale', () => {
  const db = (dentro = {}) => ({
    configurato: true,
    heartbeat: {},
    audit: {
      database: [{ servizio: 'prod-db', nome: 'postgres', ambiente: 'prod', scritture: 324, scrittureDati: 0, scrittureStruttura: 324, scriventi: ['tizio'], ultimaScrittura: 9000 }],
      ...dentro,
    },
  })
  assert.equal(segnali(db({ troncato: true }))[0].parziale, true)
  // Lettura completa: nessuna parola in piu', perche' «almeno» su un totale esatto e' rumore.
  assert.equal(segnali(db())[0].parziale, false)
})

const RIGA = (dentro) => ({
  tipo: 'scrittura', natura: 'struttura', livello: 'attenzione', ambiente: 'prod',
  servizio: 'prod-db', bersaglio: 'postgres', chi: ['tizio'], utentiDb: [],
  nuove: 324, quante: 324, azioni: [{ etichetta: 'ALTER TABLE', quante: 206, tipo: 'struttura' }],
  oggetti: [], tabelle: [], ...dentro,
})

test('messaggioAccessi: la parola della stima e quella decisa a monte, e una lettura esatta non ne ha', () => {
  assert.match(messaggioAccessi(RIGA({ parziale: true, stima: 'almeno' })), /— almeno \+324 /)
  assert.match(messaggioAccessi(RIGA({ parziale: true, stima: 'circa' })), /— circa \+324 /)
  const esatta = messaggioAccessi(RIGA({ parziale: false, stima: null }))
  assert.match(esatta, /— \+324 /)
  assert.doesNotMatch(esatta, /almeno|circa|lettura parziale/)
})

// ⚠️ Non e' solo il numero a venire da un campione: le etichette, gli oggetti e soprattutto l'elenco
// di CHI ha scritto. Un nome che manca da un allarme rosso di produzione non lascia nessun segno.
test('messaggioAccessi: una lettura parziale lo dice per tutta la riga, non solo per il numero', () => {
  assert.match(messaggioAccessi(RIGA({ parziale: true, stima: 'almeno' })), /letti solo gli eventi più recenti, quindi nomi e numeri possono essere incompleti/)
})

// ⚠️ «almeno» e' una promessa: il numero non puo' essere piu' basso del vero. Il ripiego della
// finestra la rompe, perche' ridice il totale invece di quello che e' arrivato, e sotto troncamento
// il ripiego e' proprio il caso frequente (nessuna etichetta cresce fra due campioni diversi).
test('daAnnunciare: sotto troncamento il ripiego della finestra dice «circa», non «almeno»', () => {
  const prec = { k: { quando: 100, quante: 324, azioni: { 'ALTER TABLE': 206 }, detto: 0, parziale: true } }
  const s = { chiave: 'k', quando: 200, quante: 300, parziale: true, azioni: [{ etichetta: 'ALTER TABLE', quante: 200, tipo: 'struttura' }] }
  const { nuovi } = daAnnunciare([s], prec)
  assert.equal(nuovi[0].stima, 'circa')
  assert.equal(nuovi[0].ripiego, true)
})

test('daAnnunciare: un campione con etichette CRESCIUTE e un pavimento, e dice «almeno»', () => {
  const prec = { k: { quando: 100, quante: 324, azioni: { 'ALTER TABLE': 206 }, detto: 0, parziale: false } }
  const s = { chiave: 'k', quando: 200, quante: 500, parziale: true, azioni: [{ etichetta: 'ALTER TABLE', quante: 306, tipo: 'struttura' }] }
  assert.equal(daAnnunciare([s], prec).nuovi[0].stima, 'almeno')
})

// ⚠️ Il giro che mente non e' quello troncato, e' QUELLO DOPO: il delta si misura contro i totali di
// un campione, quindi una lettura completa che segue una troncata dice molto piu' del vero (324
// memorizzate su 776 vere, poi 800 → «+476» dove ne sono arrivate 24).
test('daAnnunciare: dopo una lettura troncata il delta della successiva si dichiara', () => {
  const prec = { k: { quando: 100, quante: 324, azioni: { 'ALTER TABLE': 206 }, detto: 0, parziale: true } }
  const s = { chiave: 'k', quando: 200, quante: 800, parziale: false, azioni: [{ etichetta: 'ALTER TABLE', quante: 412, tipo: 'struttura' }] }
  const { nuovi, stato } = daAnnunciare([s], prec)
  assert.equal(nuovi[0].stima, 'circa')
  assert.equal(nuovi[0].parziale, true)
  // Lo stato nuovo nasce da una lettura completa: il giro dopo non deve ereditare il dubbio.
  assert.equal(stato.k.parziale, false)
})

// ⚠️ I nomi nella riga sono quelli di chi ha scritto DALL'ULTIMO messaggio, non quelli visti nella
// finestra. Il 23/09/2026 un `DELETE` fatto da una persona sola e' stato annunciato con due nomi,
// perche' il secondo aveva scritto quindici ore prima ed era ancora dentro alla finestra: in un
// allarme rosso di produzione, quello e' accusare qualcuno di una cosa che non ha fatto.
test('daAnnunciare: nomina solo chi ha scritto dall ultimo messaggio', () => {
  const prec = {
    'scrittura:s/n': { quando: 500, quante: 3, detto: 0, azioni: { UPDATE: 3 }, tabelle: [], chi: ['tizio', 'caio'], chiQuante: { tizio: 2, caio: 1 }, livello: 'allarme' },
  }
  const ora = SCRITTURA({
    quando: 1_000,
    quante: 4,
    chi: ['tizio', 'caio'],
    chiQuante: { tizio: 2, caio: 2 },
    azioni: [{ etichetta: 'UPDATE', quante: 4, tipo: 'dati' }],
  })
  const fuori = daAnnunciare([ora], prec, { adesso: CALMA_MS + 10_000 })
  assert.equal(fuori.nuovi.length, 1)
  assert.deepEqual(fuori.nuovi[0].chi, ['caio'], 'tizio non ha scritto da allora')
  // In stato restano TUTTI: il confronto del giro dopo si fa contro quello che si sapeva parlando.
  assert.deepEqual(fuori.stato['scrittura:s/n'].chiQuante, { tizio: 2, caio: 2 })
})

// Il ripiego: se nessuno e' cresciuto (una scrittura vecchia esce dalla finestra e una nuova entra) si
// ridicono i nomi della finestra, perche' «+1 DELETE» senza dire da chi non e' una notizia.
test('daAnnunciare: se nessun conteggio e cresciuto ridice i nomi della finestra', () => {
  const prec = {
    'scrittura:s/n': { quando: 500, quante: 3, detto: 0, azioni: { UPDATE: 3 }, tabelle: [], chi: ['tizio'], chiQuante: { tizio: 3 }, livello: 'allarme' },
  }
  const ora = SCRITTURA({ quando: 1_000, quante: 3, chi: ['tizio'], chiQuante: { tizio: 3 }, azioni: [{ etichetta: 'UPDATE', quante: 3, tipo: 'dati' }] })
  const fuori = daAnnunciare([ora], prec, { adesso: CALMA_MS + 10_000 })
  assert.deepEqual(fuori.nuovi[0].chi, ['tizio'])
})

// Un payload senza i conteggi (rilascio a meta') non deve far sparire i nomi: si dicono tutti, che e'
// quello che si diceva prima. Non sapere non e' «non c'e' nessuno».
test('daAnnunciare: senza i conteggi per persona nomina tutti, come prima', () => {
  const prec = { 'scrittura:s/n': { quando: 500, quante: 1, detto: 0, azioni: { UPDATE: 1 }, tabelle: [], chi: ['tizio'], livello: 'allarme' } }
  const ora = SCRITTURA({ quando: 1_000, quante: 2, chi: ['tizio', 'caio'], azioni: [{ etichetta: 'UPDATE', quante: 2, tipo: 'dati' }] })
  const fuori = daAnnunciare([ora], prec, { adesso: CALMA_MS + 10_000 })
  assert.deepEqual(fuori.nuovi[0].chi, ['tizio', 'caio'])
})

// ⚠️ I login PERSONALI si riconoscono su TUTTI quelli che hanno scritto nella finestra, non sui soli
// nomi che finiscono nella riga. Con i secondi, il login di chi era fuori dal delta ricompariva fra
// parentesi come login estraneo: `da tizio (dev_caio su writer)`, cioe' il nome sbagliato attaccato
// alla scrittura sbagliata, che e' il difetto che questo giro toglie.
test('messaggioAccessi: il login di chi non e nel delta non torna fra parentesi', () => {
  const riga = RIGA({
    natura: 'dati',
    livello: 'allarme',
    chi: ['tizio'],
    chiTutti: ['tizio', 'caio'],
    utentiDb: [
      { utente: 'dev_tizio', endpoint: 'writer' },
      { utente: 'dev_caio', endpoint: 'writer' },
    ],
    nuove: 1,
    quante: 1,
    azioni: [{ etichetta: 'DELETE', quante: 1, tipo: 'dati' }],
    tabelle: ['ordini'],
  })
  const testo = messaggioAccessi(riga)
  assert.match(testo, /da tizio \(su writer\)/)
  assert.doesNotMatch(testo, /dev_caio/)
})

// Il login davvero estraneo (condiviso, non il nome di nessuno) deve continuare a uscire: e' l'unica
// informazione che il nome della persona non porta.
test('messaggioAccessi: un login condiviso resta, perche il nome della persona non lo dice', () => {
  const riga = RIGA({
    chi: ['tizio'],
    chiTutti: ['tizio'],
    utentiDb: [{ utente: 'dev_readwrite', endpoint: 'writer' }],
  })
  assert.match(messaggioAccessi(riga), /dev_readwrite su writer/)
})
