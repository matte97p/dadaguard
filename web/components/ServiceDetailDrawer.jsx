import { Drawer, Badge, Typography, Space, Button, Descriptions, Tag } from 'antd'
import { FileTextOutlined, ClockCircleOutlined, RocketOutlined, DollarOutlined } from '@ant-design/icons'

const { Text, Link } = Typography

const STATUS = { down: 'error', degraded: 'warning', up: 'success', idle: 'default', disabled: 'default', unknown: 'default' }

// Tutti i segnali del servizio, in ordine, con la loro etichetta i18n.
const CHECKS = [
  ['liveness', 'card.label.reachable'],
  ['version', 'card.label.build'],
  ['runtime', 'card.label.runtime'],
  ['secrets', 'card.label.secret'],
  ['security', 'card.label.security'],
  ['alarms', 'card.label.alarms'],
  ['backups', 'card.label.backups'],
]

// Drawer unico per-servizio: raccoglie stato + tutti i check in un posto, con accesso rapido a
// Log / Eventi / Deploy / Costi. Riusa i drawer esistenti (onLogs/onEvents) — niente duplicazione.
export default function ServiceDetailDrawer({ service, onClose, onLogs, onEvents, onNavigate, t = (k) => k }) {
  const checks = service?.checks ?? {}
  const links = service?.links ?? {}
  return (
    <Drawer
      open={!!service}
      onClose={onClose}
      width={520}
      title={
        service && (
          <Space size={8} wrap>
            <Badge status={STATUS[service.overall] ?? 'default'} />
            <Text strong>{service.name}</Text>
            {service.type && <Tag>{service.type}</Tag>}
          </Space>
        )
      }
    >
      {service && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {[service.account?.label, service.region].filter(Boolean).join(' · ')}
          </Text>

          <Space wrap>
            <Button size="small" icon={<FileTextOutlined />} onClick={() => onLogs?.(service.name)}>
              {t('logs.button')}
            </Button>
            <Button size="small" icon={<ClockCircleOutlined />} onClick={() => onEvents?.(service.name)}>
              {t('events.button')}
            </Button>
            <Button size="small" icon={<RocketOutlined />} onClick={() => onNavigate?.('/deploy')}>
              {t('btn.deploys')}
            </Button>
            <Button size="small" icon={<DollarOutlined />} onClick={() => onNavigate?.('/costi')}>
              {t('btn.costs')}
            </Button>
          </Space>

          <Descriptions column={1} size="small" bordered labelStyle={{ width: 120 }}>
            {CHECKS.filter(([k]) => checks[k]).map(([k, labelKey]) => {
              const c = checks[k]
              return (
                <Descriptions.Item key={k} label={t(labelKey)}>
                  <Space size={6} align="start">
                    <Badge status={STATUS[c.status] ?? 'default'} />
                    <span>{c.summary ?? c.reason ?? '—'}</span>
                  </Space>
                </Descriptions.Item>
              )
            })}
          </Descriptions>

          {Object.keys(links).length > 0 && (
            <Space wrap>
              {Object.entries(links).map(([label, url]) => (
                <Link key={label} href={url} target="_blank" rel="noreferrer">
                  {label} ↗
                </Link>
              ))}
            </Space>
          )}
        </Space>
      )}
    </Drawer>
  )
}
