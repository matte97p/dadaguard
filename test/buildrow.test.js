import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageTag } from '../server/runtime/ecs.js'
import { displayTag } from '../server/checks/version.js'
import { shortActor } from '../server/util/principal.js'

// La riga "Build" della card mostra COSA gira e chi l'ha messo lì. I valori arrivano grezzi da AWS
// (tag immagine, email dell'autore del commit): qui si fissa la forma con cui vanno in card.

test('imageTag: tag nudo, senza ":" davanti', () => {
  assert.equal(imageTag('123.dkr.ecr.eu-west-1.amazonaws.com/cato-backend:0e89c2198d28'), '0e89c2198d28')
  assert.equal(imageTag('cato-backend:latest'), 'latest')
  assert.equal(imageTag('cato-backend:v2.1.0'), 'v2.1.0')
})

test('imageTag: digest → prime 12 cifre; porta del registry non è un tag', () => {
  assert.equal(imageTag('repo@sha256:9b14dc0eb5a97c0714349a16773f5de47ec7f33b'), '9b14dc0eb5a9')
  assert.equal(imageTag('registry.local:5000/cato-backend'), null)
  assert.equal(imageTag(null), null)
})

// Il ":" davanti al tag rompeva il confronto con la versione attesa dichiarata in config:
// norm(':v2') !== norm('v2') → mismatch inventato. Il tag nudo lo rende confrontabile.
test('imageTag: confrontabile con la versione attesa in config', () => {
  const norm = (v) => String(v).trim().replace(/^v/i, '')
  assert.equal(norm(imageTag('cato-backend:v2.1.0')), norm('2.1.0'))
})

test('displayTag: uno sha lungo si accorcia a 8 (i tag normali restano interi)', () => {
  assert.equal(displayTag('0e89c2198d288ec96ee8822b14f82c868c83ff20'), '0e89c219')
  assert.equal(displayTag('9b14dc0eb5a9'), '9b14dc0eb5a9') // 12 cifre: già corto, invariato
  assert.equal(displayTag('latest'), 'latest')
  assert.equal(displayTag('v2.1.0'), 'v2.1.0')
  assert.equal(displayTag('release-2026-07-27'), 'release-2026-07-27')
  assert.equal(displayTag(null), '')
})

test('shortActor: chi ha deployato, senza il dominio email', () => {
  assert.equal(shortActor('81815192+matte97p@users.noreply.github.com'), 'matte97p')
  assert.equal(shortActor('ggiacometti@get-cato.com'), 'ggiacometti')
  assert.equal(shortActor('giovanni1.giacometti@mail.polimi.it'), 'giovanni1.giacometti')
  assert.equal(shortActor('MatteoPerino'), 'MatteoPerino') // già un nome
  assert.equal(shortActor('GitHub Actions'), 'GitHub Actions')
})

test('shortActor: input strani → niente invenzioni', () => {
  assert.equal(shortActor(null), null)
  assert.equal(shortActor('   '), null)
  assert.equal(shortActor('@handle'), '@handle') // non è un'email: invariato
})

// Il gemello client (web/format.js) è quello che rende "da <nome>" sulla pagina Deploy: se divergesse
// dal server, la stessa persona comparirebbe con due nomi diversi in due punti della UI.
test('shortActor: il gemello client dà gli stessi nomi del server', async () => {
  const { shortActor: webShortActor } = await import('../web/format.js')
  for (const raw of [
    '81815192+matte97p@users.noreply.github.com',
    'ggiacometti@get-cato.com',
    'giovanni1.giacometti@mail.polimi.it',
    'MatteoPerino',
    '@handle',
    null,
    '   ',
  ]) {
    assert.equal(webShortActor(raw), shortActor(raw), `divergenza su ${JSON.stringify(raw)}`)
  }
})
