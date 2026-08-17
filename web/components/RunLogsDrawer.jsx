import { useEffect, useState } from 'react'
import { Drawer, Space, Switch, Typography, Tag, Alert, Empty, Button } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { LogLines } from '../logline.jsx'
import { fmtMs } from '../format.js'
import { MONO } from '../theme.js'
import { OUTCOME_TAG } from './runBits.jsx'
import Loading from './Loading.jsx'

const { Text } = Typography

// I log di UNA esecuzione, non «gli ultimi log di quel job».
//
// È la differenza che rende utile la pagina: aprendo i log di un cron si legge quello che c'è ADESSO
// nel log group, cioè (su un job giornaliero) l'esecuzione di stanotte mescolata a quella di ieri.
// Qui la finestra è quella della run (inizio → fine, +1 minuto di coda per l'ultima riga di un
// traceback) e, dove esiste, lo stream è quello del suo task: nessuna riga di un'altra corsa.
//
// Su una run IN CORSO il pannello si ricarica da sé: è il caso per cui la vista esiste (uno scraper a
// metà lavoro), e chiedere di premere «Aggiorna» ogni dieci secondi non è guardare un job che gira.
const LIVE_MS = 10_000

export default function RunLogsDrawer({ open, onClose, cron, run, t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!open || !run) return undefined
    let stale = false
    const carica = () => {
      setLoading(true)
      setError(null)
      const q = new URLSearchParams({ lang: lang ?? '', errorsOnly: String(errorsOnly), limit: '400' })
      if (run.source === 'prefect') {
        q.set('source', 'prefect')
        q.set('run', run.id)
      } else {
        q.set('cron', cron.key)
        q.set('run', run.id ?? '')
        if (run.stream) q.set('stream', run.stream)
        if (run.startedAt) q.set('from', String(run.startedAt))
        if (run.endedAt) q.set('to', String(run.endedAt))
      }
      fetch(`/api/runs/logs?${q}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => !stale && setData(d))
        .catch((e) => !stale && setError(e.message))
        .finally(() => !stale && setLoading(false))
    }
    carica()
    // Run finita: niente polling. Il log di una run chiusa non cambia più, e ricaricarlo è solo
    // traffico verso CloudWatch per riscrivere le stesse righe.
    const timer = run.running ? setInterval(carica, LIVE_MS) : null
    return () => {
      stale = true
      if (timer) clearInterval(timer)
    }
  }, [open, cron?.key, run?.id, run?.running, run?.endedAt, errorsOnly, reloadKey, lang])

  const eventi = data?.events ?? []

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={860}
      title={
        run ? (
          <Space size={8} wrap>
            <span style={{ fontFamily: MONO }}>{cron?.name ?? run.cron}</span>
            {OUTCOME_TAG(run.outcome, t)}
            <Text type="secondary" style={{ fontSize: 12 }}>
              {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
              {run.durationMs ? ` · ${fmtMs(run.durationMs)}` : ''}
            </Text>
            {run.running && <Tag color="processing">{t('runs.live')}</Tag>}
          </Space>
        ) : null
      }
    >
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
        <Space size={14} wrap>
          <Space size={6}>
            <Switch checked={errorsOnly} onChange={setErrorsOnly} />
            <Text>{t('logs.errorsOnly')}</Text>
          </Space>
          {run?.id && (
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
              {String(run.id).slice(0, 12)}
            </Text>
          )}
        </Space>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => setReloadKey((k) => k + 1)}>
          {t('logs.refresh')}
        </Button>
      </Space>

      {run?.running && <Alert type="info" showIcon style={{ marginBottom: 8 }} message={t('runs.logs.live')} />}
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
      {data?.error && <Alert type="warning" showIcon message={data.error} style={{ marginBottom: 8 }} />}

      {data?.logGroup && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('logs.group')}: {data.logGroup}
        </Text>
      )}

      {loading && !eventi.length ? (
        <div style={{ textAlign: 'center', paddingTop: 60 }}>
          <Loading text={t('logs.loading')} />
        </div>
      ) : data?.notApplicable ? (
        <Empty style={{ paddingTop: 60 }} description={t('logs.notApplicable')} />
      ) : eventi.length === 0 ? (
        // Una run senza NESSUNA riga non è una lista vuota qualunque: è il caso in cui il task è morto
        // prima di scrivere (immagine che non parte, segreto mancante), e dirlo indirizza la ricerca.
        <Empty style={{ paddingTop: 60 }} description={t('runs.logs.empty')} />
      ) : (
        <>
          <div style={{ fontSize: 11, opacity: 0.6, margin: '4px 0' }}>
            {eventi.length}
            {data?.truncated ? ` · ${t('runs.logs.truncated')}` : ''}
          </div>
          <LogLines events={eventi} maxHeight="72vh" />
        </>
      )}
    </Drawer>
  )
}
