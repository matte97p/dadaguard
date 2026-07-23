import { useEffect, useMemo, useState } from 'react'
import { Spin, Alert, Empty, Typography, Space, Badge, Tag, Segmented, Select, Button } from 'antd'
import { ClockCircleOutlined } from '@ant-design/icons'
import { PageIntro, PANEL_GRID, PANEL_CARD, HeroStat, HeroRow } from './pageKit.jsx'

const { Text } = Typography

// Stato build CodeBuild → colore (stripe + tag) + etichetta i18n.
const STATUS = {
  IN_PROGRESS: { color: '#1677ff', tag: 'processing', key: 'deploys.running' },
  SUCCEEDED: { color: '#52c41a', tag: 'success', key: 'deploys.ok' },
  FAILED: { color: '#cf1322', tag: 'error', key: 'deploys.failed' },
  FAULT: { color: '#cf1322', tag: 'error', key: 'deploys.failed' },
  TIMED_OUT: { color: '#cf1322', tag: 'error', key: 'deploys.failed' },
  STOPPED: { color: '#8c8c8c', tag: 'default', key: 'deploys.stopped' },
}
const FALLBACK = { color: '#8c8c8c', tag: 'default', key: null }
const FAILED_STATUSES = ['FAILED', 'FAULT', 'TIMED_OUT']
const PERIOD_MS = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6 }
const LIMIT = 8 // build mostrati per account prima di "carica altri"

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
  return true
}

function matchPeriod(b, f) {
  if (f === 'all' || !PERIOD_MS[f] || !b.startedAt) return true
  return Date.now() - new Date(b.startedAt).getTime() <= PERIOD_MS[f]
}

// Riga build: stripe colorata a sinistra (stato a colpo d'occhio), riga in-corso evidenziata,
// servizio + trigger sopra, commit·fase/durata sotto, tag stato + "quanto fa" a destra.
function BuildRow({ b, t }) {
  const st = STATUS[b.status] ?? FALLBACK
  const when = b.inProgress ? fmtAgo(b.startedAt, t) : fmtAgo(b.endedAt, t)
  const sub = [b.commit, b.inProgress ? (b.phase ? b.phase.toLowerCase() : null) : fmtDur(b.durationMs)]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 11px',
        borderRadius: 8,
        borderLeft: `3px solid ${st.color}`,
        background: b.inProgress ? 'rgba(22,119,255,0.10)' : 'rgba(128,128,128,0.05)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={8} style={{ minWidth: 0 }}>
          {b.inProgress && <Badge status="processing" />}
          <Text strong style={{ whiteSpace: 'nowrap' }}>
            {b.service}
          </Text>
          {b.number != null && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              #{b.number}
            </Text>
          )}
          {b.trigger && (
            <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '17px', padding: '0 6px', opacity: 0.85 }}>
              {t(`deploys.trigger.${b.trigger}`)}
            </Tag>
          )}
        </Space>
        <div>
          <Text type="secondary" style={{ fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
            {sub}
          </Text>
        </div>
      </div>
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {st.key && (
          <Tag color={st.tag} bordered={false} style={{ marginInlineEnd: 0 }}>
            {t(st.key)}
          </Tag>
        )}
        <div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            <ClockCircleOutlined style={{ marginInlineEnd: 3 }} />
            {when}
          </Text>
        </div>
      </div>
    </div>
  )
}

// Pillole conteggio stato nell'header dell'account (solo quelle > 0).
function CountPills({ builds }) {
  const running = builds.filter((b) => b.inProgress).length
  const ok = builds.filter((b) => b.status === 'SUCCEEDED').length
  const failed = builds.filter((b) => FAILED_STATUSES.includes(b.status)).length
  return (
    <Space size={4}>
      {running > 0 && <Badge count={running} color="#1677ff" />}
      {ok > 0 && <Badge count={ok} color="#52c41a" />}
      {failed > 0 && <Badge count={failed} color="#cf1322" />}
    </Space>
  )
}

// Pagina Deploy: build CodeBuild di deploy (`cato-*-*-deploy`) per account — cosa sta uscendo ora,
// e gli ultimi andati. Read-only, on-demand. Filtri: stato · periodo · servizio; "carica altri" per account.
export default function DeploysPage({ accountLabels, t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [periodFilter, setPeriodFilter] = useState('all')
  const [serviceFilter, setServiceFilter] = useState('all')
  const [expanded, setExpanded] = useState(() => new Set())

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

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('deploys.filter.all') },
      { value: 'running', label: t('deploys.filter.running') },
      { value: 'failed', label: t('deploys.filter.failed') },
      { value: 'ok', label: t('deploys.filter.ok') },
    ],
    [t],
  )
  const periodOptions = useMemo(
    () => [
      { value: 'all', label: t('deploys.period.all') },
      { value: '24h', label: t('deploys.period.24h') },
      { value: '7d', label: t('deploys.period.7d') },
      { value: '30d', label: t('deploys.period.30d') },
    ],
    [t],
  )
  const serviceOptions = useMemo(() => {
    const set = new Set()
    for (const acc of data ? Object.values(data) : []) for (const b of acc.builds ?? []) if (b.service) set.add(b.service)
    return [{ value: 'all', label: t('deploys.allServices') }, ...[...set].sort().map((s) => ({ value: s, label: s }))]
  }, [data, t])

  const anyFilter = statusFilter !== 'all' || periodFilter !== 'all' || serviceFilter !== 'all'
  const toggleExpand = (key) =>
    setExpanded((prev) => {
      const n = new Set(prev)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })

  return (
    <>
      <PageIntro
        title={t('deploys.title')}
        desc={t('deploys.desc')}
        extra={
          <Space wrap size={8}>
            <Segmented size="small" value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
            <Segmented size="small" value={periodFilter} onChange={setPeriodFilter} options={periodOptions} />
            <Select
              size="small"
              value={serviceFilter}
              onChange={setServiceFilter}
              options={serviceOptions}
              style={{ minWidth: 150 }}
            />
          </Space>
        }
      />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      {data && accounts.length === 0 && <Empty description={t('deploys.noAccounts')} style={{ marginTop: 24 }} />}

      {accounts.length > 0 &&
        (() => {
          const all = accounts.flatMap(([, acc]) => acc.builds ?? [])
          const running = all.filter((b) => b.inProgress || b.status === 'IN_PROGRESS').length
          const ok = all.filter((b) => b.status === 'SUCCEEDED').length
          const failed = all.filter((b) => FAILED_STATUSES.includes(b.status)).length
          return (
            <HeroRow>
              {running > 0 && <HeroStat label={t('deploys.running')} value={running} color="#1677ff" size={18} />}
              <HeroStat label={t('deploys.ok')} value={ok} color={ok ? '#52c41a' : undefined} size={18} />
              <HeroStat label={t('deploys.failed')} value={failed} color={failed ? '#ff4d4f' : undefined} size={18} />
            </HeroRow>
          )
        })()}

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
          const filtered = all
            .filter((b) => matchStatus(b, statusFilter))
            .filter((b) => matchPeriod(b, periodFilter))
            .filter((b) => serviceFilter === 'all' || b.service === serviceFilter)
          if (anyFilter && filtered.length === 0) return null
          const isExp = expanded.has(key)
          const shown = isExp ? filtered : filtered.slice(0, LIMIT)
          return (
            <div key={key} style={PANEL_CARD}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Space>
                  {acc.color && <Badge color={acc.color} />}
                  <Text strong style={{ fontSize: 15 }}>
                    {acc.label}
                  </Text>
                </Space>
                <CountPills builds={all} />
              </div>

              {filtered.length === 0 ? (
                <Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
                  {t('deploys.none')}
                </Text>
              ) : (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {shown.map((b) => (
                    <BuildRow key={`${b.project}:${b.number}`} b={b} t={t} />
                  ))}
                  {filtered.length > LIMIT && (
                    <Button type="link" size="small" style={{ alignSelf: 'flex-start', paddingInline: 0 }} onClick={() => toggleExpand(key)}>
                      {isExp ? t('deploys.collapse') : t('deploys.more', { n: filtered.length - LIMIT })}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
