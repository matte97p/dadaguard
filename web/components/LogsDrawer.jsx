import { useEffect, useState } from 'react'
import { Drawer, Switch, Alert, Empty, Spin, Typography, Space, Button } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

const { Text } = Typography

// Pannello "Log recenti" di un servizio: snapshot on-demand (ultima finestra), niente tail live.
// Read-only/zero storage. service = nome (apre quando truthy).
export default function LogsDrawer({ service, onClose, t = (k) => k }) {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0) // bump dal bottone Aggiorna → refetch

  useEffect(() => {
    if (!service) {
      setData(null)
      return
    }
    let stale = false
    setLoading(true)
    setError(null)
    fetch(`/api/logs?service=${encodeURIComponent(service)}&errorsOnly=${errorsOnly}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !stale && setData(d))
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [service, errorsOnly, reloadKey])

  const fmtTs = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '')

  return (
    <Drawer
      title={`${t('logs.title')}${service ? ` · ${service}` : ''}`}
      placement="right"
      width={760}
      open={Boolean(service)}
      onClose={onClose}
    >
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
        <Space size={6}>
          <Switch checked={errorsOnly} onChange={setErrorsOnly} />
          <Text>{t('logs.errorsOnly')}</Text>
        </Space>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => setReloadKey((k) => k + 1)}>
          {t('logs.refresh')}
        </Button>
      </Space>

      <Alert type="info" showIcon style={{ marginBottom: 8 }} message={t('logs.warning')} />
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}

      {loading ? (
        <div style={{ textAlign: 'center', paddingTop: 80 }}>
          <Spin tip={t('logs.loading')} />
        </div>
      ) : data?.notApplicable ? (
        <Empty style={{ paddingTop: 60 }} description={t('logs.notApplicable')} />
      ) : data?.error ? (
        <Alert type="warning" showIcon message={data.error} />
      ) : data ? (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('logs.group')}: {data.logGroup}
          </Text>
          {!data.events || data.events.length === 0 ? (
            <Empty style={{ paddingTop: 60 }} description={t('logs.empty')} />
          ) : (
            <pre
              style={{
                marginTop: 8,
                maxHeight: '64vh',
                overflow: 'auto',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                background: 'rgba(127,127,127,0.08)',
                padding: 10,
                borderRadius: 6,
              }}
            >
              {data.events.map((e) => `${fmtTs(e.ts)}  ${e.message}`).join('\n')}
            </pre>
          )}
        </>
      ) : null}
    </Drawer>
  )
}
