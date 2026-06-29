import { Space, Badge, Typography } from 'antd'

const { Text } = Typography

// Conteggio globale per stato — il colpo d'occhio in cima alla dashboard.
const DEFS = [
  { key: 'down', status: 'error', label: 'down' },
  { key: 'degraded', status: 'warning', label: 'degraded' },
  { key: 'idle', status: 'default', label: 'idle' },
  { key: 'disabled', status: 'default', label: 'disabled' },
  { key: 'unknown', status: 'default', label: '?' },
  { key: 'up', status: 'success', label: 'up' },
]

export default function StatusSummary({ services = [] }) {
  const counts = {}
  for (const s of services) counts[s.overall] = (counts[s.overall] || 0) + 1

  return (
    <Space size="large" wrap>
      {DEFS.filter((d) => counts[d.key]).map((d) => (
        <Space key={d.key} size={4}>
          <Badge status={d.status} />
          <Text strong>{counts[d.key]}</Text>
          <Text type="secondary">{d.label}</Text>
        </Space>
      ))}
      <Text type="secondary">· {services.length} servizi</Text>
    </Space>
  )
}
