import { useEffect, useState } from 'react'
import { Spin, Alert, Empty, Typography, Space, Badge, Progress } from 'antd'
import PanelModal, { PANEL_GRID, PANEL_CARD } from './PanelModal.jsx'

const { Text } = Typography

// Service Quotas vicine al limite, per account. On-demand (Service Quotas + CloudWatch).
export default function QuotasDrawer({ open, onClose, accountLabels, t = (k) => k }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    fetch('/api/quotas')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open])

  const accounts = (data?.accounts ?? []).filter((a) => !accountLabels || accountLabels.has(a.label))
  const anyQuota = accounts.some((a) => (a.quotas ?? []).length)

  return (
    <PanelModal open={open} onClose={onClose} title={t('quotas.title')} hint={t('panel.filterHint')}>
      <Text type="secondary">{t('quotas.desc')}</Text>
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

      <div style={{ ...PANEL_GRID, marginTop: 16 }}>
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
                        {Math.round(q.used)} / {q.limit}
                      </Text>
                    </div>
                  ))}
                </Space>
              )}
            </div>
          ),
      )}
      </div>
    </PanelModal>
  )
}
