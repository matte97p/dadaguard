import { useEffect, useState } from 'react'
import { Drawer, List, Tag, Alert, Space, Typography, Spin } from 'antd'

const { Text } = Typography

// Costruisce le voci con MOTIVO + livello: 'spreco' (quasi certo) o 'verifica' (costo fisso che
// è spreco solo in certe condizioni). Senza il motivo, un numero da solo non dice niente.
function buildItems(v) {
  const out = []
  if (v.eips?.length) {
    out.push({
      title: `${v.eips.length} Elastic IP non associati · ~$${Math.round(v.eips.length * 3.6)}/mese`,
      level: 'spreco',
      reason:
        'Allocati ma non collegati a nessuna risorsa: AWS li fattura proprio perché inutilizzati. Rilasciali se non servono.',
    })
  }
  if (v.natGateways?.length) {
    out.push({
      title: `${v.natGateways.length} NAT Gateway · ~$${v.natGateways.length * 32}/mese`,
      level: 'verifica',
      reason:
        'Costo fisso, non uno spreco di per sé: serve quando una subnet privata deve uscire su internet. È spreco solo se nella sua VPC non c’è più nulla che lo usa.',
    })
  }
  if (v.volumes?.length) {
    out.push({
      title: `${v.volumes.length} volumi EBS staccati · ${v.volumes.reduce((s, x) => s + x.sizeGb, 0)} GB`,
      level: 'spreco',
      reason:
        'In stato “available”: non attaccati a nessuna istanza, quindi paghi lo storage a vuoto. Fai uno snapshot ed eliminali se non servono.',
    })
  }
  return out
}

export default function WasteDrawer({ open, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    fetch('/api/waste')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error)
        setData(d)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open])

  const entries = data ? Object.entries(data) : []
  const total = entries.reduce((s, [, v]) => s + (v.estMonthlyUsd || 0), 0)

  return (
    <Drawer title="Risorse fisse & sprechi · a listino" open={open} onClose={onClose} width={520}>
      {loading && (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" message={error} showIcon />}

      {data && (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Text type="secondary">
            Stima a <b>listino</b> (prezzo pieno): <Text strong>~${total}/mese</Text>. Non è la bolletta — la
            spesa reale è in “Costi”. Ogni voce dice <b>perché</b> è (o potrebbe essere) uno spreco.
          </Text>

          {entries.map(([key, v]) => {
            const items = v.error ? [] : buildItems(v)
            return (
              <div key={key}>
                <Space>
                  <Tag color={v.color || 'default'}>{v.label}</Tag>
                  {v.error ? (
                    <Text type="danger">{v.error}</Text>
                  ) : (
                    <Text strong>~${v.estMonthlyUsd}/mese</Text>
                  )}
                </Space>
                {!v.error && (
                  <List
                    size="small"
                    bordered
                    style={{ marginTop: 8 }}
                    dataSource={items}
                    locale={{ emptyText: 'nessuno spreco rilevato 🎉' }}
                    renderItem={(i) => (
                      <List.Item>
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <Text>{i.title}</Text>
                            <Tag
                              color={i.level === 'spreco' ? 'error' : 'warning'}
                              style={{ marginInlineEnd: 0, height: 'fit-content' }}
                            >
                              {i.level === 'spreco' ? 'spreco' : 'da verificare'}
                            </Tag>
                          </div>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {i.reason}
                          </Text>
                        </Space>
                      </List.Item>
                    )}
                  />
                )}
              </div>
            )
          })}
        </Space>
      )}
    </Drawer>
  )
}
