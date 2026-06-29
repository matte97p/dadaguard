import { useEffect, useState } from 'react'
import { Drawer, Select, Switch, Button, List, Tag, Alert, Space, Typography, Checkbox, message } from 'antd'

const KIND_COLOR = { lambda: 'purple', ecs: 'blue', asg: 'green' }
const CRON_RE = 'cron|scale|housekeeper'

const { Text } = Typography

export default function DiscoverDrawer({ open, onClose, existingNames = [], onAdded }) {
  const [accounts, setAccounts] = useState([])
  const [account, setAccount] = useState(null)
  const [hideCron, setHideCron] = useState(true)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState([])
  const [adding, setAdding] = useState(false)

  const existing = new Set(existingNames)

  useEffect(() => {
    if (!open) return
    fetch('/api/accounts')
      .then((r) => r.json())
      .then((a) => {
        setAccounts(a)
        setAccount((prev) => prev ?? a[0]?.key ?? null)
      })
      .catch(() => {})
  }, [open])

  const scan = async () => {
    if (!account) return
    setLoading(true)
    setError(null)
    setResult(null)
    setSelected([])
    try {
      const q = new URLSearchParams({ account })
      if (hideCron) q.set('exclude', CRON_RE)
      const r = await fetch(`/api/discover?${q}`)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
      setResult(body)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const add = async () => {
    const toAdd = result.candidates
      .filter((c) => selected.includes(c.name))
      .map((c) => ({ name: c.name, account, aws: c.aws }))
    if (!toAdd.length) return
    setAdding(true)
    try {
      const r = await fetch('/api/watchlist/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: toAdd }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
      message.success(`${body.added} aggiunti alla watchlist`)
      setSelected([])
      onAdded?.()
    } catch (e) {
      message.error(e.message)
    } finally {
      setAdding(false)
    }
  }

  const selectable = (result?.candidates ?? []).filter((c) => !existing.has(c.name)).map((c) => c.name)
  const allSelected = selectable.length > 0 && selected.length === selectable.length

  return (
    <Drawer
      title="Scopri servizi"
      open={open}
      onClose={onClose}
      width={460}
      extra={
        result &&
        selectable.length > 0 && (
          <Button type="primary" loading={adding} disabled={!selected.length} onClick={add}>
            Aggiungi {selected.length || ''}
          </Button>
        )
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Select
          value={account}
          onChange={setAccount}
          style={{ width: '100%' }}
          placeholder="Account"
          options={accounts.map((a) => ({ value: a.key, label: a.label }))}
        />
        <Space>
          <Switch checked={hideCron} onChange={setHideCron} />
          <Text>Nascondi cron / scale / housekeeper</Text>
        </Space>
        <Button onClick={scan} loading={loading} disabled={!account} block>
          Scansiona
        </Button>

        {error && <Alert type="error" message={error} showIcon />}

        {result && (
          <>
            <Space style={{ justifyContent: 'space-between', width: '100%' }}>
              <Text type="secondary">
                {result.candidates.length} risorse
                {result.activeInfo ? ` · attive ${result.activeInfo.kept}/${result.activeInfo.total}` : ''}
                {result.tfState?.stateCount != null ? ` · ${result.tfState.unmanaged} non in TF` : ''}
              </Text>
              {selectable.length > 0 && (
                <Checkbox
                  checked={allSelected}
                  indeterminate={selected.length > 0 && !allSelected}
                  onChange={(e) => setSelected(e.target.checked ? selectable : [])}
                >
                  tutti
                </Checkbox>
              )}
            </Space>

            <List
              size="small"
              bordered
              dataSource={result.candidates}
              locale={{ emptyText: 'Niente trovato' }}
              renderItem={(c) => {
                const already = existing.has(c.name)
                return (
                  <List.Item>
                    <Checkbox
                      disabled={already}
                      checked={selected.includes(c.name)}
                      onChange={(e) =>
                        setSelected((s) => (e.target.checked ? [...s, c.name] : s.filter((n) => n !== c.name)))
                      }
                    >
                      <Space>
                        <Tag color={KIND_COLOR[c.kind]}>{c.kind}</Tag>
                        <Text delete={already} type={already ? 'secondary' : undefined}>
                          {c.name}
                        </Text>
                        {already && <Text type="secondary">(già)</Text>}
                        {c.managed === false && <Tag color="error">⚠ non in TF</Tag>}
                      </Space>
                    </Checkbox>
                  </List.Item>
                )
              }}
            />
          </>
        )}
      </Space>
    </Drawer>
  )
}
