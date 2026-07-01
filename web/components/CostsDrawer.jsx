import { useEffect, useState } from 'react'
import { Drawer, Spin, Alert, Empty, Typography, Divider, Space, Badge, Select } from 'antd'

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

// Costi MTD per account: CONSUMO per servizio (viola) + CREDITI/rimborsi (verde) = netto.
// Fetch on-demand (Cost Explorer è a pagamento).
export default function CostsDrawer({ open, onClose, accountLabels, t = (k) => k }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [month, setMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    fetch(`/api/costs?month=${month}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open, month])

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
    <Drawer title={t('costs.title')} placement="right" width={560} open={open} onClose={onClose}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="center" wrap>
        <Text type="secondary">{t('costs.desc')}</Text>
        <Space size={6}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('costs.month')}
          </Text>
          <Select size="small" value={month} onChange={setMonth} options={monthOptions} style={{ minWidth: 170 }} />
        </Space>
      </Space>
      <Divider />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {data && accounts.length === 0 && <Empty description={t('costs.noAccounts')} />}

      {accounts.map(([key, acc]) => {
        if (acc.error) {
          return (
            <div key={key} style={{ marginBottom: 24 }}>
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
          <div key={key} style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Space>
                {acc.color && <Badge color={acc.color} />}
                <Text strong>{acc.label}</Text>
              </Space>
              <Text strong style={{ fontSize: 18 }}>
                {money(acc.total)}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {' '}
                  {t('costs.net')}
                </Text>
              </Text>
            </div>

            {/* riepilogo consumo/crediti */}
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
    </Drawer>
  )
}
