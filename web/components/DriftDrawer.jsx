import { useEffect, useRef, useState } from 'react'
import { Drawer, Select, Button, Alert, Space, Typography } from 'antd'

const { Text } = Typography

// #6 drift COMPLETO: lancia `terragrunt plan` per un layer (job async, polling).
// Esegue comandi → salto consapevole a "servizio".
export default function DriftDrawer({ open, onClose }) {
  const [accounts, setAccounts] = useState([])
  const [account, setAccount] = useState(null)
  const [layers, setLayers] = useState([])
  const [layer, setLayer] = useState(null)
  const [job, setJob] = useState(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  useEffect(() => {
    if (!open) return
    fetch('/api/accounts')
      .then((r) => r.json())
      .then(setAccounts)
      .catch(() => {})
    return () => clearInterval(pollRef.current)
  }, [open])

  useEffect(() => {
    setLayer(null)
    setLayers([])
    if (!account) return
    fetch(`/api/drift/layers?account=${account}`)
      .then((r) => r.json())
      .then((d) => setLayers(d.layers || []))
      .catch(() => setLayers([]))
  }, [account])

  const run = async () => {
    if (!account || !layer) return
    setError(null)
    setJob(null)
    setRunning(true)
    try {
      const r = await fetch('/api/drift/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, layer }),
      })
      const b = await r.json()
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
      pollRef.current = setInterval(async () => {
        try {
          const jr = await fetch(`/api/drift/job/${b.jobId}`).then((x) => x.json())
          setJob(jr)
          if (jr.status !== 'running') {
            clearInterval(pollRef.current)
            setRunning(false)
          }
        } catch {
          /* riprova al prossimo tick */
        }
      }, 2000)
    } catch (e) {
      setError(e.message)
      setRunning(false)
    }
  }

  return (
    <Drawer title="Drift completo · terragrunt plan" open={open} onClose={onClose} width={640}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Text type="secondary">
          Esegue <Text code>terragrunt plan</Text> sul layer scelto (lento: init + provider + refresh;
          mette un lock sul backend). Read-only sull'infra.
        </Text>
        <Select
          placeholder="Account"
          value={account}
          onChange={setAccount}
          style={{ width: '100%' }}
          options={accounts.map((a) => ({ value: a.key, label: a.label }))}
        />
        <Select
          placeholder={layers.length ? 'Layer' : 'nessun layer (repoDir non configurato?)'}
          value={layer}
          onChange={setLayer}
          disabled={!layers.length}
          style={{ width: '100%' }}
          options={layers.map((l) => ({ value: l, label: l }))}
        />
        <Button type="primary" onClick={run} loading={running} disabled={!account || !layer} block>
          Esegui plan
        </Button>

        {running && (
          <Text type="secondary">In corso… può richiedere qualche minuto (la prima volta scarica i provider).</Text>
        )}
        {error && <Alert type="error" message={error} showIcon />}

        {job && job.status !== 'running' && (
          <>
            {job.status === 'error' ? (
              <Alert type="error" message={`Plan fallito (exit ${job.exitCode})`} showIcon />
            ) : job.drift ? (
              <Alert type="warning" message="⚠ DRIFT: la realtà differisce dallo state Terraform" showIcon />
            ) : (
              <Alert type="success" message="✓ No changes: infra allineata allo state" showIcon />
            )}
            <pre
              style={{
                maxHeight: 420,
                overflow: 'auto',
                fontSize: 12,
                background: 'rgba(127,127,127,0.08)',
                padding: 10,
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
              }}
            >
              {job.output || '(nessun output)'}
            </pre>
          </>
        )}
      </Space>
    </Drawer>
  )
}
