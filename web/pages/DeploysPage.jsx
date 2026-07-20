import { useEffect, useMemo, useState } from 'react'
import { Spin, Alert, Empty, Typography, Space, Badge, Tag, Segmented } from 'antd'
import { PageIntro, PANEL_GRID, PANEL_CARD } from './pageKit.jsx'

const { Text } = Typography

// Stato build CodeBuild → estetica (pallino Ant + etichetta i18n). In-corso = blu "processing",
// ok = verde, fallito/fault/timeout = rosso, fermato = grigio.
const STATUS = {
  IN_PROGRESS: { badge: 'processing', key: 'deploys.running' },
  SUCCEEDED: { badge: 'success', key: 'deploys.ok' },
  FAILED: { badge: 'error', key: 'deploys.failed' },
  FAULT: { badge: 'error', key: 'deploys.failed' },
  TIMED_OUT: { badge: 'error', key: 'deploys.failed' },
  STOPPED: { badge: 'default', key: 'deploys.stopped' },
}

const FAILED_STATUSES = ['FAILED', 'FAULT', 'TIMED_OUT']

// "quanto fa": min → ore → giorni → settimane, così non si vedono mai "419h fa".
function fmtAgo(from, t) {
  if (!from) return ''
  const min = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60000))
  if (min < 1) return t('deploys.now')
  if (min < 60) return t('deploys.minAgo', { m: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('deploys.hAgo', { h, m: min % 60 })
  const d = Math.floor(h / 24)
  if (d < 7) return t('deploys.dAgo', { d, h: h % 24 })
  return t('deploys.wAgo', { w: Math.floor(d / 7), d: d % 7 })
}

function fmtDur(ms) {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function matchStatus(b, f) {
  if (f === 'running') return b.inProgress
  if (f === 'failed') return FAILED_STATUSES.includes(b.status)
  if (f === 'ok') return b.status === 'SUCCEEDED'
  return true // 'all'
}

function BuildRow({ b, t }) {
  const st = STATUS[b.status] ?? { badge: 'default', key: null }
  const when = b.inProgress ? fmtAgo(b.startedAt, t) : fmtAgo(b.endedAt, t)
  const meta = [
    b.commit,
    b.trigger ? t(`deploys.trigger.${b.trigger}`) : null,
    b.inProgress ? (b.phase ? b.phase.toLowerCase() : null) : fmtDur(b.durationMs),
    when,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
      <Space size={8} style={{ minWidth: 0 }}>
        <Badge status={st.badge} />
        <Text strong style={{ whiteSpace: 'nowrap' }}>
          {b.service}
        </Text>
        {b.number != null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            #{b.number}
          </Text>
        )}
      </Space>
      <Space size={8} style={{ minWidth: 0, justifyContent: 'flex-end' }}>
        <Text type="secondary" style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
          {meta}
        </Text>
        {st.key && (
          <Tag
            color={st.badge === 'processing' ? 'processing' : st.badge === 'success' ? 'success' : st.badge === 'error' ? 'error' : 'default'}
            style={{ marginInlineEnd: 0 }}
          >
            {t(st.key)}
          </Tag>
        )}
      </Space>
    </div>
  )
}

// Pagina Deploy: build CodeBuild di deploy (`cato-*-*-deploy`) per account — cosa sta uscendo ora,
// e gli ultimi andati. Read-only, on-demand. Filtro per stato (tutti/in corso/falliti/ok).
export default function DeploysPage({ accountLabels, t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/deploys?lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [lang])

  const accounts = (data ? Object.entries(data) : []).filter(
    ([, acc]) => !accountLabels || accountLabels.has(acc.label),
  )

  const filterOptions = useMemo(
    () => [
      { value: 'all', label: t('deploys.filter.all') },
      { value: 'running', label: t('deploys.filter.running') },
      { value: 'failed', label: t('deploys.filter.failed') },
      { value: 'ok', label: t('deploys.filter.ok') },
    ],
    [t],
  )

  return (
    <>
      <PageIntro
        title={t('deploys.title')}
        desc={t('deploys.desc')}
        extra={<Segmented size="small" value={statusFilter} onChange={setStatusFilter} options={filterOptions} />}
      />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      {data && accounts.length === 0 && <Empty description={t('deploys.noAccounts')} style={{ marginTop: 24 }} />}

      <div style={PANEL_GRID}>
        {accounts.map(([key, acc]) => {
          if (acc.error) {
            return (
              <div key={key} style={PANEL_CARD}>
                <Space>
                  {acc.color && <Badge color={acc.color} />}
                  <Text strong>{acc.label}</Text>
                </Space>
                <Alert type="warning" showIcon style={{ marginTop: 8 }} message={acc.error} />
              </div>
            )
          }
          const all = acc.builds ?? []
          const builds = all.filter((b) => matchStatus(b, statusFilter))
          const running = all.filter((b) => b.inProgress).length
          // Con un filtro attivo, salta le card senza risultati (non c'è nulla da mostrare per quell'account).
          if (statusFilter !== 'all' && builds.length === 0) return null
          return (
            <div key={key} style={PANEL_CARD}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Space>
                  {acc.color && <Badge color={acc.color} />}
                  <Text strong>{acc.label}</Text>
                </Space>
                {running > 0 && <Badge status="processing" text={t('deploys.inProgress', { n: running })} />}
              </div>

              {builds.length === 0 ? (
                <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                  {t('deploys.none')}
                </Text>
              ) : (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {builds.map((b) => (
                    <BuildRow key={`${b.project}:${b.number}`} b={b} t={t} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
