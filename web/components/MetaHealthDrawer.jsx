import { Badge, Typography, Tag, Space, Empty } from 'antd'
import PanelModal, { PANEL_GRID, PANEL_CARD } from './PanelModal.jsx'

const { Text, Paragraph } = Typography

// #6 Meta-salute: Dadaguard riesce a raggiungere/assumere ogni account? (sonda STS)
export default function MetaHealthDrawer({ open, onClose, health, accountLabels, t }) {
  const accounts = (health?.accounts ?? []).filter((a) => !accountLabels || accountLabels.has(a.label))
  return (
    <PanelModal open={open} onClose={onClose} title={t('health.title')} hint={t('panel.filterHint')}>
      <Paragraph type="secondary">{t('health.desc')}</Paragraph>
      {accounts.length === 0 ? (
        <Empty description={t('health.empty')} style={{ marginTop: 24 }} />
      ) : (
        <div style={{ ...PANEL_GRID, marginTop: 8 }}>
          {accounts.map((a) => (
            <div key={a.account} style={PANEL_CARD}>
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
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
            </div>
          ))}
        </div>
      )}
    </PanelModal>
  )
}
