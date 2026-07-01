import { useEffect, useState } from 'react'
import { List, Tag, Alert, Space, Typography, Spin } from 'antd'
import PanelModal, { PANEL_GRID, PANEL_CARD } from './PanelModal.jsx'

const { Text } = Typography

// Costruisce le voci con MOTIVO + livello: 'spreco' (quasi certo) o 'verifica' (costo fisso che
// è spreco solo in certe condizioni). Senza il motivo, un numero da solo non dice niente.
function buildItems(v, t) {
  const out = []
  if (v.eips?.length) {
    out.push({
      title: t('waste.eip.title', { n: v.eips.length, cost: Math.round(v.eips.length * 3.6) }),
      level: 'spreco',
      reason: t('waste.eip.reason'),
    })
  }
  if (v.natGateways?.length) {
    out.push({
      title: t('waste.nat.title', { n: v.natGateways.length, cost: v.natGateways.length * 32 }),
      level: 'verifica',
      reason: t('waste.nat.reason'),
    })
  }
  if (v.volumes?.length) {
    out.push({
      title: t('waste.ebs.title', { n: v.volumes.length, gb: v.volumes.reduce((s, x) => s + x.sizeGb, 0) }),
      level: 'spreco',
      reason: t('waste.ebs.reason'),
    })
  }
  return out
}

export default function WasteDrawer({ open, onClose, accountLabels, t = (k) => k }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    fetch('/api/waste')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (d.error) throw new Error(d.error)
        setData(d)
      })
      .catch((e) => setError(e.message)) // errore HTTP/parse → Alert visibile, mai muto
      .finally(() => setLoading(false))
  }, [open])

  const entries = (data ? Object.entries(data) : []).filter(
    ([, v]) => !accountLabels || accountLabels.has(v.label),
  )
  const total = entries.reduce((s, [, v]) => s + (v.estMonthlyUsd || 0), 0)

  return (
    <PanelModal open={open} onClose={onClose} title={t('waste.title')} hint={t('panel.filterHint')}>
      {loading && (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" message={error} showIcon />}

      {data && (
        <>
          <Text type="secondary">{t('waste.desc', { total })}</Text>

          <div style={{ ...PANEL_GRID, marginTop: 16 }}>
          {entries.map(([key, v]) => {
            const items = v.error ? [] : buildItems(v, t)
            return (
              <div key={key} style={PANEL_CARD}>
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
                    locale={{ emptyText: t('waste.empty') }}
                    renderItem={(i) => (
                      <List.Item>
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <Text>{i.title}</Text>
                            <Tag
                              color={i.level === 'spreco' ? 'error' : 'warning'}
                              style={{ marginInlineEnd: 0, height: 'fit-content' }}
                            >
                              {i.level === 'spreco' ? t('waste.level.waste') : t('waste.level.check')}
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
          </div>
        </>
      )}
    </PanelModal>
  )
}
