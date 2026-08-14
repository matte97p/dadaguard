import { useEffect, useMemo, useState } from 'react'
import { Segmented, Typography, Space, Alert } from 'antd'
import { ReactFlow, Background, Controls } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { PageIntro, EmptyState, Toolbar } from './pageKit.jsx'
import { TIPI_NODO } from '../components/TopoNode.jsx'
import { FONT, SPACE } from '../theme.js'
import { buildGraph, topologyNodeId, acctLabel, STATUS_COLOR, VIA } from '../topoGraph.js'
import Loading from '../components/Loading.jsx'

const { Text } = Typography

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
  border: '1px solid var(--dg-line-strong)',
  borderRadius: 8,
  position: 'relative',
}

// Pagina Topologia: due lenti. "Dipendenze" = relazioni dedotte da AWS (env/event/flow/lb/SG).
// "Rete" = dove vive ogni servizio (VPC → subnet) + egress. Entrambe read-only, on-demand.
// `services` arriva GIÀ filtrato dai filtri globali; la vista Rete si restringe agli stessi account.
export default function TopologyPage({ services = [], accountLabels, dark, t = (k) => k }) {
  const [view, setView] = useState('deps')
  // UN AMBIENTE PER VOLTA. È la decisione che rende leggibile questa pagina: sui dati veri il grafo
  // completo era 78 nodi e 104 archi con staging e produzione mescolati, cioè due architetture identiche
  // sovrapposte — illeggibile per costruzione, non per come era disegnato. Un ambiente sono ~30 nodi, e
  // sono l'architettura che si vuole guardare.
  const [conto, setConto] = useState(null)
  // Nodo a fuoco: il suo vicinato resta in primo piano, il resto si smorza. È la risposta a «se questo
  // va giù, chi ne soffre», che su cento archi tutti uguali non si legge.
  const [fuoco, setFuoco] = useState(null)
  // Quali FRECCE disegnare. Di default il traffico: sui dati veri gli archi sono 62 per ambiente, di cui
  // 55 dicono «questo servizio nomina quest'altro in una env var o ne ha il permesso IAM». Vere, ma non
  // sono un flusso, e disegnate insieme seppelliscono i sette archi che il flusso lo raccontano — è la
  // ragione per cui «le frecce sono troppo intasate».
  const [frecce, setFrecce] = useState('traffico')
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

  // Gli ambienti presenti fra i servizi visibili, con quanti servizi ognuno: la scelta di default è
  // quello più popolato, non il primo in ordine alfabetico.
  const conti = useMemo(() => {
    const m = new Map()
    for (const s of services) {
      const k = typeof s.account === 'string' ? s.account : s.account?.key
      if (!k) continue
      if (!m.has(k)) m.set(k, { key: k, label: acctLabel(s) ?? k, n: 0 })
      m.get(k).n += 1
    }
    return [...m.values()].sort((a, b) => b.n - a.n)
  }, [services])

  // La scelta si ADATTA a quello che c'è: cambiando il filtro Account in alto, un ambiente selezionato
  // che non esiste più lascerebbe la tela vuota senza spiegazione.
  const contoAttivo = conti.some((c) => c.key === conto) ? conto : conti[0]?.key ?? null
  useEffect(() => {
    if (conto !== contoAttivo) setConto(contoAttivo)
  }, [contoAttivo])

  const serviziAmbiente = useMemo(
    () => (contoAttivo ? services.filter((s) => (typeof s.account === 'string' ? s.account : s.account?.key) === contoAttivo) : services),
    [services, contoAttivo],
  )

  const { nodes, edges, usedVias, orphans, ghosts } = useMemo(
    () => buildGraph(serviziAmbiente, topo, dark, t, { deboli: frecce === 'tutte' }),
    [serviziAmbiente, topo, dark, t, frecce],
  )

  // Vicinato del nodo a fuoco: un salto in entrambe le direzioni. Due salti su questo grafo tornano a
  // illuminare mezza tela, e allora il fuoco non serve più a niente.
  const vicini = useMemo(() => {
    if (!fuoco) return null
    const set = new Set([fuoco])
    for (const e of edges) {
      if (e.source === fuoco) set.add(e.target)
      if (e.target === fuoco) set.add(e.source)
    }
    return set
  }, [fuoco, edges])

  const nodiDisegnati = useMemo(
    () =>
      nodes.map((n) =>
        n.type === 'lane' || !vicini
          ? n
          : { ...n, selected: n.id === fuoco, data: { ...n.data, dim: !vicini.has(n.id) } },
      ),
    [nodes, vicini, fuoco],
  )
  const archiDisegnati = useMemo(
    () =>
      edges.map((e) => {
        if (!vicini) return e
        const tocca = e.source === fuoco || e.target === fuoco
        return { ...e, className: tocca ? 'dg-topo-edge-on' : 'dg-topo-edge-off', animated: tocca || e.animated }
      }),
    [edges, vicini, fuoco],
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
          <Toolbar>
            {view === 'deps' && (
              <Segmented
                size="small"
                value={frecce}
                onChange={setFrecce}
                options={[
                  { value: 'traffico', label: t('topo.edges.traffic') },
                  { value: 'tutte', label: t('topo.edges.all') },
                ]}
              />
            )}
            {view === 'deps' && conti.length > 1 && (
              <Segmented
                size="small"
                value={contoAttivo}
                onChange={(v) => {
                  setConto(v)
                  setFuoco(null)
                }}
                options={conti.map((c) => ({ value: c.key, label: `${c.label} · ${c.n}` }))}
              />
            )}
            <Segmented
              size="small"
              options={[
                { label: t('topo.tab.deps'), value: 'deps' },
                { label: t('topo.tab.net'), value: 'net' },
              ]}
              value={view}
              onChange={setView}
            />
          </Toolbar>
        }
      />

      {view === 'deps' ? (
        <>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
          <Space size={SPACE.md} wrap style={{ marginBottom: SPACE.sm }}>
            <Legend usedVias={usedVias} t={t} />
            <Text type="secondary" style={{ fontSize: FONT.micro }}>
              {t('topo.focusHint')}
            </Text>
          </Space>
          {ghosts > 0 && (
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
              {t('topo.ghosts', { n: ghosts })}
            </Text>
          )}
          {loading ? (
            <div style={{ ...CANVAS, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Loading text={t('topo.loading')} />
            </div>
          ) : services.length === 0 ? (
            <div style={CANVAS}>
              <EmptyState description={t('topo.noServices')} />
            </div>
          ) : (
            <div style={{ ...CANVAS, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                {hasEdges ? (
                  <ReactFlow
                    key={graphSignature}
                    nodes={nodiDisegnati}
                    edges={archiDisegnati}
                    nodeTypes={TIPI_NODO}
                    fitView
                    fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
                    minZoom={0.25}
                    colorMode={dark ? 'dark' : 'light'}
                    proOptions={{ hideAttribution: true }}
                    nodesConnectable={false}
                    onNodeClick={(_, n) => setFuoco((f) => (f === n.id ? null : n.id))}
                    onPaneClick={() => setFuoco(null)}
                  >
                    <Background variant="dots" gap={20} size={1} />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                ) : (
                  <EmptyState description={t('topo.noRelations')} />
                )}
              </div>
              {orphans.length > 0 && (
                <div
                  style={{
                    width: 250,
                    flexShrink: 0,
                    borderLeft: '1px solid var(--dg-line-strong)',
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
                <Loading text={t('topo.netLoading')} />
              </div>
            ) : !netGraph.hasData ? (
              <EmptyState description={t('topo.netEmpty')} />
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
