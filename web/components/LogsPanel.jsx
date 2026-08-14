import { useEffect, useRef, useState } from 'react'
import { Switch, Segmented, Alert, Empty, Spin, Typography, Space, Button, Select } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { taskOfStream, instanceOptions } from '../format.js'
import { NOISE, LogLines } from '../logline.jsx'

const { Text } = Typography

// Pannello "Log recenti" di un servizio: snapshot on-demand (ultima finestra), niente tail live.
// Read-only/zero storage.
//
// È un PANNELLO, non un drawer: vive in una scheda del pannello del servizio, così i log non coprono
// più lo stato del servizio che stai guardando. Il fetch parte al mount e la scheda si monta solo
// quando la apri: resta on-demand come prima.
const shortTask = (taskId) => String(taskId ?? '').slice(0, 8)

export default function LogsPanel({
  service,
  account,
  focus = null, // { task, tasks } dalla scheda Istanze: oggetto nuovo a ogni clic
  defaultMinutes = 60,
  defaultErrorsOnly = false,
  t = (k) => k,
  lang,
}) {
  const [errorsOnly, setErrorsOnly] = useState(defaultErrorsOnly)
  const [minutes, setMinutes] = useState(defaultMinutes) // finestra log: 1h / 6h / 24h / 48h
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showNoise, setShowNoise] = useState(false) // mostra le righe di piattaforma Lambda
  // Health-check: si scartano LATO SERVER (vedi HEALTH_LINE in server/logs.js), quindi rimetterli
  // rifà la chiamata. Su un servizio HTTP sano sono ~90% del log: tenerli spegne il pannello.
  const [showHealth, setShowHealth] = useState(false)
  const [reloadKey, setReloadKey] = useState(0) // bump dal bottone Aggiorna → refetch
  // Istanza selezionata (task ECS). Anche questo filtro è LATO SERVER: un task chiacchierone
  // riempirebbe il tetto di righe e degli altri non resterebbe niente.
  const [task, setTask] = useState(focus?.task ?? null)
  // Le istanze viste finora. Tenute a parte perché con un filtro attivo la risposta contiene un solo
  // stream: leggendo le opzioni dall'ultima risposta, scegliere un task cancellerebbe gli altri dalla
  // tendina e non si potrebbe più tornare indietro.
  const [knownTasks, setKnownTasks] = useState(focus?.tasks ?? [])

  // All'apertura di un servizio applica i default giusti per quel servizio (es. un cron rosso →
  // finestra ampia + solo errori, così il fallimento notturno è subito visibile senza toccare i filtri).
  useEffect(() => {
    if (service) {
      setMinutes(defaultMinutes)
      setErrorsOnly(defaultErrorsOnly)
    }
  }, [service, defaultMinutes, defaultErrorsOnly])

  // Arrivo dal pannello Istanze: il filtro parte già applicato e il selettore è già popolato con tutte
  // le istanze, così si può passare a un'altra o tornare a «Tutte» senza aspettare un'altra risposta.
  // `focus` è un oggetto nuovo a ogni clic, quindi ricliccare lo stesso task riapplica il filtro.
  useEffect(() => {
    if (!focus) return
    setTask(focus.task ?? null)
    if (focus.tasks?.length) setKnownTasks((prev) => [...new Set([...prev, ...focus.tasks])].sort())
  }, [focus])

  // Cambio di servizio: le istanze di prima non esistono qui, e un filtro rimasto darebbe una lista
  // vuota senza spiegazione. Si confronta col servizio precedente invece di azzerare a ogni giro: al
  // PRIMO montaggio anche questo effetto parte, e cancellerebbe il filtro appena arrivato da Istanze —
  // la scheda log si monta alla prima apertura, cioè proprio in risposta a quel clic.
  const prevService = useRef(null)
  useEffect(() => {
    const key = `${account ?? ''}/${service ?? ''}`
    if (prevService.current !== null && prevService.current !== key) {
      setTask(null)
      setKnownTasks([])
    }
    prevService.current = key
  }, [service, account])

  useEffect(() => {
    if (!service) {
      setData(null)
      return
    }
    let stale = false
    setLoading(true)
    setError(null)
    // `account` insieme al nome: il nome da solo è ambiguo (staging e produzione hanno gli stessi
    // servizi) e il server aprirebbe il log group dell'ambiente sbagliato.
    const acct = account ? `&account=${encodeURIComponent(account)}` : ''
    const one = task ? `&task=${encodeURIComponent(task)}` : ''
    fetch(
      `/api/logs?service=${encodeURIComponent(service)}${acct}&errorsOnly=${errorsOnly}&skipHealth=${!showHealth}${one}&minutes=${minutes}&lang=${lang}`,
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (stale) return
        setData(d)
        // Le istanze si accumulano invece di essere sostituite: la tendina deve restare popolata
        // anche mentre un filtro è attivo.
        const seen = (d.streams ?? []).map(taskOfStream).filter(Boolean)
        if (seen.length) setKnownTasks((prev) => [...new Set([...prev, ...seen])].sort())
      })
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [service, account, errorsOnly, showHealth, task, minutes, reloadKey, lang])

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
        <Space size={14} wrap>
          <Space size={6}>
            <Switch checked={errorsOnly} onChange={setErrorsOnly} />
            <Text>{t('logs.errorsOnly')}</Text>
          </Space>
          <Space size={6}>
            <Switch checked={showNoise} onChange={setShowNoise} />
            <Text>{t('logs.showNoise')}</Text>
          </Space>
          <Space size={6}>
            <Switch checked={showHealth} onChange={setShowHealth} />
            <Text>{t('logs.showHealth')}</Text>
          </Space>
          {/* Il selettore compare se ci sono più istanze — su una replica sola sarebbe un controllo con
              una voce, che non filtra niente — MA anche quando un filtro è attivo: nascondendolo lì, chi
              arriva da Istanze resta chiuso dentro un task senza modo di tornare a «Tutte». */}
          {(knownTasks.length > 1 || task) && (
            <Space size={6}>
              <Text>{t('logs.instance')}</Text>
              <Select
                size="small"
                value={task ?? ''}
                onChange={(v) => setTask(v || null)}
                style={{ minWidth: 130 }}
                options={instanceOptions(knownTasks, task, t('logs.allInstances'), shortTask)}
              />
            </Space>
          )}
          <Space size={6}>
            <Text>{t('logs.window')}</Text>
            <Segmented
              size="small"
              value={minutes}
              onChange={setMinutes}
              options={[
                { label: '1h', value: 60 },
                { label: '6h', value: 360 },
                { label: '24h', value: 1440 },
                { label: '48h', value: 2880 },
              ]}
            />
          </Space>
        </Space>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => setReloadKey((k) => k + 1)}>
          {t('logs.refresh')}
        </Button>
      </Space>

      <Alert type="info" showIcon style={{ marginBottom: 8 }} message={t('logs.warning')} />
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}

      {loading ? (
        <div style={{ textAlign: 'center', paddingTop: 80 }}>
          <Spin tip={t('logs.loading')} />
        </div>
      ) : data?.notApplicable ? (
        <Empty style={{ paddingTop: 60 }} description={t('logs.notApplicable')} />
      ) : data?.error ? (
        <Alert type="warning" showIcon message={data.error} />
      ) : data ? (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('logs.group')}: {data.logGroup}
          </Text>
          {(() => {
            const all = data.events ?? []
            // "Nessun evento" quando gli eventi c'erano ed erano tutti health check è una bugia, e
            // manda a cercare un problema dove non c'è: si dice cosa è stato scartato e come rivederlo.
            if (all.length === 0)
              return (
                <Empty
                  style={{ paddingTop: 60 }}
                  description={data.healthSkipped > 0 ? t('logs.onlyHealth', { n: data.healthSkipped }) : t('logs.empty')}
                />
              )
            const rows = all.filter((e) => showNoise || !NOISE.test((e.message ?? '').trimStart()))
            const hidden = all.length - rows.length
            return (
              <>
                <div style={{ fontSize: 11, opacity: 0.6, margin: '4px 0' }}>
                  {rows.length}
                  {hidden > 0 ? ` · ${t('logs.hidden', { n: hidden })}` : ''}
                  {data.healthSkipped > 0 ? ` · ${t('logs.healthHidden', { n: data.healthSkipped })}` : ''}
                </div>
                <LogLines
                  events={rows}
                  // Da quale istanza arriva la riga. Solo quando ne stai leggendo più di una: con un
                  // filtro attivo sarebbe lo stesso valore ripetuto su ogni riga.
                  prefix={
                    !task && knownTasks.length > 1
                      ? (e) => (e.stream ? <span style={{ opacity: 0.4 }}>{shortTask(taskOfStream(e.stream))}</span> : null)
                      : null
                  }
                />
              </>
            )
          })()}
        </>
      ) : null}
    </>
  )
}
