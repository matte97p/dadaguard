import { Drawer, Empty, Typography, Badge, Tag, Space } from 'antd'

const { Text } = Typography

// Mappa stato → colore del Badge antd (coerente con ServiceCard).
const STATUS = {
  up: 'success',
  degraded: 'warning',
  down: 'error',
  idle: 'default',
  disabled: 'default',
  unknown: 'default',
}

// Etichette leggibili per i tipi di risorsa monitorati.
const TYPE_LABEL = {
  lambda: 'Lambda',
  rds: 'Database (RDS/Aurora)',
  ecs: 'ECS',
  asg: 'Auto Scaling',
  alb: 'Load Balancer',
  ec2: 'EC2',
  altro: 'Altro',
}

// Topologia dei servizi monitorati: account → tipo di risorsa → servizi (col semaforo).
// Niente backend nuovo: si disegna dai dati già presenti in /api/status.
export default function TopologyDrawer({ open, onClose, services = [] }) {
  const byAccount = new Map()
  for (const s of services) {
    const ak = s.account?.key ?? '__none__'
    if (!byAccount.has(ak)) {
      byAccount.set(ak, {
        label: s.account?.label ?? 'Senza account',
        color: s.account?.color,
        types: new Map(),
      })
    }
    const acc = byAccount.get(ak)
    const t = s.type ?? 'altro'
    if (!acc.types.has(t)) acc.types.set(t, [])
    acc.types.get(t).push(s)
  }
  const accounts = [...byAccount.values()]

  return (
    <Drawer
      title="Topologia · servizi per ambiente e tipo"
      placement="right"
      width={680}
      open={open}
      onClose={onClose}
    >
      {accounts.length === 0 && <Empty description="Nessun servizio monitorato" />}
      {accounts.map((acc, i) => (
        <div
          key={i}
          style={{ marginBottom: 24, paddingLeft: 12, borderLeft: `4px solid ${acc.color ?? '#888'}` }}
        >
          <Text strong style={{ fontSize: 15 }}>
            {acc.label}
          </Text>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[...acc.types.entries()].map(([type, svcs]) => (
              <div key={type}>
                <Tag color="purple" style={{ marginBottom: 8 }}>
                  {TYPE_LABEL[type] ?? type}
                </Tag>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingLeft: 4 }}>
                  {svcs.map((s) => (
                    <span
                      key={s.name}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        border: '1px solid rgba(128,128,128,0.25)',
                        borderRadius: 6,
                        padding: '4px 10px',
                      }}
                    >
                      <Badge status={STATUS[s.overall] ?? 'default'} />
                      <Text style={{ fontSize: 13 }}>{s.name}</Text>
                      {s.region && (
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {s.region}
                        </Text>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Drawer>
  )
}
