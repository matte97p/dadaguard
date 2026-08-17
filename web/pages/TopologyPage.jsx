import { useEffect, useMemo, useState } from 'react'
import { Segmented, Typography, Space, Alert, Breadcrumb, Button, Tag, Switch } from 'antd'
import { ReactFlow, Background, Controls } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { PageIntro, EmptyState, Toolbar } from './pageKit.jsx'
import { TIPI_NODO } from '../components/TopoNode.jsx'
import { ArrowLeftOutlined, SyncOutlined } from '@ant-design/icons'
import { FONT, SPACE, MONO } from '../theme.js'
import { buildMap, buildGroup, rollup, topologyNodeId, chiaveDi, acctKey, acctLabel, STATUS_COLOR, VIA } from '../topoGraph.js'
import { rischi as calcolaRischi, usiDiretti, impatto } from '../topoImpact.js'
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

const CANVAS = {
  // Alta quanto basta: a `calc(100vh - 300px)` su uno schermo grande erano 1200px per un disegno alto
  // 300, e la mappa galleggiava in mezzo al vuoto con i box piccoli in un angolo.
  height: 'min(calc(100vh - 320px), 620px)',
  minHeight: 420,
  border: '1px solid var(--dg-line)',
  borderRadius: 12,
  position: 'relative',
  background: 'var(--dg-row)',
}

// Il PANNELLO a destra: cosa si sa di ciò che è selezionato. È l'innesto che tutti gli strumenti seri
// hanno (Kiali, Datadog, Workload Discovery) e che qui mancava: senza, tutto quello che si vuole dire
// deve stare sulla card, e una card che dice tutto non si legge.
function Pannello({ scelto, servizi, topo, rischi, t, onApri, onApriServizio }) {
  if (!scelto) {
    return (
      <div className="dg-topo-panel">
        <Text type="secondary" style={{ fontSize: FONT.small }}>
          {t('topo.panel.hint')}
        </Text>
      </div>
    )
  }
  if (scelto.tipo === 'gruppo') {
    const r = rollup(scelto.membri, Date.now(), rischi)
    return (
      <div className="dg-topo-panel">
        <div className="dg-topo-panel-title">{scelto.titolo}</div>
        <Text type="secondary" style={{ fontSize: FONT.small }}>
          {t('topo.panel.members', { n: r.membri })}
          {r.problemi ? ` · ${t('topo.panel.problems', { n: r.problemi })}` : ''}
        </Text>
        {r.aRischio > 0 && (
          <div style={{ fontSize: FONT.small, color: '#d48806' }}>
            {t('topo.g.risk', { n: r.aRischio })}: {r.causa}
          </div>
        )}
        <Button size="small" type="primary" ghost style={{ marginTop: SPACE.sm }} onClick={() => onApri(scelto.key)}>
          {t('topo.panel.open')}
        </Button>
        <div className="dg-topo-panel-list">
          {scelto.membri.map((s) => (
            <div key={chiaveDi(s)} className="dg-topo-panel-row">
              <span style={{ width: 7, height: 7, borderRadius: 2, background: STATUS_COLOR[s.overall] ?? STATUS_COLOR.unknown }} />
              <span style={{ fontFamily: MONO, fontSize: FONT.small, overflowWrap: 'anywhere' }}>{s.name}</span>
              <Text type="secondary" style={{ fontSize: FONT.micro }}>
                {s.type}
              </Text>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Una RISORSA: lo stato, e le relazioni dedotte con la loro provenienza. La provenienza si dice
  // sempre, perché «citato in una env var» e «un load balancer instrada qui» sono due cose diverse e
  // solo una delle due è un flusso.
  const s = scelto.servizio
  const chiave = chiaveDi(s)
  const entranti = (topo.edges ?? []).filter((e) => e.target === chiave)
  const uscenti = (topo.edges ?? []).filter((e) => e.source === chiave)
  // Anche i nodi che non sono servizi nostri (un sistema di terzi, una coda non dichiarata) hanno un
  // nome: senza, nel pannello delle relazioni compariva l'identificativo grezzo `ext:host:…`.
  const nomeDi = new Map([
    ...(topo.nodes ?? []).map((n) => [n.id, n.name]),
    ...(topo.extraNodes ?? []).map((n) => [n.id, n.label ?? n.id]),
  ])
  const imp = impatto(chiave, servizi, topo.edges ?? [])
  const colpe = rischi.get(chiave) ?? null
  const riga = (e, verso) => {
    const altro = verso === 'in' ? e.source : e.target
    return (
      <div key={`${verso}${e.source}${e.target}`} className="dg-topo-panel-row">
        <span style={{ fontFamily: MONO, fontSize: FONT.small, overflowWrap: 'anywhere' }}>
          {nomeDi.get(altro) ?? altro.split('::').pop()}
        </span>
        {(e.vias ?? []).map((v) => (
          <Tag key={v} bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }} color={VIA[v]?.forte ? 'orange' : 'default'}>
            {t(`topo.legend.${v}`)}
          </Tag>
        ))}
      </div>
    )
  }
  return (
    <div className="dg-topo-panel">
      <div className="dg-topo-panel-title" style={{ fontFamily: MONO }}>
        {s.name}
      </div>
      <Text type="secondary" style={{ fontSize: FONT.small }}>
        {s.esterno ? (s.esterno.hosts ?? []).join(' · ') || t('topo.ext.meta') : [s.type, acctLabel(s)].filter(Boolean).join(' · ')}
      </Text>
      {/* Il salto al dettaglio del servizio (check, log, eventi): la mappa dice dove guardare, e il passo
          dopo è guardarci. Di un sistema fuori da AWS non abbiamo un dettaglio, quindi lì non si offre. */}
      {!s.esterno && onApriServizio && s.overall !== 'unknown' && (
        <Button size="small" type="primary" ghost style={{ marginTop: SPACE.sm }} onClick={() => onApriServizio(s)}>
          {t('topo.panel.openService')}
        </Button>
      )}
      {s.checks?.runtime?.summary && (
        <div style={{ marginTop: SPACE.sm, fontSize: FONT.small }}>{s.checks.runtime.summary}</div>
      )}
      {/* LE DUE RISPOSTE per cui questa pagina esiste (vedi web/topoImpact.js): chi ne soffre se si
          ferma, e da cosa dipende lui, che è dove si guarda quando è lui a non funzionare. Contano
          anche i rimbalzi: la dipendenza indiretta è proprio quella che a mente non si ricostruisce. */}
      <div className="dg-topo-panel-impact">
        <div>
          <strong>{t('topo.panel.blast', { n: imp.aValle.length })}</strong>
          {imp.aValle.length > 0 && (
            <span style={{ opacity: 0.75 }}> {imp.aValle.slice(0, 6).join(', ')}{imp.aValle.length > 6 ? '…' : ''}</span>
          )}
        </div>
        <div>
          <strong>{t('topo.panel.dependsOn', { n: imp.dipendenze.length })}</strong>
          {imp.dipendenze.length > 0 && (
            <span style={{ opacity: 0.75 }}> {imp.dipendenze.slice(0, 6).join(', ')}{imp.dipendenze.length > 6 ? '…' : ''}</span>
          )}
        </div>
        {colpe && <div style={{ color: '#d48806' }}>{t('topo.panel.riskWhy', { names: colpe.join(', ') })}</div>}
      </div>
      <div className="dg-topo-panel-list">
        {entranti.length > 0 && <div className="dg-topo-panel-sub">{t('topo.panel.in', { n: entranti.length })}</div>}
        {entranti.map((e) => riga(e, 'in'))}
        {uscenti.length > 0 && <div className="dg-topo-panel-sub">{t('topo.panel.out', { n: uscenti.length })}</div>}
        {uscenti.map((e) => riga(e, 'out'))}
        {entranti.length + uscenti.length === 0 && (
          <Text type="secondary" style={{ fontSize: FONT.micro }}>
            {t('topo.panel.none')}
          </Text>
        )}
      </div>
    </div>
  )
}

// Pagina Topologia: due lenti. «Architettura» = la mappa a gruppi, con dentro le risorse.
// «Rete» = dove vive ogni servizio (VPC → subnet) + egress. Entrambe read-only, on-demand.
// `services` arriva GIÀ filtrato dai filtri globali; la vista Rete si restringe agli stessi account.
export default function TopologyPage({ services = [], accountLabels, dark, statusReady = true, onApriServizio, t = (k) => k }) {
  const [view, setView] = useState('deps')
  // UN AMBIENTE PER VOLTA: due ambienti insieme sono due architetture identiche sovrapposte.
  const [conto, setConto] = useState(null)
  // Il LIVELLO: la mappa dei gruppi, oppure dentro un gruppo. È la tesi C4, un diagramma un livello,
  // ed è ciò che fa scendere un ambiente vero da 30-38 card a 6-8 box.
  const [gruppoAperto, setGruppoAperto] = useState(null)
  // Le relazioni dedotte da permessi IAM e security group: 61 secondi di chiamate AWS per due archi in
  // più. Spente finché non le si chiede.
  const [deboli, setDeboli] = useState(false)
  const [scelto, setScelto] = useState(null)
  const [topo, setTopo] = useState({ edges: [], extraNodes: [], nodes: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [net, setNet] = useState(null)
  const [netLoading, setNetLoading] = useState(false)
  const [netError, setNetError] = useState(null)

  // Di default si chiede il giro VELOCE, e non è una scorciatoia: misurato sulla flotta vera, il giro
  // completo costa 66,5 secondi contro 5,5 e porta DUE archi in più su 34. Quei 61 secondi stanno tutti
  // nelle passate IAM e security group, che deducono relazioni da un permesso o da una regola di rete —
  // vere, ma non sono un flusso. Chi le vuole le chiede con l'interruttore, sapendo cosa costano.
  useEffect(() => {
    let vivo = true
    setLoading(true)
    setError(null)
    fetch(`/api/topology?deboli=${deboli ? '1' : '0'}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => vivo && setTopo({ edges: d.edges ?? [], extraNodes: d.extraNodes ?? [], nodes: d.nodes ?? [] }))
      .catch((e) => vivo && setError(e.message))
      .finally(() => vivo && setLoading(false))
    return () => {
      vivo = false
    }
  }, [deboli])

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
  // Era un riferimento a una variabile che non esiste più: aprire la scheda «Rete» buttava giù la pagina
  // con un ReferenceError, cioè schermo bianco.
  const netGraph = useMemo(() => buildNetworkGraph(shownNet ?? {}, dark, t), [shownNet, dark, t])

  // I SERVIZI della mappa vengono dal grafo, non dallo stato della flotta. È la correzione che cambia
  // l'attesa vera: `/api/status` fa gli otto check su tutti i servizi di tutti gli account e ci mette
  // decine di secondi, e finché non tornava questa pagina scriveva «Nessun servizio»: che non è
  // «non ce ne sono», è «non li ho ancora guardati», e sono due cose diverse.
  //
  // `topo.nodes` porta nome, account e tipo di ogni risorsa: basta a disegnare la mappa. Lo stato
  // (problemi, task attivi, prossima esecuzione) arriva dopo e ARRICCHISCE i box, senza bloccarli.
  const perChiave = useMemo(() => new Map(services.map((x) => [topologyNodeId(x), x])), [services])
  const servizi = useMemo(() => {
    if (!topo.nodes?.length) return services
    return topo.nodes.map((n) => {
      const vero = perChiave.get(n.id)
      if (vero) return vero
      return { name: n.name, type: n.type, account: { key: n.account, label: n.account }, overall: 'unknown' }
    })
  }, [topo, perChiave, services])

  const conti = useMemo(() => {
    const m = new Map()
    for (const s of servizi) {
      const k = acctKey(s)
      if (!m.has(k)) m.set(k, { key: k, label: acctLabel(s) ?? k, n: 0 })
      m.get(k).n += 1
    }
    return [...m.values()].sort((a, b) => b.n - a.n)
  }, [servizi])
  const contoAttivo = conti.some((c) => c.key === conto) ? conto : conti[0]?.key ?? null
  useEffect(() => {
    if (conto !== contoAttivo) setConto(contoAttivo)
  }, [contoAttivo])

  const serviziAmbiente = useMemo(
    () => (contoAttivo ? servizi.filter((s) => acctKey(s) === contoAttivo) : servizi),
    [servizi, contoAttivo],
  )

  // Il rischio si calcola sulla flotta INTERA, non sull'ambiente mostrato: le dipendenze cross-account
  // esistono (una lambda di staging che legge il database di produzione) e tagliarle fuori nasconderebbe
  // proprio i casi per cui si guarda un disegno invece di un elenco.
  const rischi = useMemo(() => calcolaRischi(servizi, topo.edges ?? []), [servizi, topo])
  const usi = useMemo(() => usiDiretti(topo.edges ?? []), [topo])
  const mappa = useMemo(
    () => buildMap(serviziAmbiente, topo, t, { rischi, usi, statoPronto: statusReady }),
    [serviziAmbiente, topo, t, rischi, usi, statusReady],
  )
  const dentro = useMemo(
    () => (gruppoAperto ? buildGroup(gruppoAperto, serviziAmbiente, topo, t, { rischi, usi }) : null),
    [gruppoAperto, serviziAmbiente, topo, t, rischi, usi],
  )

  const nodes = dentro ? dentro.nodes : mappa.nodes
  const edges = dentro ? dentro.edges : mappa.edges
  // `fitView` inquadra solo al mount: cambiando livello o ambiente l'insieme cambia e la vista
  // resterebbe dov'era, spesso fuori dal disegno. Rimontando su una firma si reinquadra.
  const firma = useMemo(() => `${contoAttivo}|${gruppoAperto}|${nodes.map((n) => n.id).join(',')}`, [contoAttivo, gruppoAperto, nodes])

  const apriGruppo = (key) => {
    setGruppoAperto(key)
    setScelto(null)
  }
  const risali = () => {
    setGruppoAperto(null)
    setScelto(null)
  }
  const alClic = (n) => {
    if (n.type === 'gruppo') {
      setScelto({ tipo: 'gruppo', key: n.data.key, titolo: n.data.titolo, membri: n.data.membri })
      return
    }
    if (n.type === 'svc') setScelto({ tipo: 'risorsa', servizio: n.data.servizio })
  }

  return (
    <>
      <PageIntro
        title={t('topo.title')}
        desc={t('topo.desc')}
        extra={
          <Toolbar>
            {view === 'deps' && conti.length > 1 && (
              <Segmented
                size="small"
                value={contoAttivo}
                onChange={(v) => {
                  setConto(v)
                  risali()
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
            {gruppoAperto ? (
              <Breadcrumb
                items={[
                  { title: <a onClick={risali}>{t('topo.crumb.map')}</a> },
                  { title: t(`topo.g.${gruppoAperto}`) },
                ]}
              />
            ) : (
              <Text type="secondary" style={{ fontSize: FONT.micro }}>
                {t('topo.mapHint')}
              </Text>
            )}
            {gruppoAperto && (
              <Button size="small" icon={<ArrowLeftOutlined />} onClick={risali}>
                {t('topo.crumb.back')}
              </Button>
            )}
            <Text type="secondary" style={{ fontSize: FONT.micro }}>
              {t('topo.edgeHint')}
            </Text>
            <Space size={SPACE.xs}>
              <Switch size="small" checked={deboli} onChange={setDeboli} />
              <Text type="secondary" style={{ fontSize: FONT.micro }}>
                {t(deboli ? 'topo.weak.on' : 'topo.weak.off')}
              </Text>
            </Space>
          </Space>

          {/* La mappa NON aspetta gli archi. I box vengono dai servizi, che la pagina ha già in mano;
              le relazioni arrivano da /api/topology, che su una flotta vera è un giro di decine di
              chiamate AWS (55 secondi a cache fredda, misurati). Prima la pagina restava sullo spinner
              per tutto quel tempo e si leggeva come «carica all'infinito»: ora il disegno c'è subito e
              le frecce compaiono quando arrivano, con una riga che dice che stanno arrivando. */}
          {serviziAmbiente.length === 0 ? (
            <div style={{ ...CANVAS, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {loading || !statusReady ? (
                <Loading text={t('topo.loading')} />
              ) : (
                <EmptyState description={t('topo.noServices')} />
              )}
            </div>
          ) : (
            <div style={{ ...CANVAS, display: 'flex', overflow: 'hidden' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                {/* Due attese diverse, e si dice quale: le frecce arrivano da /api/topology, lo stato dei
                    servizi da /api/status (decine di secondi sulla flotta vera). Senza dirlo, una mappa
                    grigia con «stato non letto» su ogni riquadro si legge come un guasto del disegno. */}
                {(loading || !statusReady) && (
                  <div className="dg-topo-loading">
                    <SyncOutlined spin style={{ marginInlineEnd: 6 }} />
                    {loading ? t(deboli ? 'topo.loadingWeak' : 'topo.loadingEdges') : t('topo.loadingState')}
                  </div>
                )}
                <ReactFlow
                  key={firma}
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={TIPI_NODO}
                  fitView
                  // Può ingrandire fino a 1,6: con `maxZoom: 1` un disegno da 1028px in una tela da 1900
                  // restava piccolo in mezzo al vuoto invece di riempirla.
                  fitViewOptions={{ padding: 0.12, maxZoom: 1.6 }}
                  minZoom={0.3}
                  colorMode={dark ? 'dark' : 'light'}
                  proOptions={{ hideAttribution: true }}
                  nodesConnectable={false}
                  nodesDraggable={false}
                  onNodeClick={(_, n) => alClic(n)}
                  onNodeDoubleClick={(_, n) => n.type === 'gruppo' && apriGruppo(n.data.key)}
                  onPaneClick={() => setScelto(null)}
                >
                  <Background variant="dots" gap={20} size={1} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
              {/* Il pannello prende larghezza SOLO quando c'è qualcosa da dire: a mappa non selezionata
                  quei 280px li usa il disegno, ed è la differenza fra una tela che ci sta e una che
                  `fitView` rimpicciolisce fino a rendere il testo di dieci pixel. */}
              {scelto && (
                <Pannello
                  scelto={scelto}
                  servizi={servizi}
                  topo={topo}
                  rischi={rischi}
                  t={t}
                  onApri={apriGruppo}
                  onApriServizio={onApriServizio}
                />
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
