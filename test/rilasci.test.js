// «La mia modifica è già in produzione?» è la domanda che oggi si risponde aprendo un compare su
// GitHub. Qui si inchioda come si risponde, perché una tabella che sbaglia il verdetto è peggio del
// non averla: manda in produzione con la convinzione che sia già uscito, o il contrario.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ambienteDi, ultimoRilascioPerServizio, tabellaRilasci, daRilasciare, testoRilasci } from '../server/rilasci.js'

const build = (service, commit, startedAt, status = 'SUCCEEDED', extra = {}) => ({ service, commit, startedAt, status, ...extra })

test('ambiente dalla chiave account, come nelle notifiche', () => {
  assert.equal(ambienteDi('production'), 'produzione')
  assert.equal(ambienteDi('prod-eu'), 'produzione')
  assert.equal(ambienteDi('staging'), 'staging')
  assert.equal(ambienteDi('stg'), 'staging')
  // payer e security non fanno deploy applicativi: restano fuori invece di dare una colonna vuota.
  assert.equal(ambienteDi('management'), null)
  assert.equal(ambienteDi('security'), null)
})

test('quello che gira è l’ultimo deploy RIUSCITO, non l’ultimo tentativo', () => {
  const m = ultimoRilascioPerServizio([
    build('backend', 'vecchio', '2026-08-13T10:00:00Z'),
    build('backend', 'fallito', '2026-08-13T11:00:00Z', 'FAILED'),
    build('backend', 'in-corso', '2026-08-13T12:00:00Z', 'IN_PROGRESS'),
  ])
  assert.equal(m.get('backend').commit, 'vecchio', 'una build fallita o in corso non è ciò che gira')
})

test('la tabella affianca staging e produzione e dice se sono allineati', () => {
  const righe = tabellaRilasci({
    staging: { builds: [build('backend', 'aaa', '2026-08-13T10:00:00Z'), build('frontend', 'ccc', '2026-08-13T09:00:00Z')] },
    production: { builds: [build('backend', 'bbb', '2026-08-12T10:00:00Z'), build('frontend', 'ccc', '2026-08-12T09:00:00Z')] },
    management: { builds: [] },
  })
  const perNome = Object.fromEntries(righe.map((r) => [r.servizio, r]))
  assert.equal(perNome.backend.allineato, false, 'commit diversi: c’è qualcosa da rilasciare')
  assert.equal(perNome.frontend.allineato, true, 'stesso commit: allineato')
  assert.deepEqual(
    daRilasciare(righe).map((r) => r.servizio),
    ['backend'],
  )
})

test('un servizio che vive in un ambiente solo NON è «da rilasciare»', () => {
  // `cato-admin` e le sonde stanno solo in staging per scelta: contarli come non rilasciati sarebbe
  // rumore permanente, ed è il modo in cui una lista del genere smette di essere letta.
  const righe = tabellaRilasci({
    staging: { builds: [build('cato-admin', 'ddd', '2026-08-13T08:00:00Z')] },
    production: { builds: [] },
  })
  assert.equal(righe[0].allineato, null)
  assert.equal(righe[0].soloIn, 'staging')
  assert.deepEqual(daRilasciare(righe), [])
})

test('il payload accetta sia { builds } sia la lista secca', () => {
  const righe = tabellaRilasci({ staging: [build('api', 'aaa', '2026-08-13T10:00:00Z')], production: { builds: [build('api', 'aaa', '2026-08-12T10:00:00Z')] } })
  assert.equal(righe.length, 1)
  assert.equal(righe[0].allineato, true)
})

test('forma testo: leggibile in un terminale, e dice in fondo cosa resta', () => {
  const righe = tabellaRilasci({
    staging: { builds: [build('backend', 'aaa1111', '2026-08-13T10:00:00Z'), build('frontend', 'ccc3333', '2026-08-13T09:00:00Z')] },
    production: { builds: [build('backend', 'bbb2222', '2026-08-12T10:00:00Z'), build('frontend', 'ccc3333', '2026-08-12T09:00:00Z')] },
  })
  const testo = testoRilasci(righe)
  assert.match(testo, /backend\s+staging aaa1111\s+prod bbb2222\s+DA RILASCIARE/)
  assert.match(testo, /frontend.*allineato/)
  assert.match(testo, /Da rilasciare \(1\): backend/)
})

test('forma testo: quando è tutto allineato lo dice, invece di lasciare una tabella muta', () => {
  const righe = tabellaRilasci({
    staging: { builds: [build('api', 'aaa', '2026-08-13T10:00:00Z')] },
    production: { builds: [build('api', 'aaa', '2026-08-12T10:00:00Z')] },
  })
  assert.match(testoRilasci(righe), /Tutto allineato/)
  assert.match(testoRilasci([]), /nessun deploy applicativo trovato/)
})
