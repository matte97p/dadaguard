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

async function conEventi(eventi) {
  // Il finto client: risponde una pagina sola e nessun token.
  const modulo = await import('../server/teleport.js?' + Math.random())
  const sdk = await import('@aws-sdk/client-cloudwatch-logs')
  mock.method(sdk.CloudWatchLogsClient.prototype, 'send', async () => ({ events: eventi }))
  return modulo
}

test('audit: separa le login fallite da quelle riuscite e tiene il motivo per intero', async () => {
  const { audit } = await conEventi([
    LOGIN_FALLITA('gabboclaa', 1000, 'role db-cato-staging-read-ssm is not found'),
    LOGIN_FALLITA('gabboclaa', 2000, 'role db-cato-staging-read-ssm is not found'),
    LOGIN_OK('matte97p', 3000),
    SESSIONE_DB('matte97p', 3500),
    SESSIONE_DB('matte97p', 3600),
  ])
  const out = await audit({}, { logGroup: '/finto', ore: 24 })
  assert.equal(out.loginFallite, 2)
  const gabbo = out.persone.find((p) => p.utente === 'gabboclaa')
  assert.equal(gabbo.loginFallite, 2)
  assert.equal(gabbo.loginOk, 0)
  // ⚠️ Il motivo NON si accorcia a «errore»: e' la differenza fra una sessione scaduta e un ruolo che
  // sul cluster non esiste, cioe' fra «normale» e «tutto il team e' fuori».
  assert.match(gabbo.motivo, /role db-cato-staging-read-ssm is not found/)
  const matteo = out.persone.find((p) => p.utente === 'matte97p')
  assert.equal(matteo.loginOk, 1)
  assert.equal(matteo.sessioniDb, 2)
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
    LOGIN_OK('matte97p', 2),
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
    riga({ macchina: 'mac-di-gabri', lato: 'host', utente: 'gabboclaa', immagine: 'sha256:vecchia', esito: 'ok', tool_mancanti: 1 }, 1000),
    riga({ macchina: 'mac-di-gabri', lato: 'host', utente: 'gabboclaa', immagine: 'sha256:nuova', esito: 'ok', tool_mancanti: 0 }, 5000),
    riga({ macchina: 'mac-di-gabri', lato: 'container', utente: 'gabboclaa', immagine: 'sha256:nuova', esito: 'ok', tool_mancanti: 0 }, 4000),
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
