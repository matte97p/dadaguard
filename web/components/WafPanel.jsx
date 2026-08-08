import { useEffect, useState } from 'react'
import { Typography, Tag, Space, Tooltip, Alert } from 'antd'
import { PANEL_CARD } from '../pages/pageKit.jsx'

const { Text } = Typography
const MONO = 'ui-monospace, SFMono-Regular, monospace'

// Riga di una regola: azione + dove si aggiusta + quante richieste ha preso, e — se la query
// dettagliata è passata — i percorsi colpiti, che sono la cosa che dice se il blocco è sbagliato
// (`/api/v1/tenders` non è traffico da bot).
function RuleRow({ r, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '5px 0' }}>
      <Tag color={r.blocking ? 'error' : 'default'} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
        {r.action}
      </Tag>
      <Text style={{ fontSize: 13 }}>{t(`waf.source.${r.sourceKind}`)}</Text>
      {r.ruleId && (
        <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
          {r.ruleId}
        </Text>
      )}
      <Text strong style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
        {r.count.toLocaleString()}
      </Text>
      {r.paths?.length > 0 && (
        <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.paths.join(' · ')}
        </Text>
      )}
    </div>
  )
}

function ZoneCard({ z, t }) {
  if (z.error) {
    return (
      <div style={PANEL_CARD}>
        <Text strong>{z.zone}</Text>
        <Alert type="warning" showIcon style={{ marginTop: 8 }} message={z.error} />
      </div>
    )
  }
  return (
    <div style={PANEL_CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <Text strong style={{ fontSize: 15 }}>
          {z.zone}
        </Text>
        <Space size={18}>
          <span>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('waf.blocked')}{' '}
            </Text>
            <Text strong style={{ fontSize: 16, color: z.blocked ? '#ff4d4f' : undefined, fontVariantNumeric: 'tabular-nums' }}>
              {z.blocked.toLocaleString()}
            </Text>
          </span>
          {/* Le due cifre NON si sommano, ed è il punto: mettere una regola in `log` non impedisce a
              un'altra di bloccare. Il tooltip lo dice per intero. */}
          <Tooltip title={t('waf.loggedHint')}>
            <span>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {t('waf.logged')}{' '}
              </Text>
              <Text type="secondary" style={{ fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>
                {z.logged.toLocaleString()}
              </Text>
            </span>
          </Tooltip>
        </Space>
      </div>
      {z.rules?.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {z.rules.map((r, i) => (
            <RuleRow key={`${r.ruleId}:${r.action}:${i}`} r={r} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

// Pannello WAF: quanto traffico il firewall ha FERMATO nelle ultime 24h, per zona e per regola.
// Sta nella pagina Sicurezza perché è l'unico posto dove un blocco sbagliato si vede: quel traffico
// non raggiunge i servizi, quindi non esiste in nessun log applicativo né in nessuna metrica ECS.
export default function WafPanel({ t = (k) => k }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  // `alive`: le schede di «Spesa»/«Sicurezza» distruggono il pane inattivo, quindi questo pannello
  // può smontarsi mentre la richiesta è in volo — e allora la risposta non deve toccare più niente.
  useEffect(() => {
    let alive = true
    fetch('/api/waf')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => alive && setData(j))
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [])

  // Integrazione spenta (nessun token Cloudflare): nessuna sezione, nessun rumore.
  if (!data || data.disabled) return error ? <Alert type="warning" showIcon message={error} style={{ marginBottom: 16 }} /> : null

  const zones = data.zones ?? []
  const hit = zones.filter((z) => z.error || (z.blocked ?? 0) > 0)
  const clean = zones.length - hit.length

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ marginBottom: 8 }}>
        <Text strong style={{ fontSize: 14 }}>
          {t('waf.title', { h: data.hours })}
        </Text>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          {t('waf.desc')}
        </Text>
      </div>
      {data.error && <Alert type="warning" showIcon message={data.error} />}
      {hit.length === 0 && !data.error && <Text type="secondary">{t('waf.noBlocks')}</Text>}
      {hit.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {hit.map((z) => (
            <ZoneCard key={z.zoneId ?? z.zone} z={z} t={t} />
          ))}
        </div>
      )}
      {clean > 0 && hit.length > 0 && (
        <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          {t('waf.zonesClean', { n: clean })}
        </Text>
      )}
    </div>
  )
}
