import { useEffect, useRef, useState } from 'react'
import { Drawer, Select, Button, Alert, Space, Typography } from 'antd'

const { Text } = Typography

// #6 drift COMPLETO: lancia `terragrunt plan` per un layer (job async, polling).
// Esegue comandi → salto consapevole a "servizio".
export default function DriftDrawer({ open, onClose, t = (k) => k }) {
  const [accounts, setAccounts] = useState([])
  const [account, setAccount] = useState(null)
  const [layers, setLayers] = useState([])
  const [layer, setLayer] = useState(null)
  const [job, setJob] = useState(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  useEffect(() => {
    // Alla chiusura ferma comunque il polling (l'intervallo non deve sopravvivere al drawer).
    if (!open) {
      clearInterval(pollRef.current)
      return
    }
    // Reset: niente stato cached dall'apertura precedente.
    setAccounts([])
    setError(null)
    fetch('/api/accounts')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setAccounts)
      .catch((e) => setError(e.message)) // prima era silenzioso: ora errore visibile
    return () => clearInterval(pollRef.current) // cleanup su unmount/cambio open
  }, [open])

  useEffect(() => {
    setLayer(null)
    setLayers([])
    if (!account) return
    fetch(`/api/drift/layers?account=${account}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => setLayers(d.layers || []))
      .catch((e) => {
        setLayers([])
        setError(e.message) // niente fallimento muto sul fetch dei layer
      })
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
    <Drawer title={t('drift.title')} open={open} onClose={onClose} width={640}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Text type="secondary">{t('drift.desc')}</Text>
        <Select
          placeholder={t('drift.account')}
          value={account}
          onChange={setAccount}
          style={{ width: '100%' }}
          options={accounts.map((a) => ({ value: a.key, label: a.label }))}
        />
        <Select
          placeholder={layers.length ? t('drift.layer') : t('drift.noLayer')}
          value={layer}
          onChange={setLayer}
          disabled={!layers.length}
          style={{ width: '100%' }}
          options={layers.map((l) => ({ value: l, label: l }))}
        />
        <Button type="primary" onClick={run} loading={running} disabled={!account || !layer} block>
          {t('drift.run')}
        </Button>

        {running && <Text type="secondary">{t('drift.running')}</Text>}
        {error && <Alert type="error" message={error} showIcon />}

        {job && job.status !== 'running' && (
          <>
            {job.status === 'error' ? (
              <Alert type="error" message={t('drift.failed', { code: job.exitCode })} showIcon />
            ) : job.drift ? (
              <Alert type="warning" message={t('drift.drift')} showIcon />
            ) : (
              <Alert type="success" message={t('drift.nochanges')} showIcon />
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
              {job.output || t('drift.nooutput')}
            </pre>
          </>
        )}
      </Space>
    </Drawer>
  )
}
