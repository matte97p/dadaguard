import { Card, Badge, Descriptions, Space, Typography, Tag, Popconfirm, Tooltip } from 'antd'
import { DeleteOutlined, QuestionCircleOutlined } from '@ant-design/icons'

const STATUS = {
  up: { status: 'success', tag: 'success' },
  degraded: { status: 'warning', tag: 'warning' },
  down: { status: 'error', tag: 'error' },
  idle: { status: 'default', tag: 'default' },
  disabled: { status: 'default', tag: 'default' },
  unknown: { status: 'default', tag: 'default' },
}

const { Link, Text } = Typography

function CheckBadge({ status }) {
  return <Badge status={STATUS[status]?.status ?? 'default'} />
}

// Etichetta riga + tooltip che spiega COSA misura il segnale (il contenuto, da solo, è gergo).
function RowLabel({ children, tip }) {
  return (
    <Space size={4}>
      <span>{children}</span>
      <Tooltip title={tip}>
        <QuestionCircleOutlined style={{ color: '#bfbfbf', fontSize: 11, cursor: 'help' }} />
      </Tooltip>
    </Space>
  )
}

export default function ServiceCard({ service, onRemove, t = (k) => k }) {
  const overall = STATUS[service.overall] ?? STATUS.unknown
  const overallText =
    service.overall && service.overall !== 'unknown' ? t(`card.status.${service.overall}`) : '—'
  const liveness = service.checks?.liveness
  const version = service.checks?.version
  const runtime = service.checks?.runtime
  const drift = service.checks?.drift
  const secrets = service.checks?.secrets
  const security = service.checks?.security
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
            {overallText}
          </Tag>
          {onRemove && (
            <Popconfirm
              title={t('card.removeTitle')}
              description={t('card.removeDesc')}
              okText={t('card.removeOk')}
              cancelText={t('card.removeCancel')}
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
          <Descriptions.Item label={<RowLabel tip={t('card.tip.reachable')}>{t('card.label.reachable')}</RowLabel>}>
            <Space size={4}>
              <CheckBadge status={liveness.status} />
              <span>
                {liveness.httpStatus
                  ? t('card.responds', { code: liveness.httpStatus })
                  : liveness.reason ?? '—'}
              </span>
              {typeof liveness.latencyMs === 'number' && (
                <Text type="secondary">· {liveness.latencyMs}ms</Text>
              )}
            </Space>
          </Descriptions.Item>
        )}

        {version && (
          <Descriptions.Item label={<RowLabel tip={t('card.tip.build')}>{t('card.label.build')}</RowLabel>}>
            <Space size={4}>
              <CheckBadge status={version.status} />
              <span>{version.summary ?? version.reason ?? '—'}</span>
            </Space>
          </Descriptions.Item>
        )}

        {runtime && (
          <Descriptions.Item label={<RowLabel tip={t('card.tip.runtime')}>{t('card.label.runtime')}</RowLabel>}>
            <Space size={4}>
              <CheckBadge status={runtime.status} />
              <span>{runtime.summary ?? runtime.reason ?? '—'}</span>
            </Space>
          </Descriptions.Item>
        )}

        {drift && (
          <Descriptions.Item label={<RowLabel tip={t('card.tip.drift')}>{t('card.label.drift')}</RowLabel>}>
            <Space size={4}>
              <CheckBadge status={drift.status} />
              <span>{drift.summary ?? drift.reason ?? '—'}</span>
            </Space>
          </Descriptions.Item>
        )}

        {secrets && (
          <Descriptions.Item label={<RowLabel tip={t('card.tip.secret')}>{t('card.label.secret')}</RowLabel>}>
            <Space size={4}>
              <CheckBadge status={secrets.status} />
              <span>{secrets.summary ?? secrets.reason ?? '—'}</span>
            </Space>
          </Descriptions.Item>
        )}

        {security && (
          <Descriptions.Item label={<RowLabel tip={t('card.tip.security')}>{t('card.label.security')}</RowLabel>}>
            <Space size={4}>
              <CheckBadge status={security.status} />
              <span>{security.summary ?? security.reason ?? '—'}</span>
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
