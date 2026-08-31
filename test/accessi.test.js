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
} from '../web/accessi.js'

// Le regole della pagina Accessi. Stavano dentro il componente, dove si potevano leggere e non
// provare: sono quelle che decidono cosa una persona guarda per PRIMA durante un guasto, quindi sono
// anche quelle che non devono cambiare per sbaglio al primo ritocco della tabella.

test('digestCorto: via il prefisso dell algoritmo, che su ogni riga e identico', () => {
  assert.equal(digestCorto('sha256:45486f792f3f2a1b9c8d'), '45486f792f3f')
  assert.equal(digestCorto('45486f792f3f2a1b9c8d'), '45486f792f3f')
  assert.equal(digestCorto(null), '')
  assert.equal(digestCorto('sha256:abc'), 'abc')
})

test('immagineRiferimento: senza versione attesa si usa l avvio piu RECENTE, non il primo dell elenco', () => {
  const macchine = [
    { macchina: 'a', immagine: 'sha256:vecchia', quando: 1000 },
    { macchina: 'b', immagine: 'sha256:nuova', quando: 9000 },
  ]
  assert.deepEqual(immagineRiferimento(macchine), { immagine: 'sha256:nuova', fonte: 'vista' })
})

// ⚠️ La funzione non deve dipendere dall'ordine di chi la chiama: il server oggi ordina per `quando`
// decrescente, ma una regola che si appoggia a quell'ordine si rompe in silenzio il giorno che cambia.
test('immagineRiferimento: l ordine dell elenco non conta', () => {
  const giu = [
    { immagine: 'sha256:nuova', quando: 9000 },
    { immagine: 'sha256:vecchia', quando: 1000 },
  ]
  assert.equal(immagineRiferimento(giu).immagine, immagineRiferimento([...giu].reverse()).immagine)
})

test('immagineRiferimento: la versione attesa dalla config vince, e lo dice', () => {
  const macchine = [{ immagine: 'sha256:vecchia', quando: 9000 }]
  assert.deepEqual(immagineRiferimento(macchine, 'sha256:attesa'), { immagine: 'sha256:attesa', fonte: 'config' })
})

test('immagineRiferimento: nessuna macchina non inventa un riferimento', () => {
  assert.deepEqual(immagineRiferimento([]), { immagine: null, fonte: 'vista' })
  assert.deepEqual(immagineRiferimento([{ macchina: 'a', quando: 1 }]), { immagine: null, fonte: 'vista' })
})

test('macchinaIndietro: indietro solo se ha un immagine DIVERSA da quella di riferimento', () => {
  assert.equal(macchinaIndietro({ immagine: 'x' }, 'y'), true)
  assert.equal(macchinaIndietro({ immagine: 'x' }, 'x'), false)
  // Senza riferimento, o senza immagine sulla riga, non si e' «indietro»: si e' senza dato.
  assert.equal(macchinaIndietro({ immagine: 'x' }, null), false)
  assert.equal(macchinaIndietro({}, 'y'), false)
})

// Il buco che il ripiego non puo' vedere: se la versione attesa la sa la config e non ce l'ha nessuno,
// sono indietro TUTTI, mentre «la piu' nuova che qualcuno ha visto» direbbe che vanno tutti bene.
test('tuttiIndietro: con la versione attesa dalla config, nessuno che la ha vuol dire tutti indietro', () => {
  const macchine = [{ immagine: 'sha256:vecchia' }, { immagine: 'sha256:vecchia' }]
  assert.equal(tuttiIndietro(macchine, { immagine: 'sha256:attesa', fonte: 'config' }), true)
  assert.equal(tuttiIndietro(macchine, { immagine: 'sha256:vecchia', fonte: 'config' }), false)
})

test('tuttiIndietro: senza versione attesa la domanda non si pone, e non si risponde si per prudenza', () => {
  const macchine = [{ immagine: 'sha256:vecchia' }]
  assert.equal(tuttiIndietro(macchine, { immagine: 'sha256:vecchia', fonte: 'vista' }), false)
  assert.equal(tuttiIndietro(macchine, null), false)
  assert.equal(tuttiIndietro([], { immagine: 'sha256:attesa', fonte: 'config' }), false)
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

test('problemaMacchina: indietro, tool mancanti o avvio storto, e accetta sia il riferimento sia il suo digest', () => {
  const rif = { immagine: 'sha256:nuova', fonte: 'vista' }
  assert.equal(problemaMacchina({ immagine: 'sha256:vecchia' }, rif), true)
  assert.equal(problemaMacchina({ immagine: 'sha256:vecchia' }, 'sha256:nuova'), true)
  assert.equal(problemaMacchina({ immagine: 'sha256:nuova', toolMancanti: 2 }, rif), true)
  assert.equal(problemaMacchina({ immagine: 'sha256:nuova', esito: 'parziale' }, rif), true)
  assert.equal(problemaMacchina({ immagine: 'sha256:nuova', toolMancanti: 0, esito: 'ok' }, rif), false)
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
    { macchina: 'pari', immagine: 'sha256:nuova', quando: 9000 },
    { macchina: 'indietro', immagine: 'sha256:vecchia', quando: 100 },
  ]
  const rif = immagineRiferimento(macchine)
  assert.deepEqual(ordinaMacchine(macchine, rif).map((m) => m.macchina), ['indietro', 'pari'])
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
  const heartbeat = { versioni: [{ immagine: 'sha256:vecchia', quante: 2 }], macchine: [{ immagine: 'sha256:vecchia' }] }
  assert.equal(daGuardare({}, heartbeat, { immagine: 'sha256:attesa', fonte: 'config' }), 1)
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
