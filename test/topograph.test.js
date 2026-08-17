import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMap, buildGroup, groupOf, rollup, fondiArchi, GRUPPI, haSchedule, topologyNodeId } from '../web/topoGraph.js'
import { topologyNodeId as chiaveServer } from '../server/topology/deduce.js'

// La MAPPA dell'architettura. Queste sono decisioni di prodotto, non dettagli di resa: chi entra in
// quale gruppo, cosa dice un box, quando una freccia è una freccia vera. E ReactFlow non disegna niente
// fuori dal browser, quindi se non si provano qui non le prova nessuno.

const t = (k, p) => (p ? `${k}(${Object.values(p).join(',')})` : k)
const svc = (name, type, extra = {}) => ({ name, type, overall: 'up', account: { key: 'prod', label: 'Prod' }, ...extra })
const nodo = (name, type) => ({ id: `prod::${name}`, name, account: 'prod', type })
const arco = (a, b, vias = ['env']) => ({ source: `prod::${a}`, target: `prod::${b}`, vias })

test('PARTIZIONE TOTALE: ogni servizio finisce in un gruppo, anche i tipi che nessuno aveva previsto', () => {
  // I tipi sono quelli veri della modalità demo, che è l'immagine pubblica del progetto: una whitelist
  // chiusa la svuoterebbe, e nessuno se ne accorgerebbe finché non la lancia un estraneo.
  const tipi = ['alb', 'ecs', 'lambda', 'rds', 'ec2', 's3', 'acm', 'elasticache', 'kinesis', 'sfn', 'ecs-scheduled', 'cloudflare-worker', 'bedrock', 'tipo-mai-visto']
  const servizi = tipi.map((tp, i) => svc(`s${i}`, tp))
  const chiavi = new Set(GRUPPI.map((g) => g.key))
  for (const s of servizi) {
    const g = groupOf(s)
    assert.ok(chiavi.has(g), `${s.type} finito in un gruppo inesistente: ${g}`)
  }
  const m = buildMap(servizi, { nodes: [], edges: [] }, t)
  const somma = m.nodes.reduce((n, x) => n + x.data.rollup.membri, 0)
  assert.equal(somma, servizi.length, 'nessun servizio può sparire dalla mappa')
  assert.ok(m.nodes.some((n) => n.data.key === 'other'), 'i tipi non previsti hanno il loro box')
})

test('una lambda a ORARIO non sta con quelle a evento: il tipo AWS è lo stesso, il mestiere no', () => {
  const aOrario = svc('nightly', 'lambda', { checks: { runtime: { schedule: '1440m', nextRunAt: Date.now() + 3600_000 } } })
  const aEvento = svc('webhook', 'lambda')
  assert.equal(haSchedule(aOrario), true)
  assert.equal(groupOf(aOrario), 'sched')
  assert.equal(groupOf(aEvento), 'event')
  assert.equal(groupOf(svc('task', 'ecs-scheduled')), 'sched')
})

test('il roll-up conta i PROBLEMI, non gli attivi: senza traffico non è un guasto', () => {
  const r = rollup([
    svc('a', 'ecs', { overall: 'up', checks: { runtime: { runningCount: 2, desiredCount: 2 } } }),
    svc('b', 'ecs', { overall: 'down', checks: { runtime: { runningCount: 0, desiredCount: 1 } } }),
    // Nove modelli mai invocati nella finestra: `idle`. Contarli fra i non-attivi direbbe «4 su 9»,
    // che si legge come un guasto e non lo è.
    ...Array.from({ length: 9 }, (_, i) => svc(`m${i}`, 'bedrock', { overall: 'idle' })),
  ])
  assert.equal(r.membri, 11)
  assert.equal(r.problemi, 1)
  assert.equal(r.primoProblema, 'b', 'su un box con dodici membri, «1 problema» senza il nome costringe ad aprire')
  assert.equal(r.fermi, 9)
  assert.deepEqual(r.task, { attivi: 2, voluti: 3, male: true })
})

test('il roll-up non inventa i task dove i numeri non esistono', () => {
  // `runningCount`/`desiredCount` stanno solo sui servizi ECS: su un gruppo di lambda la riga dei task
  // sarebbe «0/0», che si legge come «nessuno gira».
  assert.equal(rollup([svc('a', 'lambda'), svc('b', 'lambda')]).task, null)
})

test('gli archi fra gruppi si FONDONO in uno per coppia, e quelli interni spariscono dalla mappa', () => {
  const gruppoDi = (id) => (id.includes('alb') ? 'ingress' : id.includes('db') ? 'data' : 'app')
  const fusi = fondiArchi(
    [
      arco('alb', 'backend', ['lb']),
      arco('alb', 'frontend', ['lb']),
      arco('backend', 'db', ['env']),
      arco('backend', 'frontend', ['env']), // interno al gruppo app: non si disegna sulla mappa
    ],
    gruppoDi,
  )
  assert.deepEqual(
    fusi.map((f) => [f.source, f.target, f.n, f.forte]),
    [
      ['ingress', 'app', 2, true],
      ['app', 'data', 1, false],
    ],
  )
})

test('la freccia dice quanto ci si può credere: piena se c’è un puntatore vero, tratteggiata se dedotta', () => {
  const servizi = [svc('alb', 'alb'), svc('backend', 'ecs'), svc('db', 'rds')]
  const topo = {
    nodes: [nodo('alb', 'alb'), nodo('backend', 'ecs'), nodo('db', 'rds')],
    edges: [arco('alb', 'backend', ['lb']), arco('backend', 'db', ['env'])],
  }
  const m = buildMap(servizi, topo, t)
  const piena = m.edges.find((e) => e.source === 'g:ingress')
  const tratteggiata = m.edges.find((e) => e.source === 'g:app')
  assert.equal(piena.style.strokeDasharray, undefined)
  assert.ok(tratteggiata.style.strokeDasharray, 'una relazione dedotta da un nome non si disegna come un flusso')
})

test('la mappa emette la GEOMETRIA sui nodi: ReactFlow misura, e due misure diverse storcono gli archi', () => {
  const m = buildMap([svc('alb', 'alb'), svc('backend', 'ecs')], { nodes: [], edges: [] }, t)
  for (const n of m.nodes) {
    assert.ok(n.style?.width > 0 && n.style?.height > 0, 'ogni box dichiara la sua misura')
    assert.equal(n.type, 'gruppo')
  }
  // Colonne: l'ingresso a sinistra, le applicazioni dopo. Il verso è quello di un diagramma di flusso.
  const x = (k) => m.nodes.find((n) => n.data.key === k).position.x
  assert.ok(x('ingress') < x('app'))
})

test('dentro un gruppo: le risorse, e ai bordi gli STUB dei vicini (uno per gruppo, non per risorsa)', () => {
  const servizi = [svc('alb', 'alb'), svc('backend', 'ecs'), svc('frontend', 'ecs'), svc('db', 'rds')]
  const topo = {
    nodes: [nodo('alb', 'alb'), nodo('backend', 'ecs'), nodo('frontend', 'ecs'), nodo('db', 'rds')],
    edges: [arco('alb', 'backend', ['lb']), arco('alb', 'frontend', ['lb']), arco('backend', 'db', ['env'])],
  }
  const g = buildGroup('app', servizi, topo, t)
  const risorse = g.nodes.filter((n) => n.type === 'svc')
  const stub = g.nodes.filter((n) => n.type === 'stub')
  assert.deepEqual(risorse.map((n) => n.data.name).sort(), ['backend', 'frontend'])
  // Due archi in entrata dallo stesso gruppo → UNO stub, che li conta. Sennò il secondo livello
  // ridiventa il grafo intero, che è la cosa da cui si sta scappando.
  assert.deepEqual(
    stub.map((n) => [n.id, n.data.n]),
    [
      ['stub:in:ingress', 2],
      ['stub:out:data', 1],
    ],
  )
  assert.ok(g.nodes.every((n) => n.style?.width > 0))
})

test('le maniglie del disegno sono coerenti col verso: chiave di nodo unica fra server e web', () => {
  // Erano due funzioni omonime con firme diverse: due chiavi che divergono fondono o sdoppiano i nodi
  // in silenzio. Ora il web importa quella del server, e questo test lo dimostra sulla stessa fixture.
  const s = { name: 'backend', account: { key: 'prod', label: 'Prod' } }
  assert.equal(topologyNodeId(s), chiaveServer('backend', 'prod'))
  assert.equal(topologyNodeId(s), chiaveServer('backend', { key: 'prod' }))
  assert.equal(topologyNodeId('prod::backend'), 'prod::backend')
})

test('un ambiente senza niente non esplode: mappa vuota, e lo dice', () => {
  const m = buildMap([], { nodes: [], edges: [] }, t)
  assert.deepEqual(m.nodes, [])
  assert.equal(m.vuoto, true)
})
