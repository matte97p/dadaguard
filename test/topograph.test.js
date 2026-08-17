import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMap, buildGroup, groupOf, rollup, fondiArchi, GRUPPI, haSchedule, topologyNodeId, testaComune, nomiDaMostrare, esterniDi } from '../web/topoGraph.js'
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
  // Una state machine orchestra dei passi, non conserva dati: sotto «dove stanno i dati» rispondeva a
  // una domanda che non era quella del gruppo.
  assert.equal(groupOf(svc('order-flow', 'sfn')), 'sched')
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
  const topo = {
    nodes: [nodo('alb', 'alb'), nodo('backend', 'ecs'), nodo('db', 'rds')],
    edges: [arco('alb', 'backend', ['lb']), arco('backend', 'db')],
  }
  const m = buildMap([svc('alb', 'alb'), svc('backend', 'ecs'), svc('db', 'rds')], topo, t)
  for (const n of m.nodes) {
    assert.ok(n.style?.width > 0 && n.style?.height > 0, 'ogni box dichiara la sua misura')
    assert.equal(n.type, 'gruppo')
  }
  // Le colonne le decidono GLI ARCHI: l'ingresso sta a sinistra perché non ha niente che lo chiami, non
  // perché lo abbiamo scritto in un elenco. Su un'architettura diversa il disegno cambia con lei.
  const x = (k) => m.nodes.find((n) => n.data.key === k).position.x
  assert.ok(x('ingress') < x('app'), 'chi riceve da fuori viene prima di chi serve')
  assert.ok(x('app') < x('data'), 'i dati stanno dopo chi li scrive')
  // Senza nessun arco non c'è un verso da mostrare, e inventarlo sarebbe raccontare un flusso che non
  // si è letto: i gruppi finiscono in una colonna sola.
  const senzaArchi = buildMap([svc('alb', 'alb'), svc('backend', 'ecs')], { nodes: [], edges: [] }, t)
  assert.equal(new Set(senzaArchi.nodes.map((n) => n.position.x)).size, 1)
})

test('il riquadro è ALTO quanto quello che ci scrivi dentro', () => {
  // Con l'altezza fissa a 138 un gruppo con quattro nomi, la testa comune, il «+9» e due righe di
  // riassunto scriveva le ultime righe fuori dal bordo: era il difetto che si vedeva a occhio.
  const cron = Array.from({ length: 13 }, (_, i) => svc(`acme-staging-cron-${i}`, 'lambda', { checks: { runtime: { schedule: '1440m', nextRunAt: Date.now() + 60_000 } } }))
  const m = buildMap(cron, { nodes: [], edges: [] }, t)
  const box = m.nodes.find((n) => n.data.key === 'sched')
  assert.ok(box.style.height >= 160, `un box con testa, 4 nomi, «+9» e due righe non sta in ${box.style.height}px`)
  // Un gruppo con un membro solo e una riga di riassunto resta compatto: l'altezza segue il contenuto
  // nei due versi, sennò la mappa diventa una fila di riquadri mezzi vuoti.
  const piccolo = buildMap([svc('alb', 'alb')], { nodes: [], edges: [] }, t)
  assert.ok(piccolo.nodes[0].style.height < 110)
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

test('la testa comune si scrive UNA volta: compattarla in grigio non fa risparmiare un pixel', () => {
  const nomi = ['acme-production-cron-ai-credit-monitor', 'acme-production-cron-follow-competitor', 'acme-production-cron-release-recap']
  assert.equal(testaComune(nomi), 'acme-production-cron-')
  // Un nome solo non ha una testa «comune» con nessuno.
  assert.equal(testaComune(['acme-production-backend']), null)
  // Testa troppo corta: si guadagna niente e si perde il nome intero.
  assert.equal(testaComune(['a-uno', 'a-due']), null)
  // Nessuna testa condivisa.
  assert.equal(testaComune(['backend', 'frontend', 'garanzia']), null)
  // La testa si taglia al confine del trattino, non a metà parola: qui la parte comune è `acme-`
  // (cinque caratteri, sotto la soglia) e NON `acme-prod`, che spezzerebbe `produzione` a metà.
  assert.equal(testaComune(['acme-prod-uno', 'acme-produzione-due']), null)
  assert.equal(testaComune(['acmecorp-prod-uno', 'acmecorp-produzione-due']), 'acmecorp-')
})

test('due nomi identici nel box vengono distinti, invece di sembrare un errore', () => {
  // Due modelli Bedrock diversi possono avere lo stesso nome parlante: cambia l'area di inferenza, che
  // è anche l'informazione che conta (`global.` può uscire dall'Unione Europea).
  const servizi = [
    { name: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', type: 'bedrock' },
    { name: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', type: 'bedrock' },
  ]
  const { nomi } = nomiDaMostrare(servizi, () => 'Claude Haiku 4.5')
  assert.deepEqual(nomi, ['Claude Haiku 4.5', 'Claude Haiku 4.5 · global'])
})

test('nel box compaiono PRIMA i servizi con problemi: su tredici membri il rotto è l’unico che cerchi', () => {
  const servizi = [
    ...Array.from({ length: 12 }, (_, i) => svc(`aaa-cron-${i}`, 'lambda', { checks: { runtime: { schedule: '1440m' } } })),
    svc('zzz-cron-rotto', 'lambda', { overall: 'down', checks: { runtime: { schedule: '1440m' } } }),
  ]
  const m = buildMap(servizi, { nodes: [], edges: [] }, t)
  const box = m.nodes.find((n) => n.data.key === 'sched')
  assert.ok(box.data.nomi[0].includes('rotto'), `atteso il rotto in cima: ${box.data.nomi.join(', ')}`)
  assert.equal(box.data.altri, 9)
})


test('i sistemi di TERZI stanno sulla mappa, e di loro non si dice «nessun problema»', () => {
  // Metà dei dati di uno stack vero sta fuori da AWS (un Supabase, un endpoint di ricerca): senza questi
  // nodi il disegno rispondeva «niente» alla prima domanda che si fa a una topologia, dove finiscono le
  // scritture. Sono pseudo-servizi, non risorse: lo stato non lo conosciamo e non lo si finge.
  const servizi = [svc('backend', 'ecs')]
  const topo = {
    nodes: [nodo('backend', 'ecs')],
    extraNodes: [
      { id: 'ext:host:esempio.co', type: 'esterno', label: 'esempio.co', hosts: ['db.esempio.co'] },
      { id: 'ext:sqs:coda-lavori', type: 'sqs', label: 'coda-lavori' },
      // Nominato solo dall'altro ambiente: qui non c'è nessun arco, quindi non entra.
      { id: 'ext:host:mai-usato.io', type: 'esterno', label: 'mai-usato.io' },
    ],
    edges: [
      { source: 'prod::backend', target: 'ext:host:esempio.co', vias: ['env'] },
      { source: 'ext:sqs:coda-lavori', target: 'prod::backend', vias: ['event'] },
    ],
  }
  assert.deepEqual(esterniDi(servizi, topo).map((x) => x.name), ['esempio.co', 'coda-lavori'])

  const m = buildMap(servizi, topo, t)
  const ext = m.nodes.find((n) => n.data.key === 'ext')
  assert.deepEqual(ext.data.nomi, ['esempio.co'])
  // Una coda non dichiarata è un DATO, non un «sistema esterno»: il gruppo lo decide il tipo, sennò
  // finirebbe dove nessuno la cerca.
  assert.equal(m.nodes.find((n) => n.data.key === 'data').data.nomi[0], 'coda-lavori')
  // Di un sistema di terzi non sappiamo lo stato: la riga lo dice, invece di dichiararlo sano.
  assert.equal(ext.data.frasi.nessunProblema, 'topo.g.unknownState')
  assert.ok(m.edges.some((e) => e.target === 'g:ext'), 'l’arco verso i terzi si disegna')

  // Livello 2: scendendo in «Applicazioni» il vicino esterno non sparisce.
  const g = buildGroup('app', servizi, topo, t)
  assert.ok(g.nodes.some((n) => n.id === 'stub:out:ext'))
  // E il gruppo dei terzi si apre, con gli host che sono l'unica cosa che ne sappiamo.
  const ge = buildGroup('ext', servizi, topo, t)
  assert.deepEqual(ge.nodes.filter((n) => n.type === 'svc').map((n) => [n.id, n.data.meta]), [['ext:host:esempio.co', 'db.esempio.co']])
})


test('il box dice CHI ALTRO ne sta soffrendo, e cede la riga meno utile per farlo', () => {
  // È l'informazione per cui questa pagina esiste: la home elenca chi è rotto, il disegno dice chi
  // dipende da lui. Giallo, non rosso: quei servizi funzionano ancora.
  const servizi = [svc('backend', 'ecs'), svc('frontend', 'ecs')]
  const rischi = new Map([['prod::backend', ['redis']]])
  const m = buildMap(servizi, { nodes: [], edges: [] }, t, { rischi })
  const box = m.nodes.find((n) => n.data.key === 'app')
  assert.equal(box.data.rollup.aRischio, 1)
  assert.equal(box.data.rollup.causa, 'redis')
  // La frase nomina la CAUSA, non la vittima: «1 a rischio» senza dire da cosa costringe a cercare a
  // mano proprio la cosa che il disegno dovrebbe far vedere.
  assert.equal(box.data.frasi.rischio, 'topo.g.risk(1): redis')
  // Nessuno è rotto, quindi l'accento non è rosso: è l'ambra di «dipende da qualcosa che non sta bene».
  assert.equal(box.data.colore, '#faad14')
  // Un guasto vero vince sul rischio: sono due fatti diversi e il primo è più urgente.
  const conRotto = buildMap([svc('backend', 'ecs', { overall: 'down' }), svc('frontend', 'ecs')], { nodes: [], edges: [] }, t, { rischi })
  assert.equal(conRotto.nodes.find((n) => n.data.key === 'app').data.colore, '#ff4d4f')
})

test('scendendo nel gruppo, la card di chi ne soffre è gialla e dice perché', () => {
  const servizi = [svc('backend', 'ecs'), svc('frontend', 'ecs')]
  const g = buildGroup('app', servizi, { nodes: [], edges: [] }, t, { rischi: new Map([['prod::backend', ['redis']]]) })
  const card = g.nodes.find((n) => n.data.name === 'backend')
  assert.equal(card.data.color, '#faad14')
  assert.deepEqual(card.data.rischio, ['redis'])
  assert.equal(g.nodes.find((n) => n.data.name === 'frontend').data.color, '#52c41a')
})
