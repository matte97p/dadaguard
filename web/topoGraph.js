// Come si COSTRUISCE il disegno dell'architettura: chi entra nella tela, in che corsia, con quali archi.
//
// Sta fuori dalla pagina per un motivo che si è visto provando: ReactFlow non disegna i nodi fuori dal
// browser (li misura con un effetto di layout), quindi la prova di rendering senza DOM — l'unico
// controllo automatico che questa UI può avere qui — vedeva una tela vuota e non poteva dire niente su
// corsie, vicini e collassi. Qui dentro non c'è JSX: solo oggetti, e si possono provare.
//
// `MarkerType.ArrowClosed` è una stringa ('arrowclosed'): la si scrive, invece di importare @xyflow per
// una costante, così questo modulo resta caricabile da `node --test` senza tirarsi dietro React.
import { familyPrefixes } from './serviceName.js'

const FRECCIA = 'arrowclosed'

export const STATUS_COLOR = {
  up: '#52c41a',
  degraded: '#faad14',
  down: '#ff4d4f',
  idle: '#8c8c8c',
  disabled: '#8c8c8c',
  unknown: '#8c8c8c',
}

// Provenienza dell'arco (come l'abbiamo dedotto): colore + etichetta per la legenda.
export const VIA = {
  declared: { color: '#8c8c8c' },
  env: { color: '#1677ff' },
  event: { color: '#7c3aed' },
  flow: { color: '#eb2f96' },
  iam: { color: '#08979c' },
  lb: { color: '#fa8c16' },
  net: { color: '#13c2c2' },
}

// Chiave di un servizio nel grafo, gemella di `topologyNodeId` in server/topology/deduce.js — dove gli
// archi nascono già con questa forma. NON è il nome: `backend` esiste in staging e in produzione, e i
// modelli Bedrock stanno in ogni account. Usare il nome fondeva due servizi in un nodo solo (con lo
// stato di quello letto per ultimo) e duplicava le `key` React della lista laterale, che così
// accumulava righe morte invece di sostituirle.
export function topologyNodeId(s) {
  const acct = (typeof s.account === 'string' ? s.account : s.account?.key) ?? '__none__'
  return `${acct}::${s.name}`
}
export const acctLabel = (s) => (typeof s.account === 'string' ? s.account : s.account?.label) ?? null

// Corsia di un nodo: il disegno deve avere una spina dorsale (chi riceve la richiesta → chi la serve
// → dove stanno i dati), altrimenti dagre appiattisce tutto su due livelli e ne esce una fila larga
// 1700px che, dopo il fitView, ha le etichette a 6px.
export const LANE_OF_TYPE = {
  alb: 'ingress',
  'cloudflare-worker': 'ingress',
  cloudfront: 'ingress',
  apigateway: 'ingress',
  ecs: 'app',
  ec2: 'app',
  lambda: 'app',
  sfn: 'app',
  'ecs-scheduled': 'ops',
  rds: 'data',
  elasticache: 'data',
  kinesis: 'data',
  sqs: 'data',
  s3: 'data',
  dynamodb: 'data',
}
export const LANES = ['ingress', 'app', 'data', 'ops']

// Un hub è un nodo che punta a molti servizi SOLO perché li nomina nelle env var: i sincronizzatori
// di configurazione citano tutta la flotta, quindi diventano i nodi più connessi del disegno pur non
// servendo nessuna richiesta. Si riconosce dalla forma (molti archi in uscita, nessuno in entrata),
// non dal nome, così un tool nuovo ci ricade dentro senza toccare una lista.
const HUB_MIN_FANOUT = 4
const WEAK_VIAS = new Set(['env', 'iam'])

export function classifyHubs(edges) {
  const out = new Map()
  const incoming = new Set(edges.map((e) => e.target))
  for (const e of edges) {
    if (!out.has(e.source)) out.set(e.source, [])
    out.get(e.source).push(e)
  }
  const hubs = new Set()
  for (const [source, list] of out) {
    if (incoming.has(source)) continue
    if (list.length < HUB_MIN_FANOUT) continue
    if (!list.every((e) => (e.vias ?? []).every((v) => WEAK_VIAS.has(v)))) continue
    hubs.add(source)
  }
  return hubs
}

// --- Vista "Dipendenze": corsie per ruolo, nodi colorati per stato, archi per provenienza. ---
// `services` arriva già filtrato; `topo.nodes` porta la flotta INTERA. Serve la differenza: filtrando
// per un nome, il servizio all'altro capo dell'arco spariva e con esso ogni arco, così cercare un
// servizio nella vista che ne mostra le dipendenze le cancellava. I vicini fuori dal filtro restano
// disegnati, ma smorzati: sono contesto, non risultato.
export function buildGraph(services, topo, dark, t) {
  const universe = new Map((topo.nodes ?? []).map((n) => [n.id, n]))
  const selected = new Map(services.map((s) => [topologyNodeId(s), s]))
  const external = new Map((topo.extraNodes ?? []).map((n) => [n.id, n]))
  const known = (id) => selected.has(id) || universe.has(id) || external.has(id)

  const allEdges = (topo.edges ?? []).filter((e) => known(e.source) && known(e.target))
  // Un arco entra nel disegno se almeno un estremo è dentro al filtro: l'altro diventa un vicino.
  const edges = allEdges.filter((e) => selected.has(e.source) || selected.has(e.target))
  const hubs = classifyHubs(edges)

  const nameOf = (id) => selected.get(id)?.name ?? universe.get(id)?.name ?? external.get(id)?.label ?? id
  const typeOf = (id) => selected.get(id)?.type ?? universe.get(id)?.type ?? external.get(id)?.type ?? null
  const statusOf = (id) => selected.get(id)?.overall ?? null
  // `topo.nodes` porta la CHIAVE dell'account ('production'), i servizi la sua etichetta
  // ('Production'): senza tradurla, un vicino fuori dal filtro finiva accanto a un servizio dentro al
  // filtro con lo stesso account scritto in due modi, che si legge come un errore.
  const accountLabels = new Map(services.map((s) => [topologyNodeId(s).split('::')[0], acctLabel(s)]).filter(([, l]) => l))
  const accountOf = (id) => {
    const s = selected.get(id)
    if (s) return acctLabel(s)
    const raw = universe.get(id)?.account ?? null
    return raw ? accountLabels.get(raw) ?? raw : null
  }

  // Il nome si ripete tra ambienti: l'etichetta porta l'account solo quando serve a distinguerli.
  const nameCount = new Map()
  for (const id of new Set([...selected.keys(), ...allEdges.flatMap((e) => [e.source, e.target])])) {
    const n = nameOf(id)
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1)
  }

  // Ogni estremo di un arco resta nel disegno, hub compresi: il collasso toglie le LINEE, non i nodi.
  // Togliere anche i bersagli farebbe finire un servizio vero fra quelli «senza relazioni dedotte»,
  // cioè direbbe «nessuna relazione» per dire «relazione collassata» — la confusione che questa
  // pagina esiste per evitare.
  const inGraph = new Set()
  for (const e of edges) {
    inGraph.add(e.source)
    inGraph.add(e.target)
  }
  const collapsed = []
  for (const id of hubs) {
    const list = edges.filter((e) => e.source === id)
    collapsed.push({ source: id, targets: list.map((e) => e.target), vias: [...new Set(list.flatMap((e) => e.vias ?? []))] })
  }
  const drawnEdges = edges.filter((e) => !hubs.has(e.source))

  const laneOf = (id) => (hubs.has(id) ? 'ops' : external.has(id) ? 'data' : LANE_OF_TYPE[typeOf(id)] ?? 'app')
  const byLane = new Map(LANES.map((l) => [l, []]))
  for (const id of inGraph) byLane.get(laneOf(id))?.push(id)
  for (const id of hubs) if (!byLane.get('ops').includes(id)) byLane.get('ops').push(id)
  for (const list of byLane.values()) list.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))

  // Le corsie danno i livelli, ma dentro un livello l'ordine alfabetico fa attraversare la tela agli
  // archi. Ordinamento a baricentro (Sugiyama): ogni nodo si sposta verso la media delle posizioni dei
  // suoi vicini nella corsia adiacente, una passata in giù e una in su. È quello che faceva dagre e
  // che si perde imponendo i livelli a mano.
  const neighboursIn = (id, laneList, dir) =>
    drawnEdges
      .filter((e) => (dir === 'up' ? e.target === id : e.source === id))
      .map((e) => laneList.indexOf(dir === 'up' ? e.source : e.target))
      .filter((i) => i >= 0)
  const sweep = (from, to, dir) => {
    const anchor = byLane.get(from) ?? []
    const list = byLane.get(to) ?? []
    if (!anchor.length || list.length < 2) return
    const bary = new Map(
      list.map((id) => {
        const idx = neighboursIn(id, anchor, dir)
        return [id, idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : Number.POSITIVE_INFINITY]
      }),
    )
    list.sort((a, b) => bary.get(a) - bary.get(b) || nameOf(a).localeCompare(nameOf(b)))
  }
  sweep('ingress', 'app', 'up')
  sweep('app', 'data', 'up')
  sweep('data', 'app', 'down')
  sweep('app', 'ingress', 'down')

  const NODE_W = 208
  const NODE_H = 52
  const GAP_X = 30
  const GAP_Y = 40
  const LANE_PAD = 26
  // Una corsia VA A CAPO. Senza, la corsia più popolata decide la larghezza di tutta la tela: sui dati
  // veri erano 13 nodi in fila, cioè 3100px, e dopo il `fitView` le etichette finivano a 6px — che è
  // esattamente il difetto per cui questa pagina «non si leggeva». A capo ogni 6, la tela resta larga
  // ~1400px e il disegno sta in uno schermo: un rettangolo si legge, una striscia no.
  const PER_RIGA = 6
  const nodes = []
  // I prefissi di famiglia si contano su TUTTI i nomi disegnati: la testa muta funziona solo se è la
  // stessa su tutte le card (l'occhio la salta una volta e non ci torna).
  const prefissi = familyPrefixes([...inGraph].map(nameOf))

  const laneVisibili = LANES.filter((l) => (byLane.get(l) ?? []).length > 0)
  const righeDi = (lane) => Math.max(1, Math.ceil((byLane.get(lane) ?? []).length / PER_RIGA))
  const colonneDi = (lane) => Math.min(PER_RIGA, (byLane.get(lane) ?? []).length || 1)

  // Prima le fasce, poi i nodi: in ReactFlow l'ordine dell'array è l'ordine di disegno, e una fascia
  // aggiunta dopo coprirebbe le card.
  const laneY = new Map()
  let y = 0
  for (const lane of laneVisibili) {
    laneY.set(lane, y)
    y += righeDi(lane) * NODE_H + (righeDi(lane) - 1) * GAP_Y + LANE_PAD * 2 + GAP_Y
  }
  const larghezzaMax = Math.max(...laneVisibili.map((l) => colonneDi(l) * (NODE_W + GAP_X) - GAP_X + LANE_PAD * 2), NODE_W + LANE_PAD * 2)
  laneVisibili.forEach((lane) => {
    nodes.push({
      id: `lane:${lane}`,
      type: 'lane',
      position: { x: -LANE_PAD, y: laneY.get(lane) - LANE_PAD },
      data: {
        label: t(`topo.lane.${lane}`),
        width: larghezzaMax,
        height: righeDi(lane) * NODE_H + (righeDi(lane) - 1) * GAP_Y + LANE_PAD * 2,
      },
      draggable: false,
      selectable: false,
      style: { pointerEvents: 'none' },
    })
  })

  laneVisibili.forEach((lane) => {
    const list = byLane.get(lane) ?? []
    list.forEach((id, i) => {
      const ghost = !selected.has(id) && !external.has(id)
      const color = external.has(id) ? '#bfbfbf' : STATUS_COLOR[statusOf(id)] ?? '#8c8c8c'
      const conto = accountOf(id)
      nodes.push({
        id,
        type: 'svc',
        position: {
          x: (i % PER_RIGA) * (NODE_W + GAP_X),
          y: laneY.get(lane) + Math.floor(i / PER_RIGA) * (NODE_H + GAP_Y),
        },
        data: {
          name: nameOf(id),
          prefissi,
          type: typeOf(id),
          color,
          ghost,
          // Il meta porta il tipo, e l'account SOLO quando lo stesso nome vive in più ambienti: in una
          // vista già filtrata per ambiente, ripeterlo su ogni card è trenta volte la stessa parola.
          meta: [typeOf(id), nameCount.get(nameOf(id)) > 1 ? conto : null].filter(Boolean).join(' · '),
          title: [nameOf(id), conto, typeOf(id)].filter(Boolean).join(' · '),
        },
      })
    })
  })

  collapsed.forEach((c, i) => {
    nodes.push({
      id: `agg:${c.source}`,
      type: 'svc',
      // Sotto TUTTE le corsie (`y` a fine ciclo è il fondo della tela): dentro una corsia che è andata
      // a capo si sovrapporrebbe alle card, e questi nodi non appartengono a un livello — sono un modo
      // di NON disegnare nove archi che nessuno seguirebbe.
      position: { x: i * (NODE_W + GAP_X), y: y + GAP_Y },
      data: {
        name: t('topo.hubTargets', { n: c.targets.length }),
        prefissi: null,
        type: null,
        color: VIA.env.color,
        ghost: true,
        meta: c.vias.join(' · '),
        title: c.targets.join('\n'),
      },
      draggable: false,
    })
  })

  const rfEdges = drawnEdges.map((e) => {
    const broken = ['down', 'degraded'].includes(statusOf(e.target))
    const primary = e.vias?.[0] ?? 'declared'
    const color = broken ? '#ff4d4f' : VIA[primary]?.color ?? '#888'
    return {
      id: `${e.source}->${e.target}`,
      source: e.source,
      target: e.target,
      // Curve morbide, non gomiti: un diagramma di flusso si segue con l'occhio, e gli angoli retti su
      // cento archi diventano un circuito stampato.
      type: 'bezier',
      markerEnd: { type: FRECCIA, color, width: 14, height: 14 },
      animated: broken,
      style: { stroke: color, strokeDasharray: primary === 'net' && !broken ? '6 6' : undefined },
      label: broken ? `⚠ ${t('topo.edge.down')}` : undefined,
      labelStyle: { fontSize: 10 },
    }
  })
  collapsed.forEach((c) => {
    rfEdges.push({
      id: `${c.source}->agg`,
      source: c.source,
      target: `agg:${c.source}`,
      type: 'smoothstep',
      markerEnd: { type: FRECCIA, color: VIA.env.color },
      style: { stroke: VIA.env.color, strokeWidth: 1.5, strokeDasharray: '2 3' },
      label: `×${c.targets.length}`,
      labelStyle: { fontSize: 10 },
    })
  })

  // Chi resta fuori dal grafo, raggruppato per tipo: 21 modelli e 8 worker non sono «servizi orfani»,
  // e in un elenco piatto di 52 righe coprivano il disegno invece di completarlo.
  const orphanByType = new Map()
  for (const s of services) {
    if (inGraph.has(topologyNodeId(s))) continue
    const type = s.type ?? '—'
    if (!orphanByType.has(type)) orphanByType.set(type, [])
    orphanByType.get(type).push({ key: topologyNodeId(s), name: s.name, status: s.overall, account: acctLabel(s) })
  }
  const orphans = [...orphanByType.entries()]
    .map(([type, items]) => ({ type, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.items.length - a.items.length)

  const usedVias = new Set(drawnEdges.flatMap((e) => e.vias ?? []).concat(collapsed.length ? ['env'] : []))
  const ghosts = [...inGraph].filter((id) => !selected.has(id) && !external.has(id)).length
  return { nodes, edges: rfEdges, usedVias, orphans, ghosts }
}

