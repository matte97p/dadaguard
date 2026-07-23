import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Input, List, Badge, Typography } from 'antd'
import { displayName } from '../serviceName.js'

const { Text } = Typography

const STATUS = { down: 'error', degraded: 'warning', up: 'success', idle: 'default', disabled: 'default', unknown: 'default' }

// Palette di ricerca globale (⌘K / Ctrl+K): filtra i servizi per nome/account e ci salta.
// ↑/↓ per muoversi, Invio per scegliere il primo/selezionato, Esc per chiudere.
export default function CommandPalette({ open, onClose, services = [], onPick, t = (k) => k }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = s
      ? services.filter(
          (x) =>
            x.name.toLowerCase().includes(s) ||
            displayName(x).toLowerCase().includes(s) ||
            String(x.account?.label ?? '').toLowerCase().includes(s),
        )
      : services
    return list.slice(0, 40)
  }, [q, services])

  const choose = (item) => {
    if (!item) return
    onPick?.(item)
    onClose?.()
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[idx])
    }
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} title={null} closable={false} width={560} styles={{ body: { padding: 0 } }} destroyOnClose>
      <Input
        ref={inputRef}
        size="large"
        variant="borderless"
        placeholder={t('palette.placeholder')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setIdx(0)
        }}
        onKeyDown={onKeyDown}
        style={{ padding: '12px 16px', borderBottom: '1px solid rgba(128,128,128,0.18)' }}
      />
      <List
        size="small"
        style={{ maxHeight: 360, overflowY: 'auto' }}
        dataSource={results}
        locale={{ emptyText: t('palette.empty') }}
        renderItem={(item, i) => (
          <List.Item
            onMouseEnter={() => setIdx(i)}
            onClick={() => choose(item)}
            style={{ cursor: 'pointer', padding: '8px 16px', background: i === idx ? 'rgba(128,128,128,0.12)' : undefined }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
              <Badge status={STATUS[item.overall] ?? 'default'} />
              <span style={{ fontWeight: 500 }}>{displayName(item)}</span>
              {item.account?.label && (
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  {item.account.label}
                </Text>
              )}
            </div>
          </List.Item>
        )}
      />
    </Modal>
  )
}
