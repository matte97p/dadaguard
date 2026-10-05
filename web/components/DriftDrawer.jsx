import { useEffect, useRef, useState } from 'react'
import { Drawer, Pill } from '../ui/index.js'
import './servizi.css'

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

  // Esito del plan: il livello colora la pillola, il testo lo dice a parole.
  const finito = job && job.status !== 'running'
  const esito = finito ? ({ error: 'crit', drift: 'warn', pending: 'info' }[job.kind] ?? 'ok') : null
  const testoEsito = !finito
    ? null
    : ({
        error: t('drift.failed', { code: job.exitCode }),
        drift: t('drift.drift'),
        pending: t('drift.pending', { n: job.counts?.add ?? '?' }),
      }[job.kind] ?? t('drift.nochanges'))

  return (
    <Drawer aperto={open} onChiudi={onClose} titolo={t('drift.title')} etichettaChiudi={t('ui.chiudi')}>
      <p className="ui-mute">{t('drift.desc')}</p>
      {/* Select nativi: due scelte da una lista breve, e sopra a un pannello la tendina di antd si
          apriva sotto lo sfondo. */}
      <select
        className="sv-search"
        value={account ?? ''}
        onChange={(e) => setAccount(e.target.value || null)}
        aria-label={t('drift.account')}
      >
        <option value="">{t('drift.account')}</option>
        {accounts.map((a) => (
          <option key={a.key} value={a.key}>
            {a.label}
          </option>
        ))}
      </select>
      <select
        className="sv-search"
        value={layer ?? ''}
        onChange={(e) => setLayer(e.target.value || null)}
        disabled={!layers.length}
        aria-label={t('drift.layer')}
      >
        <option value="">{layers.length ? t('drift.layer') : t('drift.noLayer')}</option>
        {layers.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      <div>
        <button type="button" className="ui-kbd" onClick={run} disabled={running || !account || !layer}>
          {running ? t('drift.running') : t('drift.run')}
        </button>
      </div>
      {error && <div className="ui-readwarn">{error}</div>}
      {esito && (
        <>
          <div>
            <Pill livello={esito}>{testoEsito}</Pill>
          </div>
          <pre className="sv-logs">{job.output || t('drift.nooutput')}</pre>
        </>
      )}
    </Drawer>
  )
}
