import { useEffect, useState } from 'react'
import { Alert, Typography, Space, Badge, Progress } from 'antd'
import { PageIntro, PANEL_GRID, PANEL_CARD, HeroStat, HeroRow, EmptyState, Verdetto } from './pageKit.jsx'
import Loading from '../components/Loading.jsx'

const { Text } = Typography

// Pagina Quote: Service Quotas vicine al limite, per account. On-demand (Service Quotas + CloudWatch).
export default function QuotasPage({ accountLabels, t = (k) => k, lang, embedded = false }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/quotas?lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [lang])

  const accounts = (data?.accounts ?? []).filter((a) => !accountLabels || accountLabels.has(a.label))
  const anyQuota = accounts.some((a) => (a.quotas ?? []).length)

  return (
    <>
      <PageIntro title={embedded ? null : t('quotas.title')} desc={t('quotas.desc')} />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Loading text={t('quotas.loading')} />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
      {data && accounts.length === 0 && <EmptyState description={t('quotas.noAccounts')} />}
      {data && accounts.length > 0 && !anyQuota && !loading && (
        <Verdetto livello="ok" titolo={t('quotas.v.okTitolo')} dettaglio={t('quotas.none')} />
      )}

      {/* Il verdetto della pagina: «ci sono quote da guardare?». I numeri stavano gia' qui, mancava
          la frase che li interpreta, e un 3 accanto a «critiche» non dice da solo se e' un problema. */}
      {anyQuota &&
        (() => {
          const all = accounts.flatMap((a) => a.quotas ?? [])
          const crit = all.filter((q) => q.pct >= 90).length
          return (
            <Verdetto
              livello={crit ? 'crit' : 'warn'}
              titolo={crit ? t('quotas.v.critTitolo', { n: crit }) : t('quotas.v.vicineTitolo', { n: all.length })}
              dettaglio={crit ? t('quotas.v.crit') : t('quotas.v.vicine')}
              numeri={[
                { label: t('quotas.h.near'), value: all.length },
                { label: t('quotas.h.crit'), value: crit, color: crit ? '#ff4d4f' : undefined },
              ]}
            />
          )
        })()}

      <div style={PANEL_GRID}>
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
                          {Math.round(q.used).toLocaleString()} / {Number(q.limit).toLocaleString()}
                        </Text>
                      </div>
                    ))}
                  </Space>
                )}
              </div>
            ),
        )}
      </div>
    </>
  )
}
