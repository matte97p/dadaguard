import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupByService, isServiceRow, GRUPPO_SG } from '../web/deployRows.js'
import { isByHand, isManualRestart } from '../web/deployKinds.js'

// Come si raggruppano le righe della pagina Deploy. Sono decisioni di prodotto, non dettagli di resa:
// cosa sta accanto a cosa, cosa entra nel tasso di successo, e cosa NON è un servizio.

const build = (service, status, minutiFa, extra = {}) => ({
  id: `${service}-${minutiFa}`,
  service,
  status,
  startedAt: new Date(Date.now() - minutiFa * 60_000).toISOString(),
  ...extra,
})

test('un security group NON è un servizio: le sue righe finiscono in un gruppo a parte', () => {
  const righe = [
    build('backend', 'SUCCEEDED', 10),
    build('sg-0046fdc5fa3522a28', 'SUCCEEDED', 20, { kind: 'sg-open', porte: [5432] }),
    build('sg-0c593b7eb052e9109', 'SUCCEEDED', 30, { kind: 'sg-open', porte: [4200] }),
    build('sg-0c593b7eb052e9109', 'SUCCEEDED', 25, { kind: 'sg-close', porte: [4200] }),
  ]
  const gruppi = groupByService(righe)
  // Un gruppo per il servizio vero, UNO per tutte le porte: prima erano tre gruppi chiamati con un id.
  assert.deepEqual(
    gruppi.map((g) => g.service),
    ['backend', GRUPPO_SG],
  )
  assert.equal(gruppi.find((g) => g.sgGroup).builds.length, 3)
})

test('le porte aperte a mano stanno in FONDO: importanti, ma non sono un rilascio', () => {
  const gruppi = groupByService([
    build('sg-1', 'SUCCEEDED', 1, { kind: 'sg-open', porte: [5432] }), // la più recente di tutte
    build('zeta', 'SUCCEEDED', 50),
    build('alfa', 'SUCCEEDED', 60),
  ])
  assert.deepEqual(
    gruppi.map((g) => g.service),
    ['alfa', 'zeta', GRUPPO_SG],
  )
})

test('chi sta uscendo ADESSO va in cima, prima dell’ordine alfabetico', () => {
  const gruppi = groupByService([
    build('alfa', 'SUCCEEDED', 10),
    build('zeta', 'IN_PROGRESS', 1, { inProgress: true }),
  ])
  assert.deepEqual(
    gruppi.map((g) => g.service),
    ['zeta', 'alfa'],
  )
})

test('il tasso di successo conta solo le BUILD: un riavvio non dice niente sui rilasci', () => {
  const g = groupByService([
    build('backend', 'SUCCEEDED', 10),
    build('backend', 'FAILED', 20),
    // Tre riavvii riusciti per rimettere in piedi il servizio: se contassero, un servizio che va male
    // sembrerebbe più sano proprio perché è stato riavviato tre volte.
    build('backend', 'SUCCEEDED', 5, { kind: 'restart' }),
    build('backend', 'SUCCEEDED', 6, { kind: 'restart' }),
    build('backend', 'SUCCEEDED', 7, { kind: 'restart' }),
  ])[0]
  assert.equal(g.ok, 1)
  assert.equal(g.failed, 1)
  assert.equal(g.builds.length, 5, 'la lista mostra tutto: è il CONTEGGIO che esclude i riavvii')
  assert.equal(g.trend.length, 2)
})

test('isServiceRow / isManualRestart / isByHand: chi è cosa', () => {
  assert.equal(isServiceRow({ kind: 'sg-open' }), false)
  assert.equal(isServiceRow({ kind: 'sg-close' }), false)
  assert.equal(isServiceRow({ kind: 'exec' }), true) // una shell è dentro a un servizio: quello è il suo posto
  assert.equal(isServiceRow({ kind: 'restart' }), true)
  assert.equal(isServiceRow({}), true)

  assert.equal(isManualRestart({ kind: 'exec' }), true)
  assert.equal(isManualRestart({ kind: 'pages' }), false)
  assert.equal(isByHand({ trigger: 'hotfix' }), true)
  assert.equal(isByHand({ trigger: 'auto' }), false)
})

test('una riga senza servizio non fa sparire il gruppo: cade su project, poi su un segnaposto', () => {
  const gruppi = groupByService([{ id: 'x', project: 'acme-backend-deploy', status: 'SUCCEEDED', startedAt: new Date().toISOString() }, { id: 'y', status: 'SUCCEEDED', startedAt: new Date().toISOString() }])
  assert.deepEqual(gruppi.map((g) => g.service).sort(), ['acme-backend-deploy', '—'])
})
