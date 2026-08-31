import { test } from 'node:test'
import assert from 'node:assert/strict'

// ⚠️ Il modulo parla con CloudWatch Logs: qui si prova la LETTURA delle righe, non AWS. Il client SDK
// si sostituisce con un finto attraverso l'unico punto in cui il modulo lo crea (`clientOpts`), quindi
// si passa da un import dinamico con il mock già in memoria.
import { mock } from 'node:test'

const riga = (oggetto, ts) => ({ timestamp: ts, message: JSON.stringify(oggetto) })

// Le righe VERE dell'incidente del 28/08/2026, accorciate ai campi che contano.
const LOGIN_FALLITA = (utente, quando, errore) =>
  riga(
    {
      event_type: 'user.login',
      fields: { event: 'user.login', success: false, user: utente, error: `Failed to calculate user attributes.\n\t${errore}` },
    },
    quando,
  )
const LOGIN_OK = (utente, quando) =>
  riga({ event_type: 'user.login', fields: { event: 'user.login', success: true, user: utente } }, quando)
const SESSIONE_DB = (utente, quando) =>
  riga({ event_type: 'db.session.start', fields: { event: 'db.session.start', user: utente } }, quando)
// Sessione SSH su un nodo: `server_hostname` e' il nome leggibile, `server_id` l'UUID. Le righe vere
// portano entrambi, e la vista deve mostrare il primo.
const SSH_INIZIO = (utente, macchina, quando) =>
  riga(
    {
      event_type: 'session.start',
      fields: { event: 'session.start', user: utente, server_hostname: macchina, server_id: 'a3f1-uuid-che-non-aiuta' },
    },
    quando,
  )
const SSH_FINE = (utente, macchina, quando) =>
  riga({ event_type: 'session.end', fields: { event: 'session.end', user: utente, server_hostname: macchina } }, quando)

async function conEventi(eventi) {
  // Il finto client: risponde una pagina sola e nessun token.
  const modulo = await import('../server/teleport.js?' + Math.random())
  const sdk = await import('@aws-sdk/client-cloudwatch-logs')
  mock.method(sdk.CloudWatchLogsClient.prototype, 'send', async () => ({ events: eventi }))
  return modulo
}

test('audit: separa le login fallite da quelle riuscite e tiene il motivo per intero', async () => {
  const { audit } = await conEventi([
    LOGIN_FALLITA('utente-uno', 1000, 'role db-team-staging-read is not found'),
    LOGIN_FALLITA('utente-uno', 2000, 'role db-team-staging-read is not found'),
    LOGIN_OK('utente-due', 3000),
    SESSIONE_DB('utente-due', 3500),
    SESSIONE_DB('utente-due', 3600),
  ])
  const out = await audit({}, { logGroup: '/finto', ore: 24 })
  assert.equal(out.loginFallite, 2)
  const gabbo = out.persone.find((p) => p.utente === 'utente-uno')
  assert.equal(gabbo.loginFallite, 2)
  assert.equal(gabbo.loginOk, 0)
  // ⚠️ Il motivo NON si accorcia a «errore»: e' la differenza fra una sessione scaduta e un ruolo che
  // sul cluster non esiste, cioe' fra «normale» e «tutto il team e' fuori».
  assert.match(gabbo.motivo, /role db-team-staging-read is not found/)
  const secondo = out.persone.find((p) => p.utente === 'utente-due')
  assert.equal(secondo.loginOk, 1)
  assert.equal(secondo.sessioniDb, 2)
})

const QUERY = (utente, quando, testo, servizio = 'prod-db', nome = 'tenders') =>
  riga(
    {
      event_type: 'db.session.query',
      fields: {
        event: 'db.session.query',
        user: utente,
        db_service: servizio,
        db_name: nome,
        db_query: testo,
        db_labels: { env: 'prod' },
      },
    },
    quando,
  )

test('audit: separa chi ha guardato da chi ha SCRITTO, e non tiene il testo della query', async () => {
  const { audit } = await conEventi([
    QUERY('utente-uno', 1000, 'select * from tenders where email = \'x@y.z\''),
    QUERY('utente-uno', 1100, "update tenders set stato = 'aperta' where id = 3"),
    QUERY('utente-due', 1200, 'SELECT 1'),
    QUERY('utente-uno', 1300, 'DELETE FROM tenders WHERE id = 4'),
  ])
  const out = await audit({}, { logGroup: '/finto' })
  assert.equal(out.query, 4)
  assert.equal(out.scritture, 2, 'update e delete sono scritture, le select no')
  const uno = out.persone.find((p) => p.utente === 'utente-uno')
  assert.equal(uno.scritture, 2)
  // ⚠️ Il testo della query NON deve uscire da qui: dentro a una WHERE ci sono i dati dei clienti, e
  // questa pagina la guarda chi non ha (e non deve avere) accesso a quei dati.
  assert.doesNotMatch(JSON.stringify(out), /x@y\.z/)
  assert.doesNotMatch(JSON.stringify(out), /select \*/i)
})

test('audit: i database si contano con QUANTE persone li toccano, non solo con quante query', async () => {
  const { audit } = await conEventi([
    QUERY('utente-uno', 1000, 'select 1', 'prod-db', 'tenders'),
    QUERY('utente-due', 1100, 'select 1', 'prod-db', 'tenders'),
    QUERY('utente-uno', 1200, 'select 1', 'staging-db', 'postgres'),
  ])
  const out = await audit({}, { logGroup: '/finto' })
  const tenders = out.database.find((d) => d.nome === 'tenders')
  assert.equal(tenders.query, 2)
  assert.equal(tenders.persone, 2, 'due query di due persone non sono due query di una')
  assert.equal(out.database[0].nome, 'tenders', 'il piu toccato sta in cima')
})

test('audit: il motivo piu comune e quello che risponde a «cosa sta succedendo adesso»', async () => {
  const { audit } = await conEventi([
    LOGIN_FALLITA('a', 1000, 'role x is not found'),
    LOGIN_FALLITA('b', 1100, 'role x is not found'),
    LOGIN_FALLITA('c', 1200, 'access denied'),
  ])
  const out = await audit({}, { logGroup: '/finto' })
  assert.match(out.motivoPiuComune.motivo, /role x is not found/)
  assert.equal(out.motivoPiuComune.quante, 2)
})

test('audit: le righe che non sono JSON non fanno cadere la lettura', async () => {
  const { audit } = await conEventi([
    { timestamp: 1, message: 'Starting session with SessionId: abc' },
    LOGIN_OK('utente-due', 2),
  ])
  const out = await audit({}, { logGroup: '/finto' })
  assert.equal(out.persone.length, 1)
})

test('audit e heartbeat: senza log group non si inventa niente', async () => {
  const { audit, heartbeat } = await import('../server/teleport.js')
  assert.equal(await audit({}, {}), null)
  assert.equal(await heartbeat({}, {}), null)
})

test('heartbeat: tiene la riga PIU RECENTE per macchina e per lato', async () => {
  const { heartbeat } = await conEventi([
    riga({ macchina: 'portatile-uno', lato: 'host', utente: 'utente-uno', immagine: 'sha256:vecchia', esito: 'ok', tool_mancanti: 1 }, 1000),
    riga({ macchina: 'portatile-uno', lato: 'host', utente: 'utente-uno', immagine: 'sha256:nuova', esito: 'ok', tool_mancanti: 0 }, 5000),
    riga({ macchina: 'portatile-uno', lato: 'container', utente: 'utente-uno', immagine: 'sha256:nuova', esito: 'ok', tool_mancanti: 0 }, 4000),
  ])
  const out = await heartbeat({}, { logGroup: '/finto' })
  assert.equal(out.macchine.length, 2, 'host e container sono due stati diversi della stessa macchina')
  const host = out.macchine.find((m) => m.lato === 'host')
  assert.equal(host.immagine, 'sha256:nuova')
  assert.equal(host.toolMancanti, 0)
})

test('heartbeat: piu versioni in giro vuol dire che qualcuno e indietro, e si conta', async () => {
  const { heartbeat } = await conEventi([
    riga({ macchina: 'uno', lato: 'host', immagine: 'sha256:nuova', esito: 'ok', tool_mancanti: 0 }, 3000),
    riga({ macchina: 'due', lato: 'host', immagine: 'sha256:vecchia', esito: 'ok', tool_mancanti: 2 }, 2000),
  ])
  const out = await heartbeat({}, { logGroup: '/finto' })
  assert.equal(out.versioni.length, 2)
  assert.equal(out.conToolMancanti, 1)
})

// ⚠️ Le credenziali di un account si compongono dai suoi CAMPI (roleArn + externalId in cloud,
// profile in locale). Il primo giro leggeva `acc.aws`, che non esiste, e ripiegava su
// `{ profile: <nome> }`: in cloud non ci sono profili, quindi la pagina diceva «Could not resolve
// credentials using profile: [security]» su un account configurato benissimo, cioe' mandava a
// cercare dalla parte sbagliata. Visto in produzione il 29/08/2026, alla prima apertura della pagina.
test('la composizione delle credenziali di un account usa roleArn e externalId, non un profilo inventato', async () => {
  const { readFileSync } = await import('node:fs')
  const sorgente = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
  const blocco = sorgente.slice(sorgente.indexOf('const conto = (nome)'), sorgente.indexOf('const mancante ='))
  assert.match(blocco, /roleArn/, 'senza roleArn in cloud non si assume niente')
  assert.match(blocco, /externalId/, 'senza externalId l assume-role viene rifiutato')
  assert.doesNotMatch(blocco, /profile:\s*nome/, 'il nome dell account non e un profilo AWS')
})

test('un account nominato ma non configurato lo dice, invece di sembrare un problema di credenziali', async () => {
  const { readFileSync } = await import('node:fs')
  const sorgente = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
  assert.match(sorgente, /non configurato in accounts/)
})

// --- sessioni SSH sulle macchine ------------------------------------------------------------------
// Perche' contano: dare a tre persone una shell sul computer delle altre e' accettabile solo se si
// vede chi e' entrato dove. Se questa vista tace, l'accesso resta e la traccia no.

test('ssh: raggruppa per macchina, col nome leggibile e non con l UUID', async () => {
  const { audit } = await conEventi([
    SSH_INIZIO('utente-uno', 'portatile-uno', 1000),
    SSH_FINE('utente-uno', 'portatile-uno', 2000),
    SSH_INIZIO('utente-due', 'portatile-due', 3000),
    SSH_FINE('utente-due', 'portatile-due', 3100),
  ])
  const out = await audit({}, { logGroup: '/finto' })
  assert.equal(out.sessioniSsh, 2)
  assert.equal(out.ssh.length, 2)
  const gio = out.ssh.find((m) => m.macchina === 'portatile-uno')
  assert.deepEqual(gio.chi, ['utente-uno'])
  assert.equal(gio.sessioni, 1)
  // L UUID non deve comparire da nessuna parte: e' il nome che non aiuta chi legge.
  assert.doesNotMatch(JSON.stringify(out), /uuid-che-non-aiuta/)
})

test('ssh: una sessione senza `session.end` resta APERTA, e il numero lo dice', async () => {
  // Il caso che conta davvero: qualcuno e' dentro adesso. Contare solo gli `start` direbbe «2
  // sessioni» senza distinguere quella chiusa da quella in corso.
  const { audit } = await conEventi([
    SSH_INIZIO('utente-uno', 'portatile-uno', 1000),
    SSH_FINE('utente-uno', 'portatile-uno', 1500),
    SSH_INIZIO('utente-tre', 'portatile-uno', 2000),
  ])
  const out = await audit({}, { logGroup: '/finto' })
  assert.equal(out.sessioniSsh, 2)
  assert.equal(out.sshAperte, 1)
  const gio = out.ssh.find((m) => m.macchina === 'portatile-uno')
  assert.equal(gio.aperte, 1)
  assert.deepEqual(gio.chi.sort(), ['utente-tre', 'utente-uno'])
})

test('ssh: un `session.end` orfano non porta le aperte sotto zero', async () => {
  // Succede per davvero: la finestra taglia lo `start` fuori e lascia dentro solo la fine. Un
  // contatore negativo poi si somma agli altri e il totale della pagina diventa sbagliato.
  const { audit } = await conEventi([SSH_FINE('utente-uno', 'portatile-uno', 2000)])
  const out = await audit({}, { logGroup: '/finto' })
  assert.equal(out.sshAperte, 0)
  assert.equal(out.ssh[0].aperte, 0)
  assert.equal(out.ssh[0].sessioni, 0)
})

test('ssh: le sessioni SSH contano anche per PERSONA, e non si mescolano con le sessioni DB', async () => {
  const { audit } = await conEventi([
    SESSIONE_DB('utente-uno', 500),
    SSH_INIZIO('utente-uno', 'portatile-uno', 1000),
    SSH_INIZIO('utente-uno', 'portatile-tre', 1100),
  ])
  const out = await audit({}, { logGroup: '/finto' })
  const primo = out.persone.find((p) => p.utente === 'utente-uno')
  assert.equal(primo.sessioniSsh, 2)
  assert.equal(primo.sessioniDb, 1)
})

test('ssh: nessuna sessione SSH non e un errore, e non inventa macchine', async () => {
  const { audit } = await conEventi([LOGIN_OK('utente-uno', 1000)])
  const out = await audit({}, { logGroup: '/finto' })
  assert.deepEqual(out.ssh, [])
  assert.equal(out.sessioniSsh, 0)
  assert.equal(out.sshAperte, 0)
})
