import { useEffect, useState } from 'react'
import { Alert, Spin, Typography, Space, Button, Divider, Tag } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

const { Text } = Typography

// Pannello "Eventi & modifiche" di un servizio: eventi operativi (ECS/RDS/ASG) + modifiche
// CloudTrail (la "causa": chi/cosa/quando ha cambiato la risorsa). Snapshot on-demand.
//
// È un PANNELLO, non un drawer: vive in una scheda del pannello del servizio. Prima era un secondo
// drawer che copriva il primo — si perdeva di vista il servizio che si stava guardando, e chiudendolo
// riappariva l'altro. Il fetch parte al mount, e la scheda si monta solo quando la apri: resta
// on-demand come prima.
export default function EventsPanel({ service, account, t = (k) => k, lang }) {
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
    // `account` insieme al nome: staging e produzione hanno gli stessi servizi, e senza l'account il
    // server risolve il primo che combacia — cioè gli eventi dell'ambiente sbagliato.
    const acct = account ? `&account=${encodeURIComponent(account)}` : ''
    fetch(`/api/events?service=${encodeURIComponent(service)}${acct}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !stale && setData(d))
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [service, account, reloadKey, lang])

  const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : '')

  const events = data?.events
  const changes = data?.changes

  return (
    <>
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
      ) : data ? (
        <>
          {/* Eventi operativi (ECS/RDS/ASG) */}
          <Divider orientation="left" orientationMargin={0} style={{ marginTop: 0 }}>
            {t('events.opSection')}
          </Divider>
          {data.notApplicable ? (
            <Text type="secondary">{t('events.notApplicable')}</Text>
          ) : data.error ? (
            <Alert type="warning" showIcon message={data.error} />
          ) : !events || events.length === 0 ? (
            <Text type="secondary">{t('events.empty')}</Text>
          ) : (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {events.map((e, i) => (
                <div key={i} style={{ borderBottom: '1px solid var(--dg-line)', paddingBottom: 6 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {fmt(e.ts)}
                  </Text>
                  <div style={{ fontSize: 13 }}>{e.message}</div>
                </div>
              ))}
            </Space>
          )}

          {/* Modifiche CloudTrail (la causa) */}
          <Divider orientation="left" orientationMargin={0}>
            {t('changes.section')}
          </Divider>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            {t('changes.desc')}
          </Text>
          {data.changesError ? (
            <Alert type="warning" showIcon message={data.changesError} />
          ) : !changes || changes.length === 0 ? (
            <Text type="secondary">{t('changes.empty')}</Text>
          ) : (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {changes.map((c, i) => (
                <div key={i} style={{ borderBottom: '1px solid var(--dg-line)', paddingBottom: 6 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {fmt(c.ts)}
                  </Text>
                  <div style={{ fontSize: 13 }}>
                    <Text strong>{c.eventName}</Text>
                    {c.user && <Text type="secondary"> · {c.user}</Text>}
                    {c.errorCode && (
                      <Tag color="error" style={{ marginLeft: 6 }}>
                        {c.errorCode}
                      </Tag>
                    )}
                  </div>
                  {c.source && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {c.source}
                    </Text>
                  )}
                </div>
              ))}
            </Space>
          )}
        </>
      ) : null}
    </>
  )
}
