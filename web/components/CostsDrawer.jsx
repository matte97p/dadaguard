import { useEffect, useState } from 'react'
import { Drawer, Spin, Alert, Empty, Typography, Divider, Space, Badge, Tag } from 'antd'

const { Text } = Typography

// Costi MTD per servizio AWS, per account — spesa REALE (netta di crediti). Barre
// proporzionali: viola = costo, verde = credito/rimborso. Fetch on-demand (CE è a pagamento).
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
  const fmt = (v, unit) =>
    `${v < 0 ? '−' : ''}${unit === 'USD' ? '$' : ''}${Math.abs(Number(v)).toFixed(2)}${unit && unit !== 'USD' ? ` ${unit}` : ''}`

  return (
    <Drawer title="Costi · mese corrente" placement="right" width={560} open={open} onClose={onClose}>
      <Text type="secondary">
        Spesa <b>reale</b> MTD per servizio AWS, netta di crediti/rimborsi (in verde). Dati ~24h di
        ritardo; lettura on-demand (Cost Explorer è a pagamento). Diverso da “Sprechi”, che stima il
        costo a listino delle risorse fisse.
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
        const items = acc.items ?? []
        const max = Math.max(1, ...items.map((i) => Math.abs(i.amount)))
        return (
          <div key={key} style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Space>
                {acc.color && <Badge color={acc.color} />}
                <Text strong>{acc.label}</Text>
              </Space>
              {!acc.error && (
                <Text strong style={{ fontSize: 18 }}>
                  {fmt(acc.total ?? 0, acc.currency)}
                </Text>
              )}
            </div>

            {acc.error ? (
              <Alert type="warning" showIcon style={{ marginTop: 8 }} message={acc.error} />
            ) : items.length === 0 ? (
              <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                Nessun costo registrato
              </Text>
            ) : (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((it) => {
                  const credit = it.amount < 0
                  return (
                    <div key={it.service}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: 12,
                          marginBottom: 2,
                        }}
                      >
                        <Space size={4}>
                          <Text style={{ fontSize: 12 }}>{it.service}</Text>
                          {credit && (
                            <Tag
                              color="success"
                              style={{ fontSize: 10, lineHeight: '15px', marginInlineEnd: 0, paddingInline: 4 }}
                            >
                              credito
                            </Tag>
                          )}
                        </Space>
                        <Text style={{ fontSize: 12, color: credit ? '#52c41a' : undefined }}>
                          {fmt(it.amount, it.unit)}
                        </Text>
                      </div>
                      <div style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,0.15)' }}>
                        <div
                          style={{
                            height: '100%',
                            borderRadius: 4,
                            width: `${(Math.abs(it.amount) / max) * 100}%`,
                            background: credit ? '#52c41a' : '#7c3aed',
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </Drawer>
  )
}
