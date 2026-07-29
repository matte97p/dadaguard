import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceKey } from '../web/serviceName.js'
import { findService } from '../server/status.js'

// Un servizio è identificato da ACCOUNT + NOME. Il nome da solo è ambiguo su una flotta multi-account
// — `backend` esiste in staging e in produzione, i modelli Bedrock in entrambi — e cercare per nome
// apriva il servizio dell'altro ambiente: la tabella diceva "234 invocazioni, 1 errore 5xx" su
// produzione e il pannello rispondeva "nessuna invocazione in 60m" perché guardava staging.

// Come li vede il frontend: l'account è un oggetto con `key`.
const FE = [
  { name: 'eu.anthropic.claude-opus-5', type: 'bedrock', account: { key: 'staging', label: 'Staging' } },
  { name: 'eu.anthropic.claude-opus-5', type: 'bedrock', account: { key: 'production', label: 'Production' } },
  { name: 'dadaguard', type: 'ecs', account: null },
]

test('serviceKey: due omonimi in account diversi hanno chiavi diverse', () => {
  assert.notEqual(serviceKey(FE[0]), serviceKey(FE[1]))
  assert.equal(serviceKey(FE[0]), 'staging/eu.anthropic.claude-opus-5')
  assert.equal(serviceKey(FE[1]), 'production/eu.anthropic.claude-opus-5')
})

test('serviceKey: senza account resta una chiave valida (non "undefined/…")', () => {
  assert.equal(serviceKey(FE[2]), '—/dadaguard')
  assert.equal(serviceKey(null), '—/')
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
