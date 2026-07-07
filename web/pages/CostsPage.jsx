import { useEffect, useState } from 'react'
import { Spin, Alert, Empty, Typography, Space, Badge, Select } from 'antd'
import { PageIntro, PANEL_GRID, PANEL_CARD } from './pageKit.jsx'

const { Text } = Typography

const money = (v) => `${v < 0 ? '−' : ''}$${Math.abs(Number(v ?? 0)).toFixed(2)}`

// Una barra orizzontale proporzionale (viola = consumo, verde = credito/rimborso).
function Bar({ label, amount, max, credit, t }) {
  const color = credit ? '#52c41a' : '#7c3aed'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
        <span>
          {label}
          {credit && <span style={{ marginLeft: 6, color: '#52c41a' }}>{t('costs.creditMark')}</span>}
        </span>
        <span style={{ color: amount < 0 ? '#52c41a' : undefined }}>{money(amount)}</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,0.15)' }}>
        <div
          style={{ height: '100%', borderRadius: 4, width: `${(Math.abs(amount) / max) * 100}%`, background: color }}
        />
      </div>
    </div>
  )
}

// Pagina Costi: consumo per servizio (viola) + crediti/rimborsi (verde) = netto, per account.
// Cost Explorer è a pagamento → fetch on-mount e al cambio mese.
export default function CostsPage({ accountLabels, t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/costs?month=${month}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [month, lang])

  const accounts = (data ? Object.entries(data) : []).filter(
    ([, acc]) => !accountLabels || accountLabels.has(acc.label),
  )
  const now = new Date()
  const monthOptions = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    return { value, label: i === 0 ? `${label} · ${t('costs.current')}` : label }
  })

  return (
    <>
      <PageIntro
        title={t('costs.title')}
        desc={t('costs.desc')}
        extra={
          <Space size={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('costs.month')}
            </Text>
            <Select size="small" value={month} onChange={setMonth} options={monthOptions} style={{ minWidth: 170 }} />
          </Space>
        }
      />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      {data && accounts.length === 0 && <Empty description={t('costs.noAccounts')} style={{ marginTop: 24 }} />}

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
          const items = acc.items ?? []
          const hasCredits = Math.abs(acc.credits ?? 0) > 0.005
          const max = Math.max(1, ...items.map((i) => Math.abs(i.amount)), Math.abs(acc.credits ?? 0))
          return (
            <div key={key} style={PANEL_CARD}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Space>
                  {acc.color && <Badge color={acc.color} />}
                  <Text strong>{acc.label}</Text>
                </Space>
                <div style={{ textAlign: 'right' }}>
                  <Text strong style={{ fontSize: 18 }}>
                    {money(acc.total)}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {' '}
                      {t('costs.net')}
                    </Text>
                  </Text>
                  {acc.forecast != null && (
                    <div>
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {t('costs.forecast')} {money(acc.forecast)}
                      </Text>
                    </div>
                  )}
                </div>
              </div>

              {(items.length > 0 || hasCredits) && (
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('costs.usage', { v: money(acc.gross) })}
                    {hasCredits && ` · ${t('costs.credits', { v: money(acc.credits) })}`}
                  </Text>
                </div>
              )}

              {items.length === 0 && !hasCredits ? (
                <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                  {t('costs.none')}
                </Text>
              ) : (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.map((it) => (
                    <Bar key={it.service} label={it.service} amount={it.amount} max={max} t={t} />
                  ))}
                  {hasCredits && (
                    <Bar label={t('costs.creditsRefunds')} amount={acc.credits} max={max} credit t={t} />
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
