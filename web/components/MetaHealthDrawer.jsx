import { Drawer, List, Badge, Typography, Tag, Space } from 'antd'

const { Text, Paragraph } = Typography

// #6 Meta-salute: Dadaguard riesce a raggiungere/assumere ogni account? (sonda STS)
export default function MetaHealthDrawer({ open, onClose, health, t }) {
  const accounts = health?.accounts ?? []
  return (
    <Drawer title={t('health.title')} open={open} onClose={onClose} width={440}>
      <Paragraph type="secondary">{t('health.desc')}</Paragraph>
      <List
        dataSource={accounts}
        locale={{ emptyText: t('health.empty') }}
        renderItem={(a) => (
          <List.Item>
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Space>
                <Badge status={a.ok ? 'success' : 'error'} />
                <Text strong>{a.label}</Text>
                <Tag color={a.ok ? 'success' : 'error'}>{a.ok ? t('health.ok') : t('health.fail')}</Tag>
                {a.via && <Text type="secondary" style={{ fontSize: 12 }}>{a.via}</Text>}
              </Space>
              {a.ok ? (
                <Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  {a.account} · {a.arn}
                </Text>
              ) : (
                <Text type="danger" style={{ fontSize: 12 }}>
                  {a.error}
                </Text>
              )}
            </Space>
          </List.Item>
        )}
      />
    </Drawer>
  )
}
