import { useEffect, useMemo, useState } from 'react'
import { Drawer, Segmented, Empty, Typography, Spin, Space, Alert } from 'antd'
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
  declared: { color: '#8c8c8c', label: 'dichiarata' },
  env: { color: '#1677ff', label: 'config / env' },
  event: { color: '#7c3aed', label: 'event source (coda/stream)' },
  net: { color: '#13c2c2', label: 'rete (security group)' },
}

// Layout a livelli (profondità nel DAG) + nodi colorati per stato + archi colorati per provenienza.
// Se la dipendenza (il target) è giù/degradata l'arco diventa rosso → impatto a valle a colpo d'occhio.
function buildGraph(services, topo, dark) {
  const statusByName = new Map(services.map((s) => [s.name, s.overall]))

  const nodeList = [
    ...services.map((s) => ({
      id: s.name,
      label: `${s.name}${s.type ? ` · ${s.type}` : ''}`,
      status: s.overall,
    })),
    ...(topo.extraNodes ?? []).map((n) => ({
      id: n.id,
      label: `${n.label} · ${n.type}`,
      status: null,
      external: true,
    })),
  ]
  const idset = new Set(nodeList.map((n) => n.id))
  const edges = (topo.edges ?? []).filter((e) => idset.has(e.source) && idset.has(e.target))

  // profondità: un nodo che dipende da altri sta sotto a ciò da cui dipende.
  const depsOf = new Map([...idset].map((id) => [id, []]))
  for (const e of edges) depsOf.get(e.source).push(e.target)
  const level = new Map()
  const depth = (id, seen = new Set()) => {
    if (level.has(id)) return level.get(id)
    if (seen.has(id)) return 0 // protezione cicli
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

  // quali provenienze sono effettivamente presenti (per mostrare solo le voci utili in legenda).
  const usedVias = new Set(edges.flatMap((e) => e.vias ?? []))
  return { nodes, edges: rfEdges, usedVias }
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

// Topologia dei servizi. Lente "Dipendenze": grafo con relazioni DEDOTTE in automatico da AWS
// (nessuna dichiarazione manuale). Lente "Rete": prossima, dallo state Terraform.
export default function TopologyDrawer({ open, onClose, services = [], dark, t = (k) => k }) {
  const [view, setView] = useState('deps')
  const [topo, setTopo] = useState({ edges: [], extraNodes: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

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

  const { nodes, edges, usedVias } = useMemo(
    () => buildGraph(services, topo, dark),
    [services, topo, dark],
  )
  const hasEdges = edges.length > 0

  return (
    <Drawer title={t('topo.title')} placement="right" width={840} open={open} onClose={onClose}>
      <Segmented
        options={[
          { label: t('topo.tab.deps'), value: 'deps' },
          { label: t('topo.tab.net'), value: 'net' },
        ]}
        value={view}
        onChange={setView}
        style={{ marginBottom: 12 }}
      />

      {view === 'deps' ? (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('topo.desc')}
          </Text>
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
          <Legend usedVias={usedVias} t={t} />
          <div
            style={{
              height: '64vh',
              marginTop: 8,
              border: '1px solid rgba(128,128,128,0.2)',
              borderRadius: 8,
              position: 'relative',
            }}
          >
            {loading ? (
              <div style={{ textAlign: 'center', paddingTop: 120 }}>
                <Spin tip={t('topo.loading')} />
              </div>
            ) : services.length === 0 ? (
              <Empty style={{ paddingTop: 80 }} description={t('topo.noServices')} />
            ) : (
              <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }}>
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
          {!loading && !hasEdges && services.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              {t('topo.noRelations')}
            </Text>
          )}
        </>
      ) : (
        <Empty style={{ paddingTop: 100 }} description={t('topo.netPlaceholder')} />
      )}
    </Drawer>
  )
}
