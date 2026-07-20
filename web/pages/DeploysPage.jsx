import { useEffect, useState } from 'react'
import { Spin, Alert, Empty, Typography, Space, Badge, Tag } from 'antd'
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

function fmtAgo(from, t) {
  if (!from) return ''
  const m = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60000))
  if (m < 1) return t('deploys.now')
  if (m < 60) return t('deploys.minAgo', { m })
  return t('deploys.hAgo', { h: Math.floor(m / 60), m: m % 60 })
}

function fmtDur(ms) {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function BuildRow({ b, t }) {
  const st = STATUS[b.status] ?? { badge: 'default', key: null }
  const when = b.inProgress ? fmtAgo(b.startedAt, t) : fmtAgo(b.endedAt, t)
  const meta = [b.commit, b.inProgress ? null : fmtDur(b.durationMs), when].filter(Boolean).join(' · ')
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
          <Tag color={st.badge === 'processing' ? 'processing' : st.badge === 'success' ? 'success' : st.badge === 'error' ? 'error' : 'default'} style={{ marginInlineEnd: 0 }}>
            {t(st.key)}
          </Tag>
        )}
      </Space>
    </div>
  )
}

// Pagina Deploy: build CodeBuild di deploy (`cato-*-*-deploy`) per account — cosa sta uscendo ora,
// e gli ultimi andati. Read-only, on-demand.
export default function DeploysPage({ accountLabels, t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

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

  return (
    <>
      <PageIntro title={t('deploys.title')} desc={t('deploys.desc')} />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      {data && accounts.length === 0 && <Empty description={t('deploys.noAccounts')} style={{ marginTop: 24 }} />}

      <div style={PANEL_GRID}>
        {accounts.map(([key, acc]) => {
          const builds = acc.builds ?? []
          const running = builds.filter((b) => b.inProgress).length
          return (
            <div key={key} style={PANEL_CARD}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Space>
                  {acc.color && <Badge color={acc.color} />}
                  <Text strong>{acc.label}</Text>
                </Space>
                {running > 0 && <Badge status="processing" text={t('deploys.inProgress', { n: running })} />}
              </div>

              {acc.error ? (
                <Alert type="warning" showIcon style={{ marginTop: 8 }} message={acc.error} />
              ) : builds.length === 0 ? (
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
