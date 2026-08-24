import { test } from 'node:test'
import assert from 'node:assert/strict'
import { targetIndex } from '../server/watchlist.js'

// Togliere un servizio dalla watchlist è una SCRITTURA su services.yaml che dalla dashboard non si
// annulla. Il bersaglio era il nome nudo, e il nome nudo non identifica una voce: due voci omonime
// (una ECS e il suo ALB, la stessa ECS in due cluster, lo stesso nome in due account) sono due
// monitoraggi diversi, e cancellare la prima che combacia toglie quello sbagliato dicendo "fatto".

const ECS = { name: 'gateway', account: 'security', aws: { type: 'ecs', cluster: 'app', service: 'gateway' } }
const ALB = { name: 'gateway', account: 'security', aws: { type: 'alb', arn: 'arn:aws:elb:gateway' } }
const ALTRA_ECS = { name: 'gateway', account: 'security', aws: { type: 'ecs', cluster: 'batch', service: 'gateway' } }
const idDi = (e) => `${e.account}|${e.aws.type}|${['function', 'cluster', 'service', 'taskDefinition', 'instance', 'table', 'bucket', 'arn', 'id', 'stream', 'asg', 'instanceId', 'queue', 'url', 'topic'].map((f) => e.aws[f] ?? '').join('|')}`

test('targetIndex: con l identità di risorsa cancella la voce CLICCATA, non la prima omonima', () => {
  const entries = [ECS, ALB, ALTRA_ECS]
  assert.equal(targetIndex(entries, { name: 'gateway', account: 'security', resourceId: idDi(ALB) }), 1)
  assert.equal(targetIndex(entries, { name: 'gateway', account: 'security', resourceId: idDi(ALTRA_ECS) }), 2)
})

test('targetIndex: bersaglio ambiguo → errore, MAI una cancellazione a caso', () => {
  // Nessun `resourceId` (payload vecchio, o voce senza identificatori) e più voci omonime: qui
  // indovinare vuol dire togliere il monitoraggio di un altro servizio.
  assert.throws(() => targetIndex([ECS, ALB], { name: 'gateway', account: 'security' }), /combacia con 2 voci/)
})

test('targetIndex: un solo omonimo non ha bisogno dell identità', () => {
  assert.equal(targetIndex([ECS], { name: 'gateway', account: 'security' }), 0)
  assert.equal(targetIndex([ECS], 'gateway'), 0, 'la stringa nuda resta accettata')
})

test('targetIndex: l account distingue due voci con lo stesso nome', () => {
  const staging = { name: 'api', account: 'staging' }
  const production = { name: 'api', account: 'production' }
  assert.equal(targetIndex([staging, production], { name: 'api', account: 'production' }), 1)
})

test('targetIndex: una voce senza account nel file resta cancellabile', () => {
  // Senza `account` la voce vale per l'account che le assegna il risolutore: scartarla vorrebbe dire
  // non cancellare mai niente.
  assert.equal(targetIndex([{ name: 'api' }], { name: 'api', account: 'production' }), 0)
})

test('targetIndex: nome che non c è → -1, non un indice qualsiasi', () => {
  assert.equal(targetIndex([ECS], { name: 'inesistente' }), -1)
  assert.equal(targetIndex([ECS], {}), -1)
  assert.equal(targetIndex([], { name: 'gateway' }), -1)
})

test('targetIndex: identità che non combacia con nessuna delle omonime → errore, non un ripiego', () => {
  // Se la riga cliccata dice una risorsa che nel file non c'è, il file è cambiato sotto: fermarsi.
  assert.throws(
    () => targetIndex([ECS, ALB], { name: 'gateway', account: 'security', resourceId: 'security|asg|||||||||altro' }),
    /combacia con 2 voci/,
  )
})
