import { useState } from 'react'
import { Row, Col, Divider, Badge, Typography, Space, Alert, Empty, Card, Skeleton, Segmented } from 'antd'
import { TableOutlined, AppstoreOutlined } from '@ant-design/icons'
import ServiceCard from '../components/ServiceCard.jsx'
import ServicesTable from '../components/ServicesTable.jsx'
import StatusSummary from '../components/StatusSummary.jsx'
import { familyPrefixes } from '../serviceName.js'

const { Text } = Typography

// Ordinamento: problemi in cima (down → degraded → sconosciuto → ok), poi per nome. Così le cose
// rotte si vedono per prime senza scorrere. In fondo quello che NON è un problema e non deve stare
// sopra i servizi sani: prima gli inattivi (modelli Bedrock mai invocati, funzioni mai chiamate —
// roba da pagina Sprechi, non da dashboard), poi gli SPENTI di proposito (cron disattivate).
const SEV = { down: 0, degraded: 1, unknown: 2, up: 3, idle: 4, disabled: 5 }
const byseverity = (a, b) => (SEV[a.overall] ?? 2) - (SEV[b.overall] ?? 2) || String(a.name).localeCompare(String(b.name))

// Pagina principale: le card dei servizi, raggruppate per account, con il riepilogo di stato in cima.
export default function DashboardPage({ data, groups, allServices, statusFilter, onStatusFilter, caps, loading, error, onRemove, onLogs, onEvents, onOpen, t }) {
  // Tabella o card. Oltre la ventina di servizi la tabella vince (una riga per servizio, colonne
  // ordinabili); le card restano per le flotte piccole e per chi le preferisce. Scelta ricordata.
  const [view, setView] = useState(() => localStorage.getItem('dadaguard-view') ?? 'table')
  const pickView = (v) => {
    localStorage.setItem('dadaguard-view', v)
    setView(v)
  }
  const flat = groups.flatMap((g) => g.services)
  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} wrap>
        {data ? (
          <StatusSummary
            services={flat}
            all={allServices}
            statusFilter={statusFilter}
            onStatusFilter={onStatusFilter}
            t={t}
          />
        ) : (
          <span />
        )}
        <Space size={12} wrap>
          {data && (
            <Segmented
              size="small"
              value={view}
              onChange={pickView}
              options={[
                { value: 'table', icon: <TableOutlined />, title: t('view.table') },
                { value: 'cards', icon: <AppstoreOutlined />, title: t('view.cards') },
              ]}
            />
          )}
          {data?.generatedAt && (
            <Text type="secondary">
              {t('content.lastFetch')} {new Date(data.generatedAt).toLocaleTimeString()}
            </Text>
          )}
        </Space>
      </Space>

      {data?.discovered && (
        <Alert
          type="info"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message={t('discover.autoTitle')}
          description={t('discover.autoDesc', { n: data.discovered.count })}
        />
      )}

      {error && (
        <Alert type="error" message={`${t('content.errorPrefix')} ${error}`} style={{ marginBottom: 16 }} showIcon />
      )}
      {loading && !data && (
        <Row gutter={[16, 16]}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Col key={i} xs={24} sm={12} md={8} lg={6}>
              <Card size="small">
                <Skeleton active title={{ width: '60%' }} paragraph={{ rows: 3, width: ['90%', '80%', '70%'] }} />
              </Card>
            </Col>
          ))}
        </Row>
      )}
      {data && groups.length === 0 && <Empty description={t('content.noServices')} style={{ marginTop: 48 }} />}

      {data && view === 'table' && groups.length > 0 && (
        <ServicesTable
          services={flat}
          caps={caps}
          onRemove={onRemove}
          onLogs={onLogs}
          onEvents={onEvents}
          onOpen={onOpen}
          t={t}
        />
      )}

      {view === 'cards' &&
        groups.map((g) => {
        // Prefissi di famiglia calcolati sul GRUPPO visibile (cato-staging-cron-…): la card li mostra
        // piccoli e muti e tiene in evidenza la coda, la parte che distingue una card dall'altra.
        // Fuori i Bedrock: hanno il loro nome parlante (Claude Sonnet 4.5) e non usano la testa, ma
        // nel conteggio alzerebbero la soglia per tutti gli altri.
        const families = familyPrefixes(g.services.filter((s) => s.type !== 'bedrock').map((s) => s.name))
        return (
          <div key={g.key} style={{ marginBottom: 8 }}>
            <Divider orientation="left" orientationMargin={0}>
              <Space size={6}>
                {g.color && <Badge color={g.color} />}
                <Text strong>{g.label}</Text>
                <Text type="secondary">({g.services.length})</Text>
              </Space>
            </Divider>
            {/* align="stretch" + Card height:100% → le card di una riga sono alte uguali: bordi
                allineati invece del zig-zag di buchi che si vedeva prima. */}
            <Row gutter={[16, 16]} align="stretch">
              {[...g.services].sort(byseverity).map((svc) => (
                <Col key={svc.name} xs={24} sm={12} md={8} lg={6} style={{ display: 'flex' }}>
                  <ServiceCard
                    service={svc}
                    onRemove={caps.watchlist ? onRemove : undefined}
                    onLogs={onLogs}
                    onEvents={onEvents}
                    onOpen={onOpen}
                    familyPrefixes={families}
                    reserveFamily={families.size > 0}
                    t={t}
                  />
                </Col>
              ))}
            </Row>
            </div>
          )
        })}
    </>
  )
}
