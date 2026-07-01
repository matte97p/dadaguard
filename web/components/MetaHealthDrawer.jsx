import { Drawer, Badge, Typography, Tag, Space, Empty } from 'antd'

const { Text, Paragraph } = Typography

const CARD = { border: '1px solid rgba(128,128,128,0.18)', borderRadius: 10, padding: 12 }

// #6 Meta-salute: Dadaguard riesce a raggiungere/assumere ogni account? (sonda STS).
// Diagnostica occasionale → drawer laterale (popup), non una pagina.
export default function MetaHealthDrawer({ open, onClose, health, accountLabels, t }) {
  const accounts = (health?.accounts ?? []).filter((a) => !accountLabels || accountLabels.has(a.label))
  return (
    <Drawer title={t('health.title')} open={open} onClose={onClose} width={460}>
      <Paragraph type="secondary">{t('health.desc')}</Paragraph>
      {accounts.length === 0 ? (
        <Empty description={t('health.empty')} style={{ marginTop: 24 }} />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {accounts.map((a) => (
            <div key={a.account} style={CARD}>
              <Space wrap>
                <Badge status={a.ok ? 'success' : 'error'} />
                <Text strong>{a.label}</Text>
                <Tag color={a.ok ? 'success' : 'error'}>{a.ok ? t('health.ok') : t('health.fail')}</Tag>
                {a.via && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {a.via}
                  </Text>
                )}
              </Space>
              <div style={{ marginTop: 4 }}>
                {a.ok ? (
                  <Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                    {a.account} · {a.arn}
                  </Text>
                ) : (
                  <Text type="danger" style={{ fontSize: 12 }}>
                    {a.error}
                  </Text>
                )}
              </div>
            </div>
          ))}
        </Space>
      )}
    </Drawer>
  )
}
