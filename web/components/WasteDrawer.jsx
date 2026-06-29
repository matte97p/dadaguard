import { useEffect, useState } from 'react'
import { Drawer, List, Tag, Alert, Space, Typography, Spin } from 'antd'

const { Text } = Typography

// #10 — Sprechi / costi fissi per ambiente (read-only EC2). On-demand.
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
    <Drawer title="Sprechi & costi fissi" open={open} onClose={onClose} width={460}>
      {loading && (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" message={error} showIcon />}

      {data && (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <Text type="secondary">
            Stima totale: <Text strong>~${total}/mese</Text> · approssimata, region eu-central-1
          </Text>

          {entries.map(([key, v]) => {
            const items = v.error
              ? []
              : [
                  v.eips?.length
                    ? `${v.eips.length} EIP non associati  ·  ~$${Math.round(v.eips.length * 3.6)}/mese`
                    : null,
                  v.natGateways?.length
                    ? `${v.natGateways.length} NAT Gateway  ·  ~$${v.natGateways.length * 32}/mese`
                    : null,
                  v.volumes?.length
                    ? `${v.volumes.length} volumi EBS staccati  ·  ${v.volumes.reduce((s, x) => s + x.sizeGb, 0)} GB`
                    : null,
                ].filter(Boolean)

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
                    renderItem={(i) => <List.Item>{i}</List.Item>}
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
