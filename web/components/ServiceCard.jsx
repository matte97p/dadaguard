import { Card, Badge, Descriptions, Space, Typography, Tag, Popconfirm, Tooltip } from 'antd'
import {
  DeleteOutlined,
  QuestionCircleOutlined,
  FileTextOutlined,
  HistoryOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { fmtMs } from '../format.js'
import { prettyBedrock } from '../serviceName.js'
import Sparkline from './Sparkline.jsx'

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


// Espone un summary denso ("a · b · c (60m)") come PILLOLE separate che vanno a capo pulite,
// invece di una stringa unica illeggibile. L'eventuale finestra finale "(60m)" resta muta a destra.
function MetricChips({ text }) {
  if (!text) return <span>—</span>
  const s = String(text)
  const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/) // estrae la finestra finale, non i "(4xx)" a metà
  const body = m ? m[1] : s
  const win = m ? m[2] : null
  const parts = body.split(' · ').map((p) => p.trim()).filter(Boolean)
  if (parts.length <= 1 && !win) return <span>{s}</span>
  return (
    <Space size={[6, 3]} wrap>
      {parts.map((p, i) => (
        <span
          key={i}
          style={{ background: 'rgba(128,128,128,0.14)', borderRadius: 6, padding: '0 6px', fontSize: 12, whiteSpace: 'nowrap' }}
        >
          {p}
        </span>
      ))}
      {win && <Text type="secondary" style={{ fontSize: 11 }}>{win}</Text>}
    </Space>
  )
}

// Colore di STATO (riservato): errori/throttle spiccano; il resto resta in ink normale. Il colore
// non è mai l'unico segnale — ogni tile ha la sua label (mai "colore da solo"). Palette allineata ad antd.
const STAT_TONE = { critical: '#ff4d4f', warning: '#faad14', serious: '#fa8c16', good: '#52c41a' }

// KPI row di stat tile: label muta piccola sopra, valore semibold sotto. La forma giusta per "un
// pugno di numeri di testa" (dataviz: KPI row), invece della stringa/pillole indistinte.
function StatRow({ metrics, window }) {
  const Tile = ({ label, value, color }) => (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.15 }}>
      <Text type="secondary" style={{ fontSize: 10, letterSpacing: 0.2, whiteSpace: 'nowrap' }}>{label || ' '}</Text>
      <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', color }}>{value}</span>
    </span>
  )
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', alignItems: 'flex-end' }}>
      {metrics.map((m, i) => (
        <Tile key={i} label={m.label} value={m.value} color={m.tone ? STAT_TONE[m.tone] : undefined} />
      ))}
      {window && <Text type="secondary" style={{ fontSize: 11, alignSelf: 'flex-end' }}>{window}</Text>}
    </div>
  )
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

export default function ServiceCard({ service, onRemove, onLogs, onEvents, onOpen, t = (k) => k }) {
  const overall = STATUS[service.overall] ?? STATUS.unknown
  const hasLogs = ['lambda', 'ecs', 'ecs-scheduled'].includes(service.type) // tipi con log applicativi su CloudWatch
  const hasEvents = Boolean(service.type) // eventi operativi (ECS/RDS/ASG) e/o modifiche CloudTrail
  // Badge parlante: se il servizio è in stato "problema" (giallo/rosso), il testo dice IL PERCHÉ
  // (il check colpevole, es. "ALLARME" / "ESECUZIONE") invece del generico "ATTENZIONE"/"GIÙ";
  // negli altri stati resta l'etichetta di stato. Il dettaglio esatto va nel tooltip.
  const isBad = service.overall === 'degraded' || service.overall === 'down'
  const causeKey = isBad ? service.cause : null
  const causeCheck = causeKey ? service.checks?.[causeKey] : null
  const overallText =
    isBad && causeKey
      ? t(`cause.${causeKey}`)
      : service.overall && service.overall !== 'unknown'
        ? t(`card.status.${service.overall}`)
        : '—'
  const moreCauses = (service.causes?.length ?? 0) - 1
  const overallTip = isBad
    ? [t(`card.status.${service.overall}`), causeCheck?.summary ?? causeCheck?.reason]
        .filter(Boolean)
        .join(' — ') + (moreCauses > 0 ? ` (+${moreCauses})` : '')
    : null
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
      title={
        (() => {
          const bedrock = service.type === 'bedrock' ? prettyBedrock(service.name) : null
          const sub = bedrock ? (bedrock.name !== service.name ? [bedrock.meta, service.name].filter(Boolean).join(' · ') : null) : service.description
          return (
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
              <Tooltip title={service.name}>
                <span
                  onClick={onOpen ? () => onOpen(service.name) : undefined}
                  style={onOpen ? { cursor: 'pointer' } : undefined}
                >
                  <Badge status={overall.status} text={bedrock?.name ?? service.name} />
                </span>
              </Tooltip>
              {sub && (
                <Text type="secondary" style={{ fontSize: 11, fontWeight: 400, whiteSpace: 'normal' }}>
                  {sub}
                </Text>
              )}
            </div>
          )
        })()
      }
      extra={
        <Space size={8}>
          {runtime?.schedule && (
            <Tooltip title={[runtime.scheduleExpr || t('card.cron.tip'), runtime.nextRunLabel].filter(Boolean).join(' · ')}>
              <Tag icon={<ClockCircleOutlined />} style={{ marginInlineEnd: 0 }}>
                {runtime.schedule}
              </Tag>
            </Tooltip>
          )}
          <Tooltip title={overallTip}>
            <Tag color={overall.tag} style={{ marginInlineEnd: 0, fontWeight: 600 }}>
              {overallText}
            </Tag>
          </Tooltip>
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
            <Space size={4} align="start">
              <CheckBadge status={version.status} />
              {version.summary ? <MetricChips text={version.summary} /> : <span>{version.reason ?? '—'}</span>}
              {version.expectedSource === 'url' && (
                <Text type="secondary">· {t('card.expectedFrom', { from: version.expectedFrom })}</Text>
              )}
            </Space>
          </Descriptions.Item>
        )}

        {runtime && (
          <Descriptions.Item label={<RowLabel tip={t('card.tip.runtime')}>{t('card.label.runtime')}</RowLabel>}>
            <Space size={4} align="start" wrap>
              <CheckBadge status={runtime.status} />
              {runtime.metrics?.length ? (
                <StatRow metrics={runtime.metrics} window={runtime.window} />
              ) : runtime.summary ? (
                <MetricChips text={runtime.summary} />
              ) : (
                <span>{runtime.reason ?? '—'}</span>
              )}
              {runtime.nextRunLabel && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  · {runtime.nextRunLabel}
                </Text>
              )}
              {runtime.spark?.length > 1 && <Sparkline data={runtime.spark} />}
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
