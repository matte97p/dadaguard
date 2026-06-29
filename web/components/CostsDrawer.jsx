import { useEffect, useState } from 'react'
import { Drawer, Spin, Alert, Empty, Typography, Divider, Space, Badge } from 'antd'

const { Text } = Typography

const money = (v) => `${v < 0 ? '−' : ''}$${Math.abs(Number(v ?? 0)).toFixed(2)}`

// Una barra orizzontale proporzionale (viola = consumo, verde = credito/rimborso).
function Bar({ label, amount, max, credit }) {
  const color = credit ? '#52c41a' : '#7c3aed'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
        <span>
          {label}
          {credit && <span style={{ marginLeft: 6, color: '#52c41a' }}>(credito)</span>}
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
export default function CostsDrawer({ open, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    fetch('/api/costs')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open])

  const accounts = data ? Object.entries(data) : []

  return (
    <Drawer title="Costi · mese corrente" placement="right" width={560} open={open} onClose={onClose}>
      <Text type="secondary">
        Spesa <b>reale</b> MTD: <b style={{ color: '#7c3aed' }}>consumo</b> per servizio{' '}
        <b>−</b> <b style={{ color: '#52c41a' }}>crediti/rimborsi</b> <b>=</b> netto (quanto paghi). Dati ~24h di
        ritardo; on-demand. Diverso da “Sprechi”, che è la stima a listino.
      </Text>
      <Divider />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {data && accounts.length === 0 && <Empty description="Nessun account configurato" />}

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
                  netto
                </Text>
              </Text>
            </div>

            {/* riepilogo consumo/crediti */}
            {(items.length > 0 || hasCredits) && (
              <div style={{ marginTop: 4 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  consumo {money(acc.gross)}
                  {hasCredits && ` · crediti ${money(acc.credits)}`}
                </Text>
              </div>
            )}

            {items.length === 0 && !hasCredits ? (
              <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                Nessun costo registrato
              </Text>
            ) : (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((it) => (
                  <Bar key={it.service} label={it.service} amount={it.amount} max={max} />
                ))}
                {hasCredits && <Bar label="Crediti e rimborsi" amount={acc.credits} max={max} credit />}
              </div>
            )}
          </div>
        )
      })}
    </Drawer>
  )
}
