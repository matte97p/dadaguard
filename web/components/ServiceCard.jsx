import { Card, Badge, Descriptions, Space, Typography, Tag, Popconfirm, Tooltip } from 'antd'
import {
  DeleteOutlined,
  QuestionCircleOutlined,
  FileTextOutlined,
  HistoryOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { fmtMs } from '../format.js'

// Logo Terraform (SVG inline) colorato per stato del drift: la card mostra solo il logo, il testo
// (sì/no · diffs) va nel tooltip. Verde=conforme, rosso=drift, giallo=stato ignoto.
const TF_COLOR = { up: '#52c41a', degraded: '#ff4d4f', down: '#ff4d4f', unknown: '#faad14' }
function TerraformIcon({ color, size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <path d="M1.44 0v7.575l6.561 3.79V3.787zm21.12 4.227l-6.561 3.789v7.577l6.561-3.789zM8.72 4.23v7.575l6.562 3.79V8.019zm0 8.405v7.574L15.282 24v-7.578z" />
    </svg>
  )
}

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

export default function ServiceCard({ service, onRemove, onLogs, onEvents, t = (k) => k }) {
  const overall = STATUS[service.overall] ?? STATUS.unknown
  const hasLogs = ['lambda', 'ecs'].includes(service.type) // tipi con log applicativi su CloudWatch
  const hasEvents = Boolean(service.type) // eventi operativi (ECS/RDS/ASG) e/o modifiche CloudTrail
  const overallText =
    service.overall && service.overall !== 'unknown' ? t(`card.status.${service.overall}`) : '—'
  const liveness = service.checks?.liveness
  const version = service.checks?.version
  const runtime = service.checks?.runtime
  const drift = service.checks?.drift
  const secrets = service.checks?.secrets
  const security = service.checks?.security
  const alarms = service.checks?.alarms
  const backups = service.checks?.backups
  const links = service.links ?? {}
  const account = service.account

  return (
    <Card
      size="small"
      data-service={service.name}
      // accento colore dell'ambiente: riconosci prod da staging a colpo d'occhio
      style={account?.color ? { borderTop: `3px solid ${account.color}` } : undefined}
      title={<Badge status={overall.status} text={service.name} />}
      extra={
        <Space size={8}>
          {runtime?.schedule && (
            <Tooltip title={runtime.scheduleExpr || t('card.cron.tip')}>
              <Tag icon={<ClockCircleOutlined />} style={{ marginInlineEnd: 0 }}>
                {runtime.schedule}
              </Tag>
            </Tooltip>
          )}
          <Tag color={overall.tag} style={{ marginInlineEnd: 0, fontWeight: 600 }}>
            {overallText}
          </Tag>
          {drift && (
            <Tooltip title={`${t('card.label.drift')}: ${drift.summary ?? drift.reason ?? '—'}`}>
              <span style={{ display: 'inline-flex', alignItems: 'center', cursor: 'help' }}>
                <TerraformIcon color={TF_COLOR[drift.status] ?? '#8c8c8c'} />
              </span>
            </Tooltip>
          )}
          {onLogs && hasLogs && (
            <Link type="secondary" onClick={() => onLogs(service.name)} title={t('logs.button')}>
              <FileTextOutlined />
            </Link>
          )}
          {onEvents && hasEvents && (
            <Link type="secondary" onClick={() => onEvents(service.name)} title={t('events.button')}>
              <HistoryOutlined />
            </Link>
          )}
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
      <Descriptions
        column={1}
        size="small"
        labelStyle={{ fontSize: 12, opacity: 0.65 }}
        contentStyle={{ fontSize: 12.5 }}
      >
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
                <Text type="secondary">· {fmtMs(liveness.latencyMs)}</Text>
              )}
            </Space>
          </Descriptions.Item>
        )}

        {version && (
          <Descriptions.Item label={<RowLabel tip={t('card.tip.build')}>{t('card.label.build')}</RowLabel>}>
            <Space size={4}>
              <CheckBadge status={version.status} />
              <span>{version.summary ?? version.reason ?? '—'}</span>
              {version.expectedSource === 'url' && (
                <Text type="secondary">· {t('card.expectedFrom', { from: version.expectedFrom })}</Text>
              )}
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

        {alarms && (
          <Descriptions.Item label={<RowLabel tip={t('card.tip.alarms')}>{t('card.label.alarms')}</RowLabel>}>
            <Space size={4}>
              <CheckBadge status={alarms.status} />
              <span>{alarms.summary ?? alarms.reason ?? '—'}</span>
            </Space>
          </Descriptions.Item>
        )}

        {backups && (
          <Descriptions.Item label={<RowLabel tip={t('card.tip.backups')}>{t('card.label.backups')}</RowLabel>}>
            <Space size={4}>
              <CheckBadge status={backups.status} />
              <span>{backups.summary ?? backups.reason ?? '—'}</span>
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
