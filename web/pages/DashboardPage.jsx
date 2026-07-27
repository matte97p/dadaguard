import { Row, Col, Divider, Badge, Typography, Space, Alert, Empty, Card, Skeleton } from 'antd'
import ServiceCard from '../components/ServiceCard.jsx'
import StatusSummary from '../components/StatusSummary.jsx'
import { familyPrefixes } from '../serviceName.js'

const { Text } = Typography

// Ordinamento: problemi in cima (down → degraded → sconosciuto/idle → ok), poi per nome. Così le
// cose rotte si vedono per prime senza scorrere. In fondo gli SPENTI di proposito (cron disattivate):
// non sono un problema e non devono stare sopra i servizi sani.
const SEV = { down: 0, degraded: 1, unknown: 2, idle: 3, up: 4, disabled: 5 }
const byseverity = (a, b) => (SEV[a.overall] ?? 2) - (SEV[b.overall] ?? 2) || String(a.name).localeCompare(String(b.name))

// Pagina principale: le card dei servizi, raggruppate per account, con il riepilogo di stato in cima.
export default function DashboardPage({ data, groups, caps, loading, error, onRemove, onLogs, onEvents, onOpen, t }) {
  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} wrap>
        {data ? <StatusSummary services={groups.flatMap((g) => g.services)} t={t} /> : <span />}
        {data?.generatedAt && (
          <Text type="secondary">
            {t('content.lastFetch')} {new Date(data.generatedAt).toLocaleTimeString()}
          </Text>
        )}
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

      {groups.map((g) => {
        // Prefissi di famiglia calcolati sul GRUPPO visibile (cato-staging-cron-…): la card li mostra
        // piccoli e muti e tiene in evidenza la coda, la parte che distingue una card dall'altra.
        const families = familyPrefixes(g.services.map((s) => s.name))
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
