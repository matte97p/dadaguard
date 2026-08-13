// La mappa `health` è l'unico modo di sondare un servizio SCOPERTO: non ha un campo dove scrivere
// `healthUrl`, il nome è tutto quello che si ha. Qui si fissa che sonda SOLO dove c'è un bersaglio
// vero — un path su un host indovinato darebbe rossi finti, il danno peggiore per un pannello di
// monitoraggio (una volta che mente non lo si guarda più).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyHealthUrls, byServiceName, applyExpectedHealthy } from '../server/status.js'

const svc = (name, account = 'staging', extra = {}) => ({ name, account, ...extra })

test('byServiceName: `account/nome` batte il nome secco', () => {
  const map = { backend: 'https://generico', 'production/backend': 'https://specifico' }
  assert.equal(byServiceName(map, 'production', 'backend'), 'https://specifico')
  assert.equal(byServiceName(map, 'staging', 'backend'), 'https://generico')
  assert.equal(byServiceName(map, 'staging', 'altro'), null)
  assert.equal(byServiceName(null, 'staging', 'backend'), null)
})

test('URL intero: usato così com’è', () => {
  const out = applyHealthUrls([svc('backend')], { backend: 'https://staging-endpoint.example.com/health' }, null)
  assert.equal(out[0].healthUrl, 'https://staging-endpoint.example.com/health')
})

test('path relativo: risolto sull’URL dichiarato in `urls`', () => {
  const urls = { backend: 'https://staging-endpoint.example.com' }
  const out = applyHealthUrls([svc('backend')], { backend: '/health' }, urls)
  assert.equal(out[0].healthUrl, 'https://staging-endpoint.example.com/health')
})

test('path relativo senza URL di base: NESSUNA sonda', () => {
  // Il servizio scoperto porta il DNS grezzo dell'ALB, che da fuori non risponde: inventarci sopra
  // un `/health` darebbe un rosso che non parla dell'applicazione.
  const out = applyHealthUrls([svc('backend')], { backend: '/health' }, null)
  assert.equal(out[0].healthUrl, undefined)
})

test('healthUrl dichiarato a mano: la mappa non lo tocca', () => {
  const declared = svc('backend', 'staging', { healthUrl: 'https://mio/health' })
  const urls = { backend: 'https://staging-endpoint.example.com' }
  const out = applyHealthUrls([declared], { backend: '/altro' }, urls)
  assert.equal(out[0].healthUrl, 'https://mio/health')
})

test('servizi non mappati restano intatti, e senza mappa non si fa nulla', () => {
  const services = [svc('backend'), svc('scraper')]
  const out = applyHealthUrls(services, { backend: 'https://x/health' }, null)
  assert.equal(out[1].healthUrl, undefined)
  assert.equal(applyHealthUrls(services, null, null), services)
})

test('URL di base malformato: si degrada a nessuna sonda, non a un errore', () => {
  const out = applyHealthUrls([svc('backend')], { backend: '/health' }, { backend: 'non-un-url' })
  assert.equal(out[0].healthUrl, undefined)
})

// --- applyExpectedHealthy: la config per i servizi SCOPERTI ---
// Il load balancer del writer Postgres lo trova la discovery, quindi non c'e' nessun posto dove
// scrivergli «qui i sani attesi sono 1»: senza questa mappa la modifica al provider era irraggiungibile
// proprio nel caso per cui e' stata scritta.
test('expectedHealthy: la mappa arriva ai servizi scoperti, per nome e per account/nome', () => {
  const servizi = [
    { name: 'db-writer', account: 'staging', aws: { type: 'alb', name: 'x' } },
    { name: 'db-writer', account: 'production', aws: { type: 'alb', name: 'y' } },
    { name: 'api', account: 'staging', aws: { type: 'alb', name: 'z' } },
  ]
  const out = applyExpectedHealthy(servizi, { 'staging/db-writer': 1, api: 2 })
  assert.equal(out[0].aws.expectedHealthy, 1, 'account/nome vince sul nome secco')
  assert.equal(out[1].aws.expectedHealthy, undefined, 'l-altro account non viene toccato')
  assert.equal(out[2].aws.expectedHealthy, 2, 'il nome secco vale per tutti gli account')
})

test('expectedHealthy: quello dichiarato a mano sul servizio vince sulla mappa', () => {
  const servizi = [{ name: 'db-writer', account: 'staging', aws: { type: 'alb', expectedHealthy: 3 } }]
  assert.equal(applyExpectedHealthy(servizi, { 'staging/db-writer': 1 })[0].aws.expectedHealthy, 3)
})

test('expectedHealthy: senza mappa, o su un servizio senza blocco aws, non cambia niente', () => {
  const servizi = [{ name: 'x', account: 'staging' }]
  assert.equal(applyExpectedHealthy(servizi, null), servizi)
  assert.equal(applyExpectedHealthy(servizi, { x: 1 })[0].aws, undefined)
})
