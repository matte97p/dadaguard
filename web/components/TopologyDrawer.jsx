import { useEffect, useMemo, useState } from 'react'
import { Drawer, Segmented, Empty, Typography, Spin, Space, Alert } from 'antd'
import { ReactFlow, Background, Controls, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from '@dagrejs/dagre'

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
  lb: { color: '#fa8c16' },
  net: { color: '#13c2c2' },
}

// --- Vista "Dipendenze": grafo a livelli, nodi colorati per stato, archi per provenienza. ---
function buildGraph(services, topo, dark) {
  const statusByName = new Map(services.map((s) => [s.name, s.overall]))

  const nodeList = [
    ...services.map((s) => ({ id: s.name, label: `${s.name}${s.type ? ` · ${s.type}` : ''}`, status: s.overall })),
    ...(topo.extraNodes ?? []).map((n) => ({ id: n.id, label: `${n.label} · ${n.type}`, status: null, external: true })),
  ]
  const idset = new Set(nodeList.map((n) => n.id))
  const edges = (topo.edges ?? []).filter((e) => idset.has(e.source) && idset.has(e.target))

  // Separa i nodi COLLEGATI (in almeno un arco) dagli ISOLATI: solo i collegati vanno nel grafo,
  // gli isolati (es. le tante cron scollegate) finiscono in una lista a lato → canvas leggibile.
  const connected = new Set()
  for (const e of edges) {
    connected.add(e.source)
    connected.add(e.target)
  }
  const connectedList = nodeList.filter((n) => connected.has(n.id))
  const isolated = services
    .filter((s) => !connected.has(s.name))
    .map((s) => ({ name: s.name, status: s.overall, type: s.type }))

  // Auto-layout con dagre: DAG dall'alto verso il basso, nodi allineati per livello e archi puliti,
  // invece del posizionamento manuale che si sovrapponeva.
  const NODE_W = 200
  const NODE_H = 44
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 64, marginx: 12, marginy: 12 })
  g.setDefaultEdgeLabel(() => ({}))
  connectedList.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }))
  edges.forEach((e) => g.setEdge(e.source, e.target))
  dagre.layout(g)

  const nodes = connectedList.map((n) => {
    const p = g.node(n.id)
    const color = n.external ? '#bfbfbf' : STATUS_COLOR[n.status] ?? '#8c8c8c'
    return {
      id: n.id,
      position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 },
      data: { label: n.label },
      style: {
        border: `2px ${n.external ? 'dashed' : 'solid'} ${color}`,
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 12,
        width: NODE_W,
        background: dark ? '#1f1f1f' : '#fff',
        color: dark ? '#e6e6e6' : '#000',
      },
    }
  })

  const rfEdges = edges.map((e) => {
    const broken = ['down', 'degraded'].includes(statusByName.get(e.target))
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
      label: broken ? '⚠ giù' : undefined,
    }
  })

  const usedVias = new Set(edges.flatMap((e) => e.vias ?? []))
  return { nodes, edges: rfEdges, usedVias, isolated }
}

// --- Vista "Rete": box VPC (un account può averne più d'una) che contengono i servizi, più un
// bucket "Senza VPC" per chi non è in una VPC (es. Lambda non-VPC: girano sulla rete gestita da AWS). ---
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
    <Space size={12} wrap style={{ marginTop: 8 }}>
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
  height: 'calc(100vh - 200px)',
  marginTop: 8,
  border: '1px solid rgba(128,128,128,0.2)',
  borderRadius: 8,
  position: 'relative',
}

// Topologia: due lenti. "Dipendenze" = relazioni dedotte da AWS (env/event/SG). "Rete" = dove vive
// ogni servizio (VPC → subnet) + egress. Entrambe read-only, on-demand.
export default function TopologyDrawer({ open, onClose, services = [], accountLabels, dark, t = (k) => k }) {
  const [view, setView] = useState('deps')
  const [topo, setTopo] = useState({ edges: [], extraNodes: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [net, setNet] = useState(null)
  const [netLoading, setNetLoading] = useState(false)
  const [netError, setNetError] = useState(null)

  // Dipendenze: fetch all'apertura.
  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    fetch('/api/topology')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setTopo({ edges: d.edges ?? [], extraNodes: d.extraNodes ?? [] }))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open])

  // Rete: fetch pigro la prima volta che apri la tab (più chiamate AWS → solo se serve).
  useEffect(() => {
    if (!open || view !== 'net' || net) return
    setNetLoading(true)
    setNetError(null)
    fetch('/api/network')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setNet)
      .catch((e) => setNetError(e.message))
      .finally(() => setNetLoading(false))
  }, [open, view, net])

  // alla chiusura svuota la cache rete → riapertura = dati freschi
  useEffect(() => {
    if (!open) setNet(null)
  }, [open])

  // I servizi arrivano GIÀ filtrati dai filtri globali della dashboard. La vista Rete la restringo
  // agli stessi account (per label) quando i filtri lasciano visibili solo alcuni account.
  const shownServices = services
  const shownNet = useMemo(
    () => (!net || !accountLabels ? net : { accounts: (net.accounts ?? []).filter((a) => accountLabels.has(a.label)) }),
    [net, accountLabels],
  )

  const { nodes, edges, usedVias, isolated } = useMemo(
    () => buildGraph(shownServices, topo, dark),
    [shownServices, topo, dark],
  )
  const hasEdges = edges.length > 0
  const netGraph = useMemo(
    () => (shownNet ? buildNetworkGraph(shownNet, dark, t) : { nodes: [], hasData: false }),
    [shownNet, dark, t],
  )

  return (
    <Drawer title={t('topo.title')} placement="right" width="100%" open={open} onClose={onClose}>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} wrap>
        <Segmented
          options={[
            { label: t('topo.tab.deps'), value: 'deps' },
            { label: t('topo.tab.net'), value: 'net' },
          ]}
          value={view}
          onChange={setView}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('topo.filterHint')}
        </Text>
      </Space>

      {view === 'deps' ? (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('topo.desc')}
          </Text>
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
          <Legend usedVias={usedVias} t={t} />
          {loading ? (
            <div style={{ ...CANVAS, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin tip={t('topo.loading')} />
            </div>
          ) : shownServices.length === 0 ? (
            <div style={CANVAS}>
              <Empty style={{ paddingTop: 80 }} description={t('topo.noServices')} />
            </div>
          ) : (
            <div style={{ ...CANVAS, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                {hasEdges ? (
                  <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }} colorMode={dark ? 'dark' : 'light'} proOptions={{ hideAttribution: true }}>
                    <Background />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                ) : (
                  <Empty style={{ paddingTop: 80 }} description={t('topo.noRelations')} />
                )}
              </div>
              {isolated.length > 0 && (
                <div
                  style={{
                    width: 230,
                    borderLeft: '1px solid rgba(128,128,128,0.2)',
                    overflowY: 'auto',
                    padding: '8px 4px 8px 12px',
                  }}
                >
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {t('topo.isolated', { n: isolated.length })}
                  </Text>
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {isolated.map((s) => (
                      <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: 4,
                            background: STATUS_COLOR[s.status] ?? '#8c8c8c',
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.name}
                        </span>
                        {s.type && (
                          <Text type="secondary" style={{ fontSize: 10, flexShrink: 0, whiteSpace: 'nowrap' }}>
                            {s.type}
                          </Text>
                        )}
                      </div>
                    ))}
                  </div>
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
    </Drawer>
  )
}
