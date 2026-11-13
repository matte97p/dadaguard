// La scheda del servizio mostrava la chiave interna della risorsa, con tutte le barre dei campi vuoti.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { risorsaLeggibile } from '../web/servizi.js'

test('restano solo i pezzi che dicono quale risorsa', () => {
  assert.equal(risorsaLeggibile('demo|ecs||acme-cluster|api||||||||||||'), 'acme-cluster / api')
  assert.equal(risorsaLeggibile('cloudflare|cloudflare-worker|edge-router'), 'edge-router')
})

test('senza pezzi utili non si mostra niente', () => {
  assert.equal(risorsaLeggibile(null), null)
  assert.equal(risorsaLeggibile('demo|ecs||||'), null)
})
