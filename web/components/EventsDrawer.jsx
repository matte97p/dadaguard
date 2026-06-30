import { useEffect, useState } from 'react'
import { Drawer, Alert, Empty, Spin, Typography, Space, Button } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

const { Text } = Typography

// Pannello "Eventi recenti" di un servizio (ECS/RDS/ASG): snapshot on-demand. service = nome.
export default function EventsDrawer({ service, onClose, t = (k) => k }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!service) {
      setData(null)
      return
    }
    let stale = false
    setLoading(true)
    setError(null)
    fetch(`/api/events?service=${encodeURIComponent(service)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !stale && setData(d))
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [service, reloadKey])

  const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : '')

  return (
    <Drawer
      title={`${t('events.title')}${service ? ` · ${service}` : ''}`}
      placement="right"
      width={680}
      open={Boolean(service)}
      onClose={onClose}
    >
      <Space style={{ width: '100%', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => setReloadKey((k) => k + 1)}>
          {t('events.refresh')}
        </Button>
      </Space>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
      {loading ? (
        <div style={{ textAlign: 'center', paddingTop: 80 }}>
          <Spin tip={t('events.loading')} />
        </div>
      ) : data?.notApplicable ? (
        <Empty style={{ paddingTop: 60 }} description={t('events.notApplicable')} />
      ) : data?.error ? (
        <Alert type="warning" showIcon message={data.error} />
      ) : data ? (
        !data.events || data.events.length === 0 ? (
          <Empty style={{ paddingTop: 60 }} description={t('events.empty')} />
        ) : (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {data.events.map((e, i) => (
              <div key={i} style={{ borderBottom: '1px solid rgba(127,127,127,0.12)', paddingBottom: 6 }}>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {fmt(e.ts)}
                </Text>
                <div style={{ fontSize: 13 }}>{e.message}</div>
              </div>
            ))}
          </Space>
        )
      ) : null}
    </Drawer>
  )
}
