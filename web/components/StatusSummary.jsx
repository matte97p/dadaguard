import { Typography } from 'antd'

const { Text } = Typography

// Banda overview: totale servizi prominente + conteggio per stato, colorato (problemi in evidenza).
// Ordine: prima i problemi (down/degraded), poi il resto — così l'occhio va subito lì.
const ORDER = ['down', 'degraded', 'unknown', 'idle', 'disabled', 'up']
const TONE = {
  down: '#ff4d4f',
  degraded: '#faad14',
  unknown: '#8c8c8c',
  idle: '#8c8c8c',
  disabled: '#8c8c8c',
  up: '#52c41a',
}

export default function StatusSummary({ services = [], t = (k) => k }) {
  const counts = {}
  for (const s of services) counts[s.overall] = (counts[s.overall] || 0) + 1
  const total = services.length
  const shown = ORDER.filter((k) => counts[k])
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 18px' }}>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{total}</span>
        <Text type="secondary">{t('summary.services')}</Text>
      </span>
      {shown.map((k) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: TONE[k], lineHeight: 1 }}>{counts[k]}</span>
          <Text type="secondary">{t(`status.${k}`)}</Text>
        </span>
      ))}
    </div>
  )
}
