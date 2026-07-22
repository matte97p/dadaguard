import { useEffect, useState } from 'react'
import { Drawer, Switch, Segmented, Alert, Empty, Spin, Typography, Space, Button } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

const { Text } = Typography

const LEVEL_COLOR = {
  error: '#ff4d4f',
  fatal: '#ff4d4f',
  critical: '#ff4d4f',
  err: '#ff4d4f',
  warn: '#faad14',
  warning: '#faad14',
  info: '#52c41a',
  debug: '#8c8c8c',
  trace: '#8c8c8c',
}
// righe di piattaforma Lambda (rumore: START/END/REPORT/INIT) — nascoste di default
const NOISE = /^(START|END|REPORT|INIT_START|XRAY) RequestId/

// Prova a interpretare un evento come log JSON strutturato → { level, msg }. Altrimenti riga grezza.
function parseEvent(message) {
  const s = (message ?? '').trim()
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s)
      const level = String(o.level ?? o.severity ?? o.lvl ?? o.levelname ?? '').toLowerCase()
      const msg = o.message ?? o.msg ?? o.error ?? o.event ?? null
      if (msg != null) return { level, msg: String(msg) }
    } catch {
      /* non è JSON valido */
    }
  }
  return { level: '', msg: message ?? '' }
}

// Pannello "Log recenti" di un servizio: snapshot on-demand (ultima finestra), niente tail live.
// Read-only/zero storage. service = nome (apre quando truthy).
export default function LogsDrawer({ service, defaultMinutes = 60, defaultErrorsOnly = false, onClose, t = (k) => k, lang }) {
  const [errorsOnly, setErrorsOnly] = useState(defaultErrorsOnly)
  const [minutes, setMinutes] = useState(defaultMinutes) // finestra log: 1h / 6h / 24h / 48h
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showNoise, setShowNoise] = useState(false) // mostra le righe di piattaforma Lambda
  const [reloadKey, setReloadKey] = useState(0) // bump dal bottone Aggiorna → refetch

  // All'apertura di un servizio applica i default giusti per quel servizio (es. un cron rosso →
  // finestra ampia + solo errori, così il fallimento notturno è subito visibile senza toccare i filtri).
  useEffect(() => {
    if (service) {
      setMinutes(defaultMinutes)
      setErrorsOnly(defaultErrorsOnly)
    }
  }, [service, defaultMinutes, defaultErrorsOnly])

  useEffect(() => {
    if (!service) {
      setData(null)
      return
    }
    let stale = false
    setLoading(true)
    setError(null)
    fetch(`/api/logs?service=${encodeURIComponent(service)}&errorsOnly=${errorsOnly}&minutes=${minutes}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !stale && setData(d))
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [service, errorsOnly, minutes, reloadKey, lang])

  const fmtTs = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '')

  return (
    <Drawer
      title={`${t('logs.title')}${service ? ` · ${service}` : ''}`}
      placement="right"
      width={760}
      open={Boolean(service)}
      onClose={onClose}
    >
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
            if (all.length === 0) return <Empty style={{ paddingTop: 60 }} description={t('logs.empty')} />
            const rows = all.filter((e) => showNoise || !NOISE.test((e.message ?? '').trimStart()))
            const hidden = all.length - rows.length
            return (
              <>
                <div style={{ fontSize: 11, opacity: 0.6, margin: '4px 0' }}>
                  {rows.length}
                  {hidden > 0 ? ` · ${t('logs.hidden', { n: hidden })}` : ''}
                </div>
                <div
                  style={{
                    maxHeight: '58vh',
                    overflow: 'auto',
                    fontSize: 12,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    background: 'rgba(127,127,127,0.06)',
                    padding: 8,
                    borderRadius: 6,
                  }}
                >
                  {rows.map((e, i) => {
                    const p = parseEvent(e.message)
                    return (
                      <div
                        key={i}
                        style={{
                          padding: '3px 2px',
                          borderBottom: '1px solid rgba(127,127,127,0.08)',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        <span style={{ opacity: 0.5 }}>{fmtTs(e.ts)}</span>{' '}
                        {p.level && (
                          <span style={{ color: LEVEL_COLOR[p.level] ?? undefined, fontWeight: 700 }}>
                            {p.level.toUpperCase()}
                          </span>
                        )}{' '}
                        <span>{p.msg}</span>
                      </div>
                    )
                  })}
                </div>
              </>
            )
          })()}
        </>
      ) : null}
    </Drawer>
  )
}
