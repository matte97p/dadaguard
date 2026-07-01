import { useEffect, useState } from 'react'
import { Spin, Alert, Empty, Typography, Tag, Badge, Space } from 'antd'
import { PageIntro } from './pageKit.jsx'

const { Text } = Typography

const CARD = { border: '1px solid rgba(128,128,128,0.18)', borderRadius: 10, padding: 16 }

// Raggruppa le azioni per servizio (prefisso prima dei ':'): "s3:GetObject" → { s3: [GetObject] }.
function actionsByService(actions) {
  const m = new Map()
  for (const a of actions) {
    const [svc, act] = a.includes(':') ? [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)] : ['*', a]
    if (!m.has(svc)) m.set(svc, [])
    m.get(svc).push(act)
  }
  return [...m.entries()]
}

function EntityRow({ label, items, color, empty }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
      <Text type="secondary" style={{ fontSize: 12, width: 62, flexShrink: 0 }}>
        {label}
      </Text>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {items.length ? (
          items.map((n) => (
            <Tag key={n} color={color}>
              {n}
            </Tag>
          ))
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {empty}
          </Text>
        )}
      </div>
    </div>
  )
}

// Pagina IAM: scegli una policy customer-managed → chi la usa (ruoli/utenti/gruppi) e a cosa dà
// accesso (azioni per servizio + risorse). Sola lettura, nessun valore di secret. On-demand.
export default function IamPage({ t = (k) => k }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sel, setSel] = useState(null) // { account, arn }
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch('/api/iam/policies')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!sel) return
    setDetailLoading(true)
    setDetailError(null)
    setDetail(null)
    fetch(`/api/iam/policy?account=${encodeURIComponent(sel.account)}&arn=${encodeURIComponent(sel.arn)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setDetail)
      .catch((e) => setDetailError(e.message))
      .finally(() => setDetailLoading(false))
  }, [sel])

  const accounts = data?.accounts ?? []
  const hasAny = accounts.some((a) => (a.policies ?? []).length || a.error)

  return (
    <>
      <PageIntro title={t('iam.title')} desc={t('iam.desc')} />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin tip={t('iam.loading')} />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {data && !hasAny && !loading && <Empty description={t('iam.none')} style={{ marginTop: 24 }} />}

      {hasAny && (
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          {/* elenco policy per account */}
          <div style={{ width: 320, flexShrink: 0, maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' }}>
            {accounts.map((a) => (
              <div key={a.account} style={{ marginBottom: 12 }}>
                <Space size={6} style={{ marginBottom: 6 }}>
                  {a.color && <Badge color={a.color} />}
                  <Text strong>{a.label}</Text>
                </Space>
                {a.error ? (
                  <Alert type="warning" showIcon message={a.error} />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(a.policies ?? []).map((p) => {
                      const active = sel?.arn === p.arn
                      return (
                        <button
                          key={p.arn}
                          onClick={() => setSel({ account: a.account, arn: p.arn })}
                          style={{
                            textAlign: 'left',
                            cursor: 'pointer',
                            border: `1px solid ${active ? '#7c3aed' : 'rgba(128,128,128,0.2)'}`,
                            background: active ? 'rgba(124,58,237,0.08)' : 'transparent',
                            borderRadius: 8,
                            padding: '6px 10px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 8,
                            color: 'inherit',
                            font: 'inherit',
                          }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                          <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                            {t('iam.attachments', { n: p.attachments })}
                          </Text>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* dettaglio della policy selezionata */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {!sel ? (
              <div style={CARD}>
                <Text type="secondary">{t('iam.pick')}</Text>
              </div>
            ) : detailLoading ? (
              <div style={{ textAlign: 'center', padding: 32 }}>
                <Spin />
              </div>
            ) : detailError ? (
              <Alert type="error" showIcon message={detailError} />
            ) : detail ? (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <div style={CARD}>
                  <Text strong style={{ fontSize: 16 }}>
                    {detail.name}
                  </Text>
                  {detail.description && (
                    <div>
                      <Text type="secondary">{detail.description}</Text>
                    </div>
                  )}
                </div>

                <div style={CARD}>
                  <Text strong>{t('iam.whoHasIt')}</Text>
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <EntityRow label={t('iam.roles')} items={detail.entities.roles} color="purple" empty={t('iam.noneEntity')} />
                    <EntityRow label={t('iam.users')} items={detail.entities.users} color="blue" empty={t('iam.noneEntity')} />
                    <EntityRow label={t('iam.groups')} items={detail.entities.groups} color="cyan" empty={t('iam.noneEntity')} />
                  </div>
                </div>

                <div style={CARD}>
                  <Text strong>{t('iam.grants')}</Text>
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {detail.statements.length === 0 ? (
                      <Text type="secondary">{t('iam.noGrants')}</Text>
                    ) : (
                      detail.statements.map((st, i) => (
                        <div key={i} style={{ borderLeft: '2px solid rgba(124,58,237,0.4)', paddingLeft: 10 }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {actionsByService(st.actions).map(([svc, acts]) => (
                              <Tag key={svc} color="geekblue" style={{ marginInlineEnd: 0 }}>
                                {svc}: {acts.join(', ')}
                              </Tag>
                            ))}
                          </div>
                          <div style={{ marginTop: 4 }}>
                            {st.resources.map((r, j) => (
                              <div key={j}>
                                <Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                                  {r}
                                </Text>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </Space>
            ) : null}
          </div>
        </div>
      )}
    </>
  )
}
