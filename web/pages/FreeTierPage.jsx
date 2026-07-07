import { useEffect, useState } from 'react'
import { Spin, Alert, Empty, Typography, Space, Progress } from 'antd'
import { PageIntro, PANEL_CARD } from './pageKit.jsx'

const { Text } = Typography

// Verde < 85%, ambra < 100%, rosso ≥ 100% (sopra il limite gratuito → si paga l'overage).
const color = (pct) => (pct >= 100 ? '#ff4d4f' : pct >= 85 ? '#faad14' : '#52c41a')

// Pagina Free Tier: uso mensile vs limite gratuito per offerta AWS (es. CodeBuild 100 build-min).
// Dato org-wide letto dal payer. On-demand.
export default function FreeTierPage({ t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/freetier?lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [lang])

  const items = data?.items ?? []

  return (
    <>
      <PageIntro title={t('freetier.title')} desc={t('freetier.desc')} />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin tip={t('freetier.loading')} />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
      {data?.error && <Alert type="warning" showIcon message={data.error} style={{ marginTop: 8 }} />}
      {data && !data.error && items.length === 0 && !loading && (
        <Empty description={t('freetier.none')} style={{ marginTop: 24 }} />
      )}

      {items.length > 0 && (
        <div style={{ ...PANEL_CARD, maxWidth: 720 }}>
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {items.map((it, i) => (
              <div key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8 }}>
                  <span>
                    {it.service}
                    {it.usageType ? <Text type="secondary"> · {it.usageType}</Text> : null}
                  </span>
                  <span style={{ color: color(it.pct), fontWeight: 600 }}>{it.pct}%</span>
                </div>
                <Progress percent={Math.min(it.pct, 100)} showInfo={false} size="small" strokeColor={color(it.pct)} />
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {it.used.toLocaleString()} / {it.limit.toLocaleString()}
                  {it.unit ? ` ${it.unit}` : ''}
                  {it.forecast > 0 ? ` · ${t('freetier.forecast')} ${it.forecast.toLocaleString()}` : ''}
                </Text>
              </div>
            ))}
          </Space>
        </div>
      )}
    </>
  )
}
