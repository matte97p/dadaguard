import { useEffect, useState } from 'react'
import { Spin, Alert, Empty, Typography, Space, Badge, Progress } from 'antd'
import { PageIntro, PANEL_GRID, PANEL_CARD } from './pageKit.jsx'

const { Text } = Typography

// Pagina Quote: Service Quotas vicine al limite, per account. On-demand (Service Quotas + CloudWatch).
export default function QuotasPage({ accountLabels, t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/quotas?lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [lang])

  const accounts = (data?.accounts ?? []).filter((a) => !accountLabels || accountLabels.has(a.label))
  const anyQuota = accounts.some((a) => (a.quotas ?? []).length)

  return (
    <>
      <PageIntro title={t('quotas.title')} desc={t('quotas.desc')} />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin tip={t('quotas.loading')} />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
      {data && accounts.length === 0 && <Empty description={t('quotas.noAccounts')} style={{ marginTop: 24 }} />}
      {data && accounts.length > 0 && !anyQuota && !loading && (
        <Empty description={t('quotas.none')} style={{ marginTop: 24 }} />
      )}

      <div style={PANEL_GRID}>
        {accounts.map(
          (a) =>
            (a.error || (a.quotas ?? []).length > 0) && (
              <div key={a.account} style={PANEL_CARD}>
                <Space>
                  {a.color && <Badge color={a.color} />}
                  <Text strong>{a.label}</Text>
                </Space>
                {a.error ? (
                  <Alert type="warning" showIcon style={{ marginTop: 6 }} message={a.error} />
                ) : (
                  <Space direction="vertical" style={{ width: '100%', marginTop: 6 }} size={10}>
                    {a.quotas.map((q, i) => (
                      <div key={i}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8 }}>
                          <span>
                            {q.name} <Text type="secondary">· {q.service}</Text>
                          </span>
                          <span style={{ color: q.pct >= 90 ? '#ff4d4f' : '#faad14', fontWeight: 600 }}>{q.pct}%</span>
                        </div>
                        <Progress
                          percent={Math.min(q.pct, 100)}
                          showInfo={false}
                          size="small"
                          strokeColor={q.pct >= 90 ? '#ff4d4f' : '#faad14'}
                        />
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {Math.round(q.used).toLocaleString()} / {Number(q.limit).toLocaleString()}
                        </Text>
                      </div>
                    ))}
                  </Space>
                )}
              </div>
            ),
        )}
      </div>
    </>
  )
}
