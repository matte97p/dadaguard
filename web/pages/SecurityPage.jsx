import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Spin, Alert, Empty, Typography, Tag, Segmented, Space } from 'antd'
import { PageIntro } from './pageKit.jsx'

const { Text } = Typography

const SEV_COLOR = { high: 'red', medium: 'orange', low: 'gold', info: 'blue' }

// Pagina Sicurezza: findings di sicurezza/governance aggregati (superficie pubblica, scadenze,
// secret stantii, igiene IAM…), filtrabili per categoria e ordinati per severità. Sola lettura.
export default function SecurityPage({ t = (k) => k }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [cat, setCat] = useState('all')
  const navigate = useNavigate()

  // Alcuni finding rimandano alla pagina IAM: una policy troppo larga alla sua vista "per policy",
  // una risorsa esposta / un secret alla vista "per risorsa" (chi ci accede).
  const openLink = (link) => {
    const p = new URLSearchParams({ view: link.view, account: link.account ?? '' })
    if (link.arn) p.set('arn', link.arn)
    if (link.needle) p.set('needle', link.needle)
    navigate(`/iam?${p.toString()}`)
  }

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch('/api/security')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const findings = data?.findings ?? []
  const categories = useMemo(() => [...new Set(findings.map((f) => f.category))], [findings])
  const shown = cat === 'all' ? findings : findings.filter((f) => f.category === cat)
  const options = [{ label: t('sec.all'), value: 'all' }, ...categories.map((c) => ({ label: t(`sec.cat.${c}`), value: c }))]

  return (
    <>
      <PageIntro
        title={t('sec.title')}
        desc={t('sec.desc')}
        extra={categories.length > 1 ? <Segmented options={options} value={cat} onChange={setCat} /> : null}
      />
      {loading && (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin tip={t('sec.loading')} />
        </div>
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {data && findings.length === 0 && <Empty description={t('sec.none')} style={{ marginTop: 24 }} />}

      {shown.length > 0 && (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {shown.map((f, i) => (
            <div
              key={i}
              onClick={f.link ? () => openLink(f.link) : undefined}
              style={{
                border: '1px solid rgba(128,128,128,0.18)',
                borderRadius: 10,
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
                cursor: f.link ? 'pointer' : 'default',
              }}
            >
              <Tag color={SEV_COLOR[f.severity] ?? 'default'} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                {t(`sec.sev.${f.severity}`)}
              </Tag>
              <Tag style={{ marginInlineEnd: 0 }}>{t(`sec.cat.${f.category}`)}</Tag>
              <Text strong>{f.resource}</Text>
              {f.accountLabel && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {f.accountLabel}
                </Text>
              )}
              <Text type="secondary" style={{ fontSize: 13, flex: 1, minWidth: 180 }}>
                · {f.detail}
              </Text>
              {f.link && (
                <Text style={{ fontSize: 12, color: '#7c3aed', flexShrink: 0 }}>{t('sec.openIam')}</Text>
              )}
            </div>
          ))}
        </Space>
      )}
    </>
  )
}
