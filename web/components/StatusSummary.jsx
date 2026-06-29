import { Space, Badge, Typography } from 'antd'

const { Text } = Typography

// Conteggio globale per stato — il colpo d'occhio in cima alla dashboard.
const DEFS = [
  { key: 'down', status: 'error' },
  { key: 'degraded', status: 'warning' },
  { key: 'idle', status: 'default' },
  { key: 'disabled', status: 'default' },
  { key: 'unknown', status: 'default' },
  { key: 'up', status: 'success' },
]

export default function StatusSummary({ services = [], t = (k) => k }) {
  const counts = {}
  for (const s of services) counts[s.overall] = (counts[s.overall] || 0) + 1

  return (
    <Space size="large" wrap>
      {DEFS.filter((d) => counts[d.key]).map((d) => (
        <Space key={d.key} size={4}>
          <Badge status={d.status} />
          <Text strong>{counts[d.key]}</Text>
          <Text type="secondary">{t(`status.${d.key}`)}</Text>
        </Space>
      ))}
      <Text type="secondary">
        · {services.length} {t('content.servicesCount')}
      </Text>
    </Space>
  )
}
