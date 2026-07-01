import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Spin, Alert, Empty, Typography, Tag, Badge, Space, Segmented, Select } from 'antd'
import { PageIntro, PANEL_GRID } from './pageKit.jsx'

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

function ActionTags({ actions }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {actionsByService(actions).map(([svc, acts]) => (
        <Tag key={svc} color="geekblue" style={{ marginInlineEnd: 0 }}>
          {svc}: {acts.join(', ')}
        </Tag>
      ))}
    </div>
  )
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

function Entities({ entities, t }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <EntityRow label={t('iam.roles')} items={entities.roles} color="purple" empty={t('iam.noneEntity')} />
      <EntityRow label={t('iam.users')} items={entities.users} color="blue" empty={t('iam.noneEntity')} />
      <EntityRow label={t('iam.groups')} items={entities.groups} color="cyan" empty={t('iam.noneEntity')} />
    </div>
  )
}

// --- Vista "Per policy": elenco policy per account + dettaglio (chi la usa / a cosa dà accesso). ---
function PolicyView({ t, initialSel }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sel, setSel] = useState(initialSel ?? null)
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

  if (loading)
    return (
      <div style={{ textAlign: 'center', padding: 32 }}>
        <Spin tip={t('iam.loading')} />
      </div>
    )
  if (error) return <Alert type="error" showIcon message={error} />
  if (data && !hasAny) return <Empty description={t('iam.none')} style={{ marginTop: 24 }} />

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
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
              <div style={{ marginTop: 8 }}>
                <Entities entities={detail.entities} t={t} />
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
                      <ActionTags actions={st.actions} />
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
  )
}

// --- Vista "Per risorsa": scegli un servizio → quali policy lo toccano, chi le usa, con quali azioni. ---
function ResourceView({ services, t, initialResource }) {
  const [resource, setResource] = useState(initialResource ?? null) // `${accountKey}|${name}`
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const options = useMemo(() => {
    const base = services.map((s) => ({
      value: `${s.account?.key ?? '__none__'}|${s.name}`,
      label: `${s.name}${s.type ? ` · ${s.type}` : ''}`,
    }))
    // se arriviamo da un link su una risorsa che non è un servizio monitorato (es. un secret),
    // aggiungiamo comunque l'opzione così il Select mostra la selezione.
    if (resource && !base.some((o) => o.value === resource))
      base.unshift({ value: resource, label: resource.slice(resource.indexOf('|') + 1) })
    return base
  }, [services, resource])

  useEffect(() => {
    if (!resource) return
    const sep = resource.indexOf('|')
    const account = resource.slice(0, sep)
    const needle = resource.slice(sep + 1)
    setLoading(true)
    setError(null)
    setData(null)
    fetch(`/api/iam/access?account=${encodeURIComponent(account)}&needle=${encodeURIComponent(needle)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [resource])

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Select
        showSearch
        allowClear
        placeholder={t('iam.pickResource')}
        options={options}
        value={resource}
        onChange={setResource}
        style={{ minWidth: 320, maxWidth: 480 }}
        optionFilterProp="label"
      />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {data && data.matches.length === 0 && <Empty description={t('iam.noAccess')} style={{ marginTop: 8 }} />}
      {data &&
        data.matches.map((m) => (
          <div key={m.arn} style={CARD}>
            <Text strong>{m.policy}</Text>
            <div style={{ marginTop: 8 }}>
              <Entities entities={m.entities} t={t} />
            </div>
            <div style={{ marginTop: 10 }}>
              <ActionTags actions={m.actions} />
            </div>
          </div>
        ))}
    </Space>
  )
}

// --- Vista "Accesso SSO": Identity Center → permission set → utenti/gruppi assegnati, per account.
// È il modo reale in cui gli umani hanno accesso (non IAM user/group). ---
function SsoView({ t }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch('/api/iam/sso')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading)
    return (
      <div style={{ textAlign: 'center', padding: 32 }}>
        <Spin tip={t('iam.ssoLoading')} />
      </div>
    )
  if (error) return <Alert type="error" showIcon message={error} />
  if (data && !data.available) return <Empty description={t('iam.ssoNone')} style={{ marginTop: 24 }} />
  const ps = data?.permissionSets ?? []
  if (data && ps.length === 0) return <Empty description={t('iam.ssoEmpty')} style={{ marginTop: 24 }} />

  return (
    <>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        {t('iam.ssoDesc')}
      </Text>
      <div style={PANEL_GRID}>
        {ps.map((p) => (
          <div key={p.name} style={CARD}>
            <Text strong>{p.name}</Text>
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {p.assignments.map((a, i) => (
                <Tag key={i} color={a.type === 'group' ? 'purple' : 'blue'} style={{ marginInlineEnd: 0 }}>
                  {a.name} <span style={{ opacity: 0.6 }}>· {a.account}</span>
                </Tag>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// Pagina IAM: tre lenti. "Per policy" = da una policy a chi la usa e cosa concede. "Per risorsa" =
// da una risorsa (servizio) a chi ci accede. "Accesso SSO" = come gli umani hanno accesso davvero
// (Identity Center). Sola lettura, nessun valore di secret. On-demand.
export default function IamPage({ services = [], t = (k) => k }) {
  const [params] = useSearchParams()
  const paramView = params.get('view')
  const [view, setView] = useState(['policy', 'resource'].includes(paramView) ? paramView : 'sso')
  // preselezione quando si arriva da un link della pagina Sicurezza
  const initialSel = paramView === 'policy' && params.get('arn') ? { account: params.get('account'), arn: params.get('arn') } : null
  const initialResource =
    paramView === 'resource' && params.get('needle') ? `${params.get('account')}|${params.get('needle')}` : null
  return (
    <>
      <PageIntro
        title={t('iam.title')}
        desc={t('iam.desc')}
        extra={
          <Segmented
            options={[
              { label: t('iam.bySso'), value: 'sso' },
              { label: t('iam.byPolicy'), value: 'policy' },
              { label: t('iam.byResource'), value: 'resource' },
            ]}
            value={view}
            onChange={setView}
          />
        }
      />
      {view === 'policy' ? (
        <PolicyView t={t} initialSel={initialSel} />
      ) : view === 'resource' ? (
        <ResourceView services={services} t={t} initialResource={initialResource} />
      ) : (
        <SsoView t={t} />
      )}
    </>
  )
}
