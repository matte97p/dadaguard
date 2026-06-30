import { useEffect, useMemo, useState } from 'react'
import { Drawer, Segmented, Select, Empty, Typography, Spin, Space, Alert } from 'antd'
import { ReactFlow, Background, Controls, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

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

  const depsOf = new Map([...idset].map((id) => [id, []]))
  for (const e of edges) depsOf.get(e.source).push(e.target)
  const level = new Map()
  const depth = (id, seen = new Set()) => {
    if (level.has(id)) return level.get(id)
    if (seen.has(id)) return 0
    seen.add(id)
    const d = depsOf.get(id) ?? []
    const v = d.length ? 1 + Math.max(...d.map((x) => depth(x, seen))) : 0
    level.set(id, v)
    return v
  }
  nodeList.forEach((n) => depth(n.id))

  const perLevel = new Map()
  const nodes = nodeList.map((n) => {
    const l = level.get(n.id) ?? 0
    const idx = perLevel.get(l) ?? 0
    perLevel.set(l, idx + 1)
    const color = n.external ? '#bfbfbf' : STATUS_COLOR[n.status] ?? '#8c8c8c'
    return {
      id: n.id,
      position: { x: idx * 220, y: l * 130 },
      data: { label: n.label },
      style: {
        border: `2px ${n.external ? 'dashed' : 'solid'} ${color}`,
        borderRadius: 8,
        padding: 8,
        fontSize: 12,
        width: 190,
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
  return { nodes, edges: rfEdges, usedVias }
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
  height: '64vh',
  marginTop: 8,
  border: '1px solid rgba(128,128,128,0.2)',
  borderRadius: 8,
  position: 'relative',
}

// Topologia: due lenti. "Dipendenze" = relazioni dedotte da AWS (env/event/SG). "Rete" = dove vive
// ogni servizio (VPC → subnet) + egress. Entrambe read-only, on-demand.
export default function TopologyDrawer({ open, onClose, services = [], dark, t = (k) => k }) {
  const [view, setView] = useState('deps')
  const [topo, setTopo] = useState({ edges: [], extraNodes: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [net, setNet] = useState(null)
  const [netLoading, setNetLoading] = useState(false)
  const [netError, setNetError] = useState(null)
  const [acct, setAcct] = useState('all')

  // account presenti (dai servizi) → opzioni del filtro. Un account alla volta, non tutti insieme.
  const accountOpts = useMemo(() => {
    const seen = new Map()
    for (const s of services) {
      const k = s.account?.key ?? '__none__'
      if (!seen.has(k)) seen.set(k, s.account?.label ?? k)
    }
    return [...seen].map(([value, label]) => ({ value, label }))
  }, [services])

  // default = primo account (così parte mostrandone uno solo); resta valido se ancora presente.
  useEffect(() => {
    if (!open) return
    setAcct((cur) => (accountOpts.some((o) => o.value === cur) ? cur : accountOpts[0]?.value ?? 'all'))
  }, [open, accountOpts])

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

  // filtro account applicato a entrambe le viste
  const shownServices = useMemo(
    () => (acct === 'all' ? services : services.filter((s) => (s.account?.key ?? '__none__') === acct)),
    [services, acct],
  )
  const shownNet = useMemo(
    () => (!net || acct === 'all' ? net : { accounts: (net.accounts ?? []).filter((a) => a.account === acct) }),
    [net, acct],
  )

  const { nodes, edges, usedVias } = useMemo(
    () => buildGraph(shownServices, topo, dark),
    [shownServices, topo, dark],
  )
  const hasEdges = edges.length > 0
  const netGraph = useMemo(
    () => (shownNet ? buildNetworkGraph(shownNet, dark, t) : { nodes: [], hasData: false }),
    [shownNet, dark, t],
  )

  return (
    <Drawer title={t('topo.title')} placement="right" width={840} open={open} onClose={onClose}>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} wrap>
        <Segmented
          options={[
            { label: t('topo.tab.deps'), value: 'deps' },
            { label: t('topo.tab.net'), value: 'net' },
          ]}
          value={view}
          onChange={setView}
        />
        {accountOpts.length > 1 && (
          <Select
            size="small"
            value={acct}
            onChange={setAcct}
            style={{ minWidth: 200 }}
            options={[...accountOpts, { value: 'all', label: t('filter.allAccounts') }]}
          />
        )}
      </Space>

      {view === 'deps' ? (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('topo.desc')}
          </Text>
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
          <Legend usedVias={usedVias} t={t} />
          <div style={CANVAS}>
            {loading ? (
              <div style={{ textAlign: 'center', paddingTop: 120 }}>
                <Spin tip={t('topo.loading')} />
              </div>
            ) : shownServices.length === 0 ? (
              <Empty style={{ paddingTop: 80 }} description={t('topo.noServices')} />
            ) : (
              <ReactFlow nodes={nodes} edges={edges} fitView colorMode={dark ? 'dark' : 'light'} proOptions={{ hideAttribution: true }}>
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
          {!loading && !hasEdges && shownServices.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              {t('topo.noRelations')}
            </Text>
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
