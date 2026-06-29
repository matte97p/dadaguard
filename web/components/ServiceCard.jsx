import { Card, Badge, Descriptions, Space, Typography, Tag, Popconfirm } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'

const STATUS = {
  up: { status: 'success', text: 'UP', tag: 'success' },
  degraded: { status: 'warning', text: 'DEGRADED', tag: 'warning' },
  down: { status: 'error', text: 'DOWN', tag: 'error' },
  idle: { status: 'default', text: 'IDLE', tag: 'default' },
  disabled: { status: 'default', text: 'DISABLED', tag: 'default' },
  unknown: { status: 'default', text: '—', tag: 'default' },
}

const { Link, Text } = Typography

function CheckBadge({ status }) {
  return <Badge status={STATUS[status]?.status ?? 'default'} />
}

export default function ServiceCard({ service, onRemove }) {
  const overall = STATUS[service.overall] ?? STATUS.unknown
  const liveness = service.checks?.liveness
  const version = service.checks?.version
  const runtime = service.checks?.runtime
  const drift = service.checks?.drift
  const secrets = service.checks?.secrets
  const links = service.links ?? {}
  const account = service.account

  return (
    <Card
      size="small"
      // accento colore dell'ambiente: riconosci prod da staging a colpo d'occhio
      style={account?.color ? { borderTop: `3px solid ${account.color}` } : undefined}
      title={<Badge status={overall.status} text={service.name} />}
      extra={
        <Space size={8}>
          <Tag color={overall.tag} style={{ marginInlineEnd: 0, fontWeight: 600 }}>
            {overall.text}
          </Tag>
          {onRemove && (
            <Popconfirm
              title="Togliere dalla watchlist?"
              description="Smette solo di monitorarlo — non tocca AWS."
              okText="Togli"
              cancelText="Annulla"
              onConfirm={() => onRemove(service.name)}
            >
              <Link type="secondary">
                <DeleteOutlined />
              </Link>
            </Popconfirm>
          )}
        </Space>
      }
    >
      <Descriptions column={1} size="small">
        {liveness && (
          <Descriptions.Item label="Liveness">
            <Space size={4}>
              <CheckBadge status={liveness.status} />
              <span>
                {liveness.httpStatus ? `HTTP ${liveness.httpStatus}` : liveness.reason ?? '—'}
              </span>
              {typeof liveness.latencyMs === 'number' && (
                <Text type="secondary">· {liveness.latencyMs}ms</Text>
              )}
            </Space>
          </Descriptions.Item>
        )}

        {version && (
          <Descriptions.Item label="Versione">
            <Space size={4}>
              <CheckBadge status={version.status} />
              <span>{version.summary ?? version.reason ?? '—'}</span>
            </Space>
          </Descriptions.Item>
        )}

        {runtime && (
          <Descriptions.Item label="Runtime">
            <Space size={4}>
              <CheckBadge status={runtime.status} />
              <span>{runtime.summary ?? runtime.reason ?? '—'}</span>
            </Space>
          </Descriptions.Item>
        )}

        {drift && (
          <Descriptions.Item label="Drift TF">
            <Space size={4}>
              <CheckBadge status={drift.status} />
              <span>{drift.summary ?? drift.reason ?? '—'}</span>
            </Space>
          </Descriptions.Item>
        )}

        {secrets && (
          <Descriptions.Item label="Secrets">
            <Space size={4}>
              <CheckBadge status={secrets.status} />
              <span>{secrets.summary ?? secrets.reason ?? '—'}</span>
            </Space>
          </Descriptions.Item>
        )}
      </Descriptions>

      {Object.keys(links).length > 0 && (
        <Space size="small" wrap style={{ marginTop: 8 }}>
          {Object.entries(links).map(([label, url]) => (
            <Link key={label} href={url} target="_blank" rel="noreferrer">
              {label} ↗
            </Link>
          ))}
        </Space>
      )}
    </Card>
  )
}
