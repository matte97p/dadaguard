import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segnali, daAnnunciare } from '../server/accessi.js'

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
  const ora = [{ chiave: 'scrittura:x', quando: 100 }]
  const { nuovi, stato } = daAnnunciare(ora, null)
  assert.deepEqual(nuovi, [])
  assert.deepEqual(stato, { 'scrittura:x': 100 })
})

test('daAnnunciare: si annuncia solo cio che e piu recente di quanto gia detto', () => {
  const prec = { 'scrittura:x': 100 }
  assert.deepEqual(daAnnunciare([{ chiave: 'scrittura:x', quando: 100 }], prec).nuovi, [])
  assert.equal(daAnnunciare([{ chiave: 'scrittura:x', quando: 101 }], prec).nuovi.length, 1)
  // Una chiave mai vista e' nuova.
  assert.equal(daAnnunciare([{ chiave: 'ssh:mac', quando: 1 }], prec).nuovi.length, 1)
})

test('daAnnunciare: lo stato nuovo contiene solo i segnali di ADESSO, non la storia', () => {
  const { stato } = daAnnunciare([{ chiave: 'ssh:mac', quando: 5 }], { 'scrittura:vecchia': 1 })
  assert.deepEqual(stato, { 'ssh:mac': 5 })
})
