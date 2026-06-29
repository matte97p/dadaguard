import { useMemo, useState } from 'react'
import { Drawer, Segmented, Empty, Typography } from 'antd'
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

// Layout a livelli (profondità nel DAG delle dipendenze) + nodi colorati per stato +
// archi rossi quando la dipendenza è giù/degradata (impatto a colpo d'occhio).
function buildGraph(services, dark) {
  const byName = new Map(services.map((s) => [s.name, s]))
  const level = new Map()
  const depth = (name, seen = new Set()) => {
    if (level.has(name)) return level.get(name)
    if (seen.has(name)) return 0 // protezione cicli
    seen.add(name)
    const deps = (byName.get(name)?.dependsOn ?? []).filter((d) => byName.has(d))
    const d = deps.length ? 1 + Math.max(...deps.map((x) => depth(x, seen))) : 0
    level.set(name, d)
    return d
  }
  services.forEach((s) => depth(s.name))

  const perLevel = new Map()
  const nodes = services.map((s) => {
    const l = level.get(s.name) ?? 0
    const idx = perLevel.get(l) ?? 0
    perLevel.set(l, idx + 1)
    const color = STATUS_COLOR[s.overall] ?? '#8c8c8c'
    return {
      id: s.name,
      position: { x: idx * 220, y: l * 130 },
      data: { label: `${s.name}${s.type ? ` · ${s.type}` : ''}` },
      style: {
        border: `2px solid ${color}`,
        borderRadius: 8,
        padding: 8,
        fontSize: 12,
        width: 190,
        background: dark ? '#1f1f1f' : '#fff',
        color: dark ? '#e6e6e6' : '#000',
      },
    }
  })

  const edges = []
  for (const s of services) {
    for (const dep of s.dependsOn ?? []) {
      if (!byName.has(dep)) continue
      const broken = ['down', 'degraded'].includes(byName.get(dep)?.overall)
      edges.push({
        id: `${s.name}->${dep}`,
        source: s.name,
        target: dep,
        markerEnd: { type: MarkerType.ArrowClosed, color: broken ? '#ff4d4f' : '#888' },
        animated: broken,
        style: { stroke: broken ? '#ff4d4f' : '#888', strokeWidth: broken ? 2 : 1 },
        label: broken ? '⚠ giù' : undefined,
      })
    }
  }
  return { nodes, edges }
}

// Topologia dei servizi. Due lenti: "Dipendenze" (grafo, stati propagati) e "Rete" (prossima,
// dallo state Terraform). Niente backend nuovo per le dipendenze: usa `dependsOn` da /api/status.
export default function TopologyDrawer({ open, onClose, services = [], dark }) {
  const [view, setView] = useState('deps')
  const { nodes, edges } = useMemo(() => buildGraph(services, dark), [services, dark])
  const hasDeps = edges.length > 0

  return (
    <Drawer title="Topologia" placement="right" width={840} open={open} onClose={onClose}>
      <Segmented
        options={[
          { label: 'Dipendenze', value: 'deps' },
          { label: 'Rete', value: 'net' },
        ]}
        value={view}
        onChange={setView}
        style={{ marginBottom: 12 }}
      />

      {view === 'deps' ? (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Le frecce sono “dipende da”; il nodo è colorato per stato. Se una dipendenza è giù/degradata
            l’arco diventa <span style={{ color: '#ff4d4f' }}>rosso</span> → vedi subito l’impatto a valle.
          </Text>
          <div
            style={{
              height: '68vh',
              marginTop: 8,
              border: '1px solid rgba(128,128,128,0.2)',
              borderRadius: 8,
            }}
          >
            {services.length === 0 ? (
              <Empty style={{ paddingTop: 80 }} description="Nessun servizio" />
            ) : (
              <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }}>
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            )}
          </div>
          {!hasDeps && services.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              Nessuna relazione dichiarata: aggiungi <code>dependsOn: [nome-servizio]</code> ai servizi
              per disegnare il grafo.
            </Text>
          )}
        </>
      ) : (
        <Empty
          style={{ paddingTop: 100 }}
          description="Mappa di rete — in arrivo (dallo state Terraform: VPC → subnet → risorsa, NAT/IGW)"
        />
      )}
    </Drawer>
  )
}
