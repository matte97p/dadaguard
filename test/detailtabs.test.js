// Quali schede offre il pannello di un servizio. Una scheda che si apre su "questo tipo non ha log"
// è una promessa non mantenuta: si clicca una volta, poi non si crede più al pannello.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detailTabs } from '../web/format.js'

test('lambda ed ECS hanno i log; gli altri tipi no', () => {
  assert.equal(detailTabs({ type: 'lambda' }).logs, true)
  assert.equal(detailTabs({ type: 'ecs' }).logs, true)
  assert.equal(detailTabs({ type: 'ecs-scheduled' }).logs, true)
  assert.equal(detailTabs({ type: 's3' }).logs, false)
  assert.equal(detailTabs({ type: 'rds' }).logs, false)
  assert.equal(detailTabs({ type: 'cloudflare-worker' }).logs, false)
})

test('gli eventi ci sono dove AWS li racconta: non per un worker Cloudflare', () => {
  // I worker non stanno in CloudTrail: la scheda mostrerebbe sempre "niente".
  assert.equal(detailTabs({ type: 'cloudflare-worker' }).events, false)
  assert.equal(detailTabs({ type: 'ecs' }).events, true)
  assert.equal(detailTabs({ type: 's3' }).events, true)
})

test('senza tipo: nessuna scheda oltre la panoramica', () => {
  assert.deepEqual(detailTabs({}), { logs: false, events: false, deploy: false })
  assert.deepEqual(detailTabs(null), { logs: false, events: false, deploy: false })
  assert.deepEqual(detailTabs(undefined), { logs: false, events: false, deploy: false })
})

test('il bottone Deploy appare solo dove c’è davvero una build', () => {
  assert.equal(detailTabs({ type: 'ecs', checks: { version: { status: 'up' } } }).deploy, true)
  // Un bucket o un cluster non hanno build: la pagina Deploy non avrebbe niente da dire su di loro.
  assert.equal(detailTabs({ type: 's3', checks: { security: {} } }).deploy, false)
  assert.equal(detailTabs({ type: 'ecs' }).deploy, false)
})

test('un worker Cloudflare tiene il Deploy ma perde log ed eventi', () => {
  // È il caso dello screenshot: admin-frontend ha una build (c9d0e1f2) ma non un log group AWS.
  assert.deepEqual(detailTabs({ type: 'cloudflare-worker', checks: { version: {} } }), {
    logs: false,
    events: false,
    deploy: true,
  })
})
