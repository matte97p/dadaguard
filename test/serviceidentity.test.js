import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceKey } from '../web/serviceName.js'
import { findService } from '../server/status.js'
import { resourceId } from '../server/autodiscover.js'

// Un servizio è identificato da ACCOUNT + REGION + TIPO + NOME. Il nome da solo è ambiguo su una
// flotta multi-account (`backend` esiste in staging e in produzione, i modelli Bedrock in entrambi) e
// cercare per nome apriva il servizio dell'altro ambiente: la tabella diceva "234 invocazioni, 1
// errore 5xx" su produzione e il pannello rispondeva "nessuna invocazione in 60m" perché guardava
// staging. E account + nome è ambiguo DENTRO un account: la discovery fa un candidato per risorsa
// (una ECS, il suo ALB e il suo autoscaling group portano lo stesso nome AWS) e lo sweep
// multi-region rilegge quel nome in ogni region. La chiave è anche il `rowKey` della tabella e la
// chiave delle card: due righe con la stessa chiave lasciano righe FANTASMA nel DOM quando la lista
// si accorcia, cioè righe verdi sotto un filtro "solo giù".

// Come li vede il frontend: l'account è un oggetto con `key`.
const FE = [
  { name: 'eu.anthropic.claude-opus-5', type: 'bedrock', region: 'eu-west-1', account: { key: 'staging', label: 'Staging' } },
  { name: 'eu.anthropic.claude-opus-5', type: 'bedrock', region: 'eu-west-1', account: { key: 'production', label: 'Production' } },
  { name: 'dadaguard', type: 'ecs', account: null },
]

test('serviceKey: due omonimi in account diversi hanno chiavi diverse', () => {
  assert.notEqual(serviceKey(FE[0]), serviceKey(FE[1]))
  assert.equal(serviceKey(FE[0]), 'staging/eu-west-1/bedrock/eu.anthropic.claude-opus-5')
  assert.equal(serviceKey(FE[1]), 'production/eu-west-1/bedrock/eu.anthropic.claude-opus-5')
})

test('serviceKey: senza account resta una chiave valida (non "undefined/…")', () => {
  assert.equal(serviceKey(FE[2]), '—/—/ecs/dadaguard')
  assert.equal(serviceKey(null), '—/—/—/')
})

// Gli omonimi DENTRO lo stesso account: è il caso che lasciava le righe fantasma. Tre entry con lo
// stesso nome nello stesso account, distinte da tipo o region, devono avere tre chiavi diverse.
const OMONIMI = [
  { name: 'acme-gateway', type: 'ecs', region: 'eu-west-1', account: { key: 'security', label: 'Security' } },
  { name: 'acme-gateway', type: 'alb', region: 'eu-west-1', account: { key: 'security', label: 'Security' } },
  { name: 'acme-gateway', type: 'ecs', region: 'eu-central-1', account: { key: 'security', label: 'Security' } },
]

test('serviceKey: omonimi nello stesso account (tipi o region diverse) hanno chiavi DIVERSE', () => {
  const chiavi = new Set(OMONIMI.map(serviceKey))
  assert.equal(chiavi.size, OMONIMI.length)
})

test('serviceKey: nessuna chiave duplicata su una flotta con omonimi (rowKey della tabella)', () => {
  const flotta = [...FE, ...OMONIMI]
  const chiavi = flotta.map(serviceKey)
  assert.equal(new Set(chiavi).size, chiavi.length)
})

test('serviceKey: la riga cliccata apre SE STESSA, non l omonimo di un altro tipo', () => {
  const clicked = OMONIMI[1] // la riga dell'ALB, non quella del servizio ECS
  const found = OMONIMI.find((s) => serviceKey(s) === serviceKey(clicked))
  // `assert.ok` prima di leggere `found.type`: se la chiave cambia forma e non combacia più niente,
  // senza questo il test muore su "Cannot read properties of undefined" invece di dire cosa si
  // aspettava, proprio sull'asserzione che è il punto di tutto.
  assert.ok(found, 'nessun servizio trovato con la chiave della riga cliccata')
  assert.equal(found.type, 'alb')
})

// Il caso che account + region + tipo + nome NON distingue: due servizi ECS con lo stesso nome in
// cluster diversi dello stesso account e della stessa region. AWS li ammette (il nome di un servizio
// ECS è unico per cluster, non per account) e la discovery li emette entrambi. Li separa solo
// l'identità della risorsa che il server manda nel payload.
const CLUSTER = [
  { name: 'worker', type: 'ecs', region: 'eu-west-1', account: { key: 'security' }, resourceId: resourceId({ account: 'security', aws: { type: 'ecs', cluster: 'app', service: 'worker' } }) },
  { name: 'worker', type: 'ecs', region: 'eu-west-1', account: { key: 'security' }, resourceId: resourceId({ account: 'security', aws: { type: 'ecs', cluster: 'batch', service: 'worker' } }) },
]

test('serviceKey: due ECS omonime in cluster diversi hanno chiavi diverse', () => {
  assert.notEqual(serviceKey(CLUSTER[0]), serviceKey(CLUSTER[1]))
})

test('resourceId: senza identificatori di risorsa è null, e la chiave ripiega su region+tipo+nome', () => {
  // Un servizio dichiarato a mano in services.yaml può non avere ID: meglio un ripiego dichiarato che
  // una chiave `account|tipo|||…` identica per tutti, che sarebbe una collisione travestita.
  assert.equal(resourceId({ account: 'security', aws: { type: 'ecs' } }), null)
  assert.equal(serviceKey({ name: 'worker', type: 'ecs', region: 'eu-west-1', account: { key: 'security' }, resourceId: null }), 'security/eu-west-1/ecs/worker')
})

test('serviceKey: account come STRINGA (forma del server) non collassa tutti sul sentinella', () => {
  const a = { name: 'agentic-chat', type: 'ecs', region: 'eu-west-1', account: 'staging' }
  const b = { name: 'agentic-chat', type: 'ecs', region: 'eu-west-1', account: 'production' }
  assert.notEqual(serviceKey(a), serviceKey(b))
  assert.equal(serviceKey(a), 'staging/eu-west-1/ecs/agentic-chat')
})

test('serviceKey: la ricerca per chiave prende il servizio CLICCATO, non il primo omonimo', () => {
  const clicked = FE[1] // riga "Claude Opus 5 · Production"
  const found = FE.find((s) => serviceKey(s) === serviceKey(clicked))
  assert.equal(found.account.label, 'Production')
})

// Come li vede il server: l'account è la sua chiave (stringa).
const BE = [
  { name: 'agentic-chat', account: 'staging' },
  { name: 'agentic-chat', account: 'production' },
  { name: 'dadaguard' },
]

test('findService: nome + account risolve l ambiente giusto', () => {
  assert.equal(findService(BE, { service: 'agentic-chat', account: 'production' }).account, 'production')
  assert.equal(findService(BE, { service: 'agentic-chat', account: 'staging' }).account, 'staging')
})

test('findService: account dichiarato che non combacia → null, MAI l altro ambiente', () => {
  // Meglio un 404 che i log di un altro ambiente: quelli sembrano una risposta valida.
  assert.equal(findService(BE, { service: 'agentic-chat', account: 'security' }), null)
})

test('findService: senza account resta il primo omonimo (chiamate vecchie, nomi unici)', () => {
  assert.equal(findService(BE, { service: 'agentic-chat' }).account, 'staging')
  assert.equal(findService(BE, { service: 'dadaguard', account: '—' }).name, 'dadaguard')
  assert.equal(findService(BE, { service: 'inesistente', account: 'staging' }), null)
})
