import { useEffect, useMemo, useState } from 'react'
import { Segmented, Empty, Typography, Spin, Space, Alert } from 'antd'
import { ReactFlow, Background, Controls, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { PageIntro } from './pageKit.jsx'

const { Text } = Typography

const STATUS_COLOR = {
  up: '#52c41a',
  degraded: '#faad14',
  down: '#ff4d4f',
  idle: '#8c8c8c',
  disabled: '#8c8c8c',
  unknown: '#8c8c8c',
}

// Provenienza dell'arco (come l'abbiamo dedotto): colore + etichetta per la legenda.
const VIA = {
  declared: { color: '#8c8c8c' },
  env: { color: '#1677ff' },
  event: { color: '#7c3aed' },
  flow: { color: '#eb2f96' },
  iam: { color: '#08979c' },
  lb: { color: '#fa8c16' },
  net: { color: '#13c2c2' },
}

// Chiave di un servizio nel grafo, gemella di `serviceKey` in server/topology/deduce.js — dove gli
// archi nascono già con questa forma. NON è il nome: `backend` esiste in staging e in produzione, e i
// modelli Bedrock stanno in ogni account. Usare il nome fondeva due servizi in un nodo solo (con lo
// stato di quello letto per ultimo) e duplicava le `key` React della lista laterale, che così
// accumulava righe morte invece di sostituirle.
export function svcKey(s) {
  const acct = (typeof s.account === 'string' ? s.account : s.account?.key) ?? '__none__'
  return `${acct}::${s.name}`
}
const acctLabel = (s) => (typeof s.account === 'string' ? s.account : s.account?.label) ?? null

// Corsia di un nodo: il disegno deve avere una spina dorsale (chi riceve la richiesta → chi la serve
// → dove stanno i dati), altrimenti dagre appiattisce tutto su due livelli e ne esce una fila larga
// 1700px che, dopo il fitView, ha le etichette a 6px.
const LANE_OF_TYPE = {
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
const LANES = ['ingress', 'app', 'data', 'ops']

// Un hub è un nodo che punta a molti servizi SOLO perché li nomina nelle env var: i sincronizzatori
// di configurazione citano tutta la flotta, quindi diventano i nodi più connessi del disegno pur non
// servendo nessuna richiesta. Si riconosce dalla forma (molti archi in uscita, nessuno in entrata),
// non dal nome, così un tool nuovo ci ricade dentro senza toccare una lista.
const HUB_MIN_FANOUT = 4
const WEAK_VIAS = new Set(['env', 'iam'])

function classifyHubs(edges) {
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
function buildGraph(services, topo, dark, t) {
  const universe = new Map((topo.nodes ?? []).map((n) => [n.id, n]))
  const selected = new Map(services.map((s) => [svcKey(s), s]))
  const external = new Map((topo.extraNodes ?? []).map((n) => [n.id, n]))
  const known = (id) => selected.has(id) || universe.has(id) || external.has(id)

  const allEdges = (topo.edges ?? []).filter((e) => known(e.source) && known(e.target))
  // Un arco entra nel disegno se almeno un estremo è dentro al filtro: l'altro diventa un vicino.
  const edges = allEdges.filter((e) => selected.has(e.source) || selected.has(e.target))
  const hubs = classifyHubs(edges)

  const nameOf = (id) => selected.get(id)?.name ?? universe.get(id)?.name ?? external.get(id)?.label ?? id
  const typeOf = (id) => selected.get(id)?.type ?? universe.get(id)?.type ?? external.get(id)?.type ?? null
  const statusOf = (id) => selected.get(id)?.overall ?? null

  // Il nome si ripete tra ambienti: l'etichetta porta l'account solo quando serve a distinguerli.
  const nameCount = new Map()
  for (const id of new Set([...selected.keys(), ...allEdges.flatMap((e) => [e.source, e.target])])) {
    const n = nameOf(id)
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1)
  }

  const inGraph = new Set()
  for (const e of edges) {
    inGraph.add(e.source)
    inGraph.add(e.target)
  }
  // Gli archi degli hub collassano: una freccia sola con il conteggio, non sei che attraversano la tela.
  const collapsed = []
  const drawnEdges = []
  for (const id of hubs) {
    const list = edges.filter((e) => e.source === id)
    collapsed.push({ source: id, targets: list.map((e) => e.target), vias: [...new Set(list.flatMap((e) => e.vias ?? []))] })
    for (const e of list) inGraph.delete(e.target)
  }
  for (const e of edges) if (!hubs.has(e.source)) drawnEdges.push(e)
  for (const e of drawnEdges) {
    inGraph.add(e.source)
    inGraph.add(e.target)
  }

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

  const NODE_W = 190
  const NODE_H = 46
  const GAP_X = 26
  const LANE_H = 150
  const nodes = []
  LANES.forEach((lane) => {
    const list = byLane.get(lane) ?? []
    if (!list.length) return
    const y = LANES.indexOf(lane) * LANE_H
    list.forEach((id, i) => {
      const ghost = !selected.has(id) && !external.has(id)
      const color = external.has(id) ? '#bfbfbf' : STATUS_COLOR[statusOf(id)] ?? '#8c8c8c'
      const label = nameCount.get(nameOf(id)) > 1 && acctLabel(selected.get(id) ?? universe.get(id) ?? {})
        ? `${nameOf(id)} · ${acctLabel(selected.get(id) ?? universe.get(id))}`
        : nameOf(id)
      nodes.push({
        id,
        position: { x: i * (NODE_W + GAP_X), y },
        data: { label: `${label}${typeOf(id) ? ` · ${typeOf(id)}` : ''}` },
        style: {
          border: `2px ${external.has(id) || ghost ? 'dashed' : 'solid'} ${color}`,
          borderRadius: 8,
          padding: '6px 10px',
          fontSize: 12,
          width: NODE_W,
          opacity: ghost ? 0.45 : 1,
          background: dark ? '#1f1f1f' : '#fff',
          color: dark ? '#e6e6e6' : '#000',
        },
      })
    })
  })

  // Nodo sintetico per ogni hub collassato: dice QUANTI servizi tocca, e quali nel tooltip.
  collapsed.forEach((c, i) => {
    const id = `agg:${c.source}`
    nodes.push({
      id,
      position: { x: i * (NODE_W + GAP_X), y: LANES.indexOf('ops') * LANE_H + 60 },
      data: { label: t('topo.hubTargets', { n: c.targets.length }) },
      style: {
        border: `1.5px dotted ${VIA.env.color}`,
        borderRadius: 8,
        padding: '4px 8px',
        fontSize: 11,
        width: NODE_W,
        background: 'transparent',
        color: dark ? '#a6a6a6' : '#595959',
      },
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
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color },
      animated: broken,
      style: {
        stroke: color,
        strokeWidth: broken ? 2 : 1.5,
        strokeDasharray: primary === 'net' && !broken ? '5 5' : undefined,
      },
      label: broken ? `⚠ ${t('topo.edge.down')}` : undefined,
    }
  })
  collapsed.forEach((c) => {
    rfEdges.push({
      id: `${c.source}->agg`,
      source: c.source,
      target: `agg:${c.source}`,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color: VIA.env.color },
      style: { stroke: VIA.env.color, strokeWidth: 1.5, strokeDasharray: '2 3' },
      label: `×${c.targets.length}`,
      labelStyle: { fontSize: 10 },
    })
  })

  // Chi resta fuori dal grafo, raggruppato per tipo: 21 modelli e 8 worker non sono «servizi orfani»,
  // e in un elenco piatto di 52 righe coprivano il disegno invece di completarlo.
  const orphanByType = new Map()
  for (const s of services) {
    if (inGraph.has(svcKey(s))) continue
    const type = s.type ?? '—'
    if (!orphanByType.has(type)) orphanByType.set(type, [])
    orphanByType.get(type).push({ key: svcKey(s), name: s.name, status: s.overall, account: acctLabel(s) })
  }
  const orphans = [...orphanByType.entries()]
    .map(([type, items]) => ({ type, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.items.length - a.items.length)

  const usedVias = new Set(drawnEdges.flatMap((e) => e.vias ?? []).concat(collapsed.length ? ['env'] : []))
  const ghosts = [...inGraph].filter((id) => !selected.has(id) && !external.has(id)).length
  return { nodes, edges: rfEdges, usedVias, orphans, ghosts }
}

// --- Vista "Rete": box VPC che contengono i servizi, più un bucket "Senza VPC". ---
function buildNetworkGraph(net, dark, t) {
  const groups = []
  for (const acc of net.accounts ?? []) {
    for (const v of acc.vpcs ?? []) {
      const egress = [v.igw ? 'IGW' : null, v.nat > 0 ? `NAT×${v.nat}` : null].filter(Boolean).join(' · ')
      const services = (v.subnets ?? []).flatMap((s) =>
        s.services.map((name) => ({
          name,
          sub: [s.name || s.id, s.az, t(s.public ? 'topo.subnetPublic' : 'topo.subnetPrivate')]
            .filter(Boolean)
            .join(' · '),
        })),
      )
      groups.push({
        id: `vpc:${acc.account}:${v.id}`,
        title: v.name || v.id,
        subtitle: [acc.label, v.cidr, egress ? `→ ${egress}` : null].filter(Boolean).join(' · '),
        color: acc.color || '#8c8c8c',
        services,
      })
    }
    if ((acc.noVpc ?? []).length) {
      groups.push({
        id: `novpc:${acc.account}`,
        title: t('topo.noVpc'),
        subtitle: `${acc.label} · ${t('topo.noVpcSub')}`,
        color: acc.color || '#8c8c8c',
        dim: true,
        services: acc.noVpc.map((name) => ({ name, sub: null })),
      })
    }
  }

  const GW = 250
  const HEADER = 48
  const ROW = 42
  const PADB = 14
  const GAPX = 36
  const nodes = []
  let x = 0
  for (const g of groups) {
    const count = Math.max(1, g.services.length)
    nodes.push({
      id: g.id,
      position: { x, y: 0 },
      data: { label: '' },
      draggable: false,
      selectable: false,
      style: {
        width: GW,
        height: HEADER + count * ROW + PADB,
        borderRadius: 10,
        border: `1.5px ${g.dim ? 'dashed' : 'solid'} ${g.color}`,
        background: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
      },
    })
    nodes.push({
      id: `${g.id}::h`,
      parentId: g.id,
      extent: 'parent',
      draggable: false,
      selectable: false,
      position: { x: 10, y: 8 },
      data: {
        label: (
          <div style={{ textAlign: 'left', width: GW - 32 }}>
            <div style={{ fontWeight: 600, fontSize: 12 }}>{g.title}</div>
            <div style={{ fontSize: 10, opacity: 0.7 }}>{g.subtitle}</div>
          </div>
        ),
      },
      style: { border: 'none', background: 'transparent', padding: 0, width: GW - 20 },
    })
    g.services.forEach((s, i) => {
      nodes.push({
        id: `${g.id}::${s.name}`,
        parentId: g.id,
        extent: 'parent',
        draggable: false,
        position: { x: 12, y: HEADER + i * ROW },
        data: {
          label: (
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 12 }}>{s.name}</div>
              {s.sub && <div style={{ fontSize: 10, opacity: 0.65 }}>{s.sub}</div>}
            </div>
          ),
        },
        style: {
          width: GW - 24,
          borderRadius: 6,
          border: `1px solid ${dark ? '#303030' : '#d9d9d9'}`,
          background: dark ? '#1f1f1f' : '#fff',
          padding: 6,
        },
      })
    })
    x += GW + GAPX
  }
  return { nodes, hasData: groups.length > 0 }
}

function Legend({ usedVias, t }) {
  const keys = Object.keys(VIA).filter((k) => usedVias.has(k))
  if (!keys.length) return null
  return (
    <Space size={12} wrap style={{ marginBottom: 8 }}>
      {keys.map((k) => (
        <Space key={k} size={4}>
          <span
            style={{
              display: 'inline-block',
              width: 18,
              height: 0,
              borderTop: `2px ${k === 'net' ? 'dashed' : 'solid'} ${VIA[k].color}`,
            }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t(`topo.legend.${k}`)}
          </Text>
        </Space>
      ))}
      <Space size={4}>
        <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: '2px solid #ff4d4f' }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('topo.legend.down')}
        </Text>
      </Space>
    </Space>
  )
}

const CANVAS = {
  height: 'calc(100vh - 280px)',
  minHeight: 420,
  border: '1px solid rgba(128,128,128,0.2)',
  borderRadius: 8,
  position: 'relative',
}

// Pagina Topologia: due lenti. "Dipendenze" = relazioni dedotte da AWS (env/event/flow/lb/SG).
// "Rete" = dove vive ogni servizio (VPC → subnet) + egress. Entrambe read-only, on-demand.
// `services` arriva GIÀ filtrato dai filtri globali; la vista Rete si restringe agli stessi account.
export default function TopologyPage({ services = [], accountLabels, dark, t = (k) => k }) {
  const [view, setView] = useState('deps')
  const [topo, setTopo] = useState({ edges: [], extraNodes: [], nodes: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [net, setNet] = useState(null)
  const [netLoading, setNetLoading] = useState(false)
  const [netError, setNetError] = useState(null)

  // Dipendenze: fetch al mount della pagina.
  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch('/api/topology')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setTopo({ edges: d.edges ?? [], extraNodes: d.extraNodes ?? [], nodes: d.nodes ?? [] }))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Rete: fetch pigro la prima volta che apri la tab (più chiamate AWS → solo se serve).
  useEffect(() => {
    if (view !== 'net' || net) return
    setNetLoading(true)
    setNetError(null)
    fetch('/api/network')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setNet)
      .catch((e) => setNetError(e.message))
      .finally(() => setNetLoading(false))
  }, [view, net])

  const shownNet = useMemo(
    () => (!net || !accountLabels ? net : { accounts: (net.accounts ?? []).filter((a) => accountLabels.has(a.label)) }),
    [net, accountLabels],
  )

  const { nodes, edges, usedVias, orphans, ghosts } = useMemo(
    () => buildGraph(services, topo, dark, t),
    [services, topo, dark, t],
  )
  const hasEdges = nodes.length > 0
  // `fitView` di ReactFlow inquadra solo al mount: cambiando filtro l'insieme dei nodi cambia e la
  // vista restava dov'era, spesso fuori dal disegno. Rimontando su una firma dei nodi si reinquadra.
  const graphSignature = useMemo(() => nodes.map((n) => n.id).join('|'), [nodes])
  const netGraph = useMemo(
    () => (shownNet ? buildNetworkGraph(shownNet, dark, t) : { nodes: [], hasData: false }),
    [shownNet, dark, t],
  )

  return (
    <>
      <PageIntro
        title={t('topo.title')}
        desc={t('topo.desc')}
        extra={
          <Segmented
            options={[
              { label: t('topo.tab.deps'), value: 'deps' },
              { label: t('topo.tab.net'), value: 'net' },
            ]}
            value={view}
            onChange={setView}
          />
        }
      />

      {view === 'deps' ? (
        <>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
          <Legend usedVias={usedVias} t={t} />
          {ghosts > 0 && (
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
              {t('topo.ghosts', { n: ghosts })}
            </Text>
          )}
          {loading ? (
            <div style={{ ...CANVAS, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin tip={t('topo.loading')} />
            </div>
          ) : services.length === 0 ? (
            <div style={CANVAS}>
              <Empty style={{ paddingTop: 80 }} description={t('topo.noServices')} />
            </div>
          ) : (
            <div style={{ ...CANVAS, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                {hasEdges ? (
                  <ReactFlow
                    key={graphSignature}
                    nodes={nodes}
                    edges={edges}
                    fitView
                    fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
                    colorMode={dark ? 'dark' : 'light'}
                    proOptions={{ hideAttribution: true }}
                  >
                    <Background />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                ) : (
                  <Empty style={{ paddingTop: 80 }} description={t('topo.noRelations')} />
                )}
              </div>
              {orphans.length > 0 && (
                <div
                  style={{
                    width: 250,
                    flexShrink: 0,
                    borderLeft: '1px solid rgba(128,128,128,0.2)',
                    overflowY: 'auto',
                    padding: '8px 4px 8px 12px',
                  }}
                >
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {t('topo.orphans', { n: orphans.reduce((a, g) => a + g.items.length, 0) })}
                  </Text>
                  {/* Raggruppati per tipo: la chiave è `account::nome`, non il nome — con i nomi
                      duplicati tra ambienti React non sostituiva le righe, le impilava. */}
                  {orphans.map((group) => (
                    <div key={group.type} style={{ marginTop: 8 }}>
                      <Text type="secondary" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        {group.type} · {group.items.length}
                      </Text>
                      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {group.items.map((s) => (
                          <div key={s.key} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12 }}>
                            <span
                              style={{
                                display: 'inline-block',
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                marginTop: 4,
                                background: STATUS_COLOR[s.status] ?? '#8c8c8c',
                                flexShrink: 0,
                              }}
                            />
                            {/* Il nome va a capo invece di essere troncato: i nomi dei cron si
                                distinguono nella coda, che l'ellissi mangiava per prima. */}
                            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                              {s.name}
                              {s.account && (
                                <Text type="secondary" style={{ fontSize: 10 }}>
                                  {' '}
                                  · {s.account}
                                </Text>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('topo.netDesc')}
          </Text>
          {netError && <Alert type="error" showIcon message={netError} style={{ marginTop: 8 }} />}
          <div style={CANVAS}>
            {netLoading ? (
              <div style={{ textAlign: 'center', paddingTop: 120 }}>
                <Spin tip={t('topo.netLoading')} />
              </div>
            ) : !netGraph.hasData ? (
              <Empty style={{ paddingTop: 80 }} description={t('topo.netEmpty')} />
            ) : (
              <ReactFlow
                nodes={netGraph.nodes}
                edges={[]}
                fitView
                nodesDraggable={false}
                nodesConnectable={false}
                colorMode={dark ? 'dark' : 'light'}
                proOptions={{ hideAttribution: true }}
              >
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
        </>
      )}
    </>
  )
}
