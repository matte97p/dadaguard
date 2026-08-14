import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, classifyHubs, LANES } from '../web/topoGraph.js'

// Il disegno dell'architettura. Prima queste decisioni vivevano dentro il .jsx e nessuno le provava:
// `node --test` non carica JSX, e ReactFlow non disegna i nodi fuori dal browser — quindi la prova di
// rendering vedeva una tela vuota e non poteva dire niente. Sono decisioni di prodotto: a che livello
// vive una risorsa, chi resta fuori, cosa si collassa perché sennò il disegno diventa una nuvola.

const t = (k, p) => (p?.n != null ? `${k}:${p.n}` : k)
const svc = (name, account, type, overall = 'up') => ({ name, type, overall, account: { key: account, label: account } })
const nodo = (name, account, type) => ({ id: `${account}::${name}`, name, account, type })
const arco = (from, to, vias = ['env']) => ({ source: from, target: to, vias })

test('le corsie sono l’architettura: ingresso → applicazioni → dati, e i cron a parte', () => {
  const services = [svc('alb', 'prod', 'alb'), svc('backend', 'prod', 'ecs'), svc('db', 'prod', 'rds'), svc('nightly', 'prod', 'ecs-scheduled')]
  const topo = {
    nodes: [nodo('alb', 'prod', 'alb'), nodo('backend', 'prod', 'ecs'), nodo('db', 'prod', 'rds'), nodo('nightly', 'prod', 'ecs-scheduled')],
    edges: [arco('prod::alb', 'prod::backend', ['lb']), arco('prod::backend', 'prod::db', ['net']), arco('prod::nightly', 'prod::db', ['net'])],
    extraNodes: [],
  }
  const g = buildGraph(services, topo, false, t)
  const y = (id) => g.nodes.find((n) => n.id === id).position.y
  assert.ok(y('prod::alb') < y('prod::backend'), 'chi riceve la richiesta sta sopra a chi la serve')
  assert.ok(y('prod::backend') < y('prod::db'), 'i dati stanno sotto alle applicazioni')
  assert.ok(y('prod::db') < y('prod::nightly'), 'i cron sono l’ultima corsia')

  // Ogni corsia usata porta la sua fascia, e le fascie stanno PRIMA dei nodi nell'array: in ReactFlow
  // l'ordine è l'ordine di disegno, e una fascia aggiunta dopo coprirebbe le card.
  const fasce = g.nodes.filter((n) => n.type === 'lane')
  assert.equal(fasce.length, 4)
  assert.deepEqual(
    fasce.map((f) => f.id),
    LANES.map((l) => `lane:${l}`),
  )
  assert.ok(g.nodes.findIndex((n) => n.type === 'svc') > g.nodes.findIndex((n) => n.type === 'lane'))
  // La fascia è larga come la corsia più popolata, sennò le corte finiscono a metà del disegno.
  assert.ok(fasce.every((f) => f.data.width === fasce[0].data.width))
  assert.equal(fasce.every((f) => f.draggable === false && f.selectable === false), true)
})

test('i nodi sono card con dati, non stringhe: nome, tipo, colore dello stato', () => {
  const g = buildGraph([svc('backend', 'prod', 'ecs', 'down'), svc('db', 'prod', 'rds')], {
    nodes: [nodo('backend', 'prod', 'ecs'), nodo('db', 'prod', 'rds')],
    edges: [arco('prod::backend', 'prod::db', ['net'])],
    extraNodes: [],
  }, false, t)
  const backend = g.nodes.find((n) => n.id === 'prod::backend')
  assert.equal(backend.type, 'svc')
  assert.equal(backend.data.name, 'backend')
  assert.equal(backend.data.type, 'ecs')
  assert.equal(backend.data.color, '#ff4d4f', 'un servizio giù porta il rosso nel suo accento')
  assert.equal(backend.data.ghost, false)
})

test('l’account nel meta SOLO quando lo stesso nome vive in due ambienti', () => {
  const uno = buildGraph([svc('backend', 'prod', 'ecs'), svc('db', 'prod', 'rds')], {
    nodes: [nodo('backend', 'prod', 'ecs'), nodo('db', 'prod', 'rds')],
    edges: [arco('prod::backend', 'prod::db')],
    extraNodes: [],
  }, false, t)
  assert.equal(uno.nodes.find((n) => n.id === 'prod::backend').data.meta, 'ecs')

  // Stesso nome in due ambienti: il vicino dell'altro ambiente resta disegnato (è contesto), e allora
  // l'account serve a distinguerli.
  const due = buildGraph([svc('backend', 'prod', 'ecs')], {
    nodes: [nodo('backend', 'prod', 'ecs'), nodo('backend', 'staging', 'ecs')],
    edges: [arco('staging::backend', 'prod::backend')],
    extraNodes: [],
  }, false, t)
  assert.ok(due.nodes.find((n) => n.id === 'prod::backend').data.meta.includes('prod'))
})

test('un vicino fuori dal filtro resta, ma come contesto (ghost): togliendolo sparirebbe l’arco', () => {
  const g = buildGraph([svc('backend', 'prod', 'ecs')], {
    nodes: [nodo('backend', 'prod', 'ecs'), nodo('db', 'prod', 'rds')],
    edges: [arco('prod::backend', 'prod::db', ['net'])],
    extraNodes: [],
  }, false, t)
  assert.equal(g.nodes.find((n) => n.id === 'prod::db').data.ghost, true)
  assert.equal(g.ghosts, 1)
  assert.equal(g.edges.length, 1, 'l’arco verso il vicino non si perde')
})

test('un hub di configurazione si collassa: 9 archi che nessuno segue diventano un nodo che li conta', () => {
  const bersagli = Array.from({ length: 6 }, (_, i) => `svc${i}`)
  const services = [svc('doppler-sync', 'prod', 'lambda'), ...bersagli.map((b) => svc(b, 'prod', 'ecs'))]
  const g = buildGraph(services, {
    nodes: [nodo('doppler-sync', 'prod', 'lambda'), ...bersagli.map((b) => nodo(b, 'prod', 'ecs'))],
    // Solo archi in uscita, e tutti dedotti dalle env var: è la forma di un sincronizzatore di
    // configurazione, che nomina tutta la flotta e diventa il nodo più connesso senza servire nessuno.
    edges: bersagli.map((b) => arco('prod::doppler-sync', `prod::${b}`, ['env'])),
    extraNodes: [],
  }, false, t)
  assert.ok(g.nodes.some((n) => n.id === 'agg:prod::doppler-sync'), 'compare il nodo che conta i bersagli')
  assert.equal(g.edges.filter((e) => e.source === 'prod::doppler-sync' && !e.target.startsWith('agg:')).length, 0, 'i 6 archi non si disegnano')
  // I bersagli però restano nel disegno: dirli «senza relazioni» sarebbe dire il falso.
  for (const b of bersagli) assert.ok(g.nodes.some((n) => n.id === `prod::${b}`))
})

test('classifyHubs: serve la FORMA (molti archi in uscita, nessuno in entrata, tutti deboli)', () => {
  const molti = Array.from({ length: 5 }, (_, i) => arco('a', `t${i}`, ['env']))
  assert.equal(classifyHubs(molti).has('a'), true)
  // Pochi archi: è un servizio che ne chiama tre, non un hub.
  assert.equal(classifyHubs(molti.slice(0, 3)).has('a'), false)
  // Riceve anche traffico: è un servizio vero, non un elenco di nomi in una env var.
  assert.equal(classifyHubs([...molti, arco('x', 'a', ['lb'])]).has('a'), false)
  // Un arco FORTE (rete, load balancer) non si collassa: quello è traffico vero.
  assert.equal(classifyHubs([...molti.slice(0, 4), arco('a', 't9', ['net'])]).has('a'), false)
})

test('chi non ha relazioni dedotte non sta nella tela: raggruppato per tipo, in un elenco a lato', () => {
  const g = buildGraph(
    [svc('backend', 'prod', 'ecs'), svc('db', 'prod', 'rds'), ...Array.from({ length: 3 }, (_, i) => svc(`modello${i}`, 'prod', 'bedrock'))],
    { nodes: [nodo('backend', 'prod', 'ecs'), nodo('db', 'prod', 'rds')], edges: [arco('prod::backend', 'prod::db')], extraNodes: [] },
    false,
    t,
  )
  assert.deepEqual(
    g.orphans.map((o) => [o.type, o.items.length]),
    [['bedrock', 3]],
  )
  assert.equal(g.nodes.filter((n) => n.type === 'svc').length, 2, '21 modelli non devono coprire il disegno')
})

test('una corsia lunga VA A CAPO: la tela resta un rettangolo, non una striscia', () => {
  // Tredici applicazioni è il caso vero (staging): in fila sarebbero ~3100px, e dopo l'inquadratura le
  // etichette finiscono a sei pixel — il difetto per cui questa pagina «non si leggeva».
  const molti = Array.from({ length: 13 }, (_, i) => `app${i}`)
  const g = buildGraph(
    [...molti.map((n) => svc(n, 'prod', 'ecs')), svc('db', 'prod', 'rds')],
    {
      nodes: [...molti.map((n) => nodo(n, 'prod', 'ecs')), nodo('db', 'prod', 'rds')],
      edges: molti.map((n) => arco(`prod::${n}`, 'prod::db', ['net'])),
      extraNodes: [],
    },
    false,
    t,
  )
  const card = g.nodes.filter((n) => n.type === 'svc')
  const xMax = Math.max(...card.map((n) => n.position.x))
  const righe = new Set(card.filter((n) => n.data.type === 'ecs').map((n) => n.position.y)).size
  assert.ok(xMax < 1400, `la tela non deve allargarsi: xMax=${xMax}`)
  assert.equal(righe, 3, '13 nodi a 6 per riga = 3 righe')
  // La fascia cresce con le righe, sennò le card della seconda riga escono dal riquadro.
  const fasciaApp = g.nodes.find((n) => n.id === 'lane:app')
  assert.ok(fasciaApp.data.height > 200, `la fascia deve contenere 3 righe: ${fasciaApp.data.height}`)
  // E le corsie sotto scendono di conseguenza: non si sovrappongono a quella cresciuta.
  const fasciaData = g.nodes.find((n) => n.id === 'lane:data')
  assert.ok(fasciaData.position.y > fasciaApp.position.y + fasciaApp.data.height - 1)
})
