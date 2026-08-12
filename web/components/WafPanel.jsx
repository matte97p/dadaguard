import { useEffect, useState } from 'react'
import { Typography, Tag, Tooltip, Alert } from 'antd'
import { PANEL_CARD, PANEL_GRID } from '../pages/pageKit.jsx'
import { LEVEL, MONO } from '../theme.js'

const { Text } = Typography

// Riga di una regola, su due livelli: azione + dove si aggiusta + quante richieste ha preso, e sotto
// i percorsi colpiti — che sono la cosa che dice se il blocco è sbagliato (`/api/v1/tenders` non è
// traffico da bot). I percorsi vanno a capo perché sono lunghi: comprimerli in coda alla prima riga
// li troncava proprio nel punto che distingue una rotta dall'altra.
function RuleRow({ r, t }) {
  return (
    <div style={{ padding: '5px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <Tag color={r.blocking ? 'error' : 'default'} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
          {r.action}
        </Tag>
        <Text style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{t(`waf.source.${r.sourceKind}`)}</Text>
        {r.ruleId && (
          <Tooltip title={r.ruleId}>
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
              {r.ruleId.length > 12 ? `${r.ruleId.slice(0, 12)}…` : r.ruleId}
            </Text>
          </Tooltip>
        )}
        <Text strong style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          {r.count.toLocaleString()}
        </Text>
      </div>
      {r.paths?.length > 0 && (
        <Text type="secondary" style={{ display: 'block', fontSize: 12, fontFamily: MONO, wordBreak: 'break-all' }}>
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
    // data-view: ancora per il video demo, vedi pageKit.jsx.
    <div data-view="waf" style={PANEL_CARD}>
      <Text strong style={{ fontSize: 15 }}>
        {z.zone}
      </Text>
      {/* Le due cifre stanno vicine e NON si sommano, ed è il punto: mettere una regola in `log` non
          impedisce a un'altra di bloccare. Il tooltip lo dice per intero. */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'baseline', marginTop: 2 }}>
        <span>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('waf.blocked')}{' '}
          </Text>
          <Text strong style={{ fontSize: 16, color: z.blocked ? LEVEL.bad.color : undefined, fontVariantNumeric: 'tabular-nums' }}>
            {z.blocked.toLocaleString()}
          </Text>
        </span>
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

// Pannello WAF: quanto traffico il firewall ha FERMATO nella finestra, per zona e per regola.
// Sta nella pagina Sicurezza perché è l'unico posto dove un blocco sbagliato si vede: quel traffico
// non raggiunge i servizi, quindi non esiste in nessun log applicativo né in nessuna metrica ECS.
//
// Card nella griglia del resto delle viste per-account, non a piena larghezza: su uno schermo grande
// il nome della zona e il suo conteggio finivano ai due estremi della riga, cioè a un metro l'uno
// dall'altro, e due numeri che vanno letti INSIEME non si possono mettere così lontani.
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
  // Le zone senza dataset (domini parcheggiati su piano Free) NON sono un guasto e non diventano card:
  // erano otto riquadri d'allarme con lo stesso errore Cloudflare per intero, e coprivano le due zone
  // dove il traffico viene davvero fermato. Restano una riga, perché "non lo so" ≠ "non è successo".
  const noDataset = zones.filter((z) => z.noDataset)
  const queryable = zones.filter((z) => !z.noDataset)
  const hit = queryable.filter((z) => z.error || (z.blocked ?? 0) > 0)
  const clean = queryable.length - hit.length

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
        <div style={PANEL_GRID}>
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
      {noDataset.length > 0 && (
        <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
          {t('waf.zonesNoDataset', { n: noDataset.length })}{' '}
          <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO }}>
            {noDataset.map((z) => z.zone).join(' · ')}
          </Text>
        </Text>
      )}
    </div>
  )
}
