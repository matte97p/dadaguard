import { Row, Col, Divider, Badge, Typography, Space, Alert, Empty, Spin } from 'antd'
import ServiceCard from '../components/ServiceCard.jsx'
import StatusSummary from '../components/StatusSummary.jsx'

const { Text } = Typography

// Ordinamento: problemi in cima (down → degraded → sconosciuto/idle → ok), poi per nome. Così le
// cose rotte si vedono per prime senza scorrere.
const SEV = { down: 0, degraded: 1, unknown: 2, idle: 3, disabled: 3, up: 4 }
const byseverity = (a, b) => (SEV[a.overall] ?? 2) - (SEV[b.overall] ?? 2) || String(a.name).localeCompare(String(b.name))

// Pagina principale: le card dei servizi, raggruppate per account, con il riepilogo di stato in cima.
export default function DashboardPage({ data, groups, caps, loading, error, onRemove, onLogs, onEvents, t }) {
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
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      )}
      {data && groups.length === 0 && <Empty description={t('content.noServices')} style={{ marginTop: 48 }} />}

      {groups.map((g) => (
        <div key={g.key} style={{ marginBottom: 8 }}>
          <Divider orientation="left" orientationMargin={0}>
            <Space size={6}>
              {g.color && <Badge color={g.color} />}
              <Text strong>{g.label}</Text>
              <Text type="secondary">({g.services.length})</Text>
            </Space>
          </Divider>
          <Row gutter={[16, 16]}>
            {[...g.services].sort(byseverity).map((svc) => (
              <Col key={svc.name} xs={24} sm={12} md={8} lg={6}>
                <ServiceCard
                  service={svc}
                  onRemove={caps.watchlist ? onRemove : undefined}
                  onLogs={onLogs}
                  onEvents={onEvents}
                  t={t}
                />
              </Col>
            ))}
          </Row>
        </div>
      ))}
    </>
  )
}
