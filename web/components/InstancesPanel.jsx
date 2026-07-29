import { useEffect, useState } from 'react'
import { Table, Typography, Alert, Empty, Spin, Space, Button, Tag, Progress, Tooltip } from 'antd'
import { ReloadOutlined, FileTextOutlined } from '@ant-design/icons'

const { Text, Link } = Typography

// Quanto è pieno il riservato, per task. La soglia colora solo quando c'è qualcosa da guardare: il
// colore su ogni riga non distingue niente, e una barra tutta blu è rumore travestito da segnale.
function Usage({ pct, t }) {
  if (pct == null) return <Text type="secondary">—</Text>
  const status = pct >= 90 ? 'exception' : pct >= 75 ? 'normal' : 'normal'
  const stroke = pct >= 90 ? '#ff4d4f' : pct >= 75 ? '#faad14' : '#52c41a'
  return (
    <Space size={6} title={t('instances.ofReserved', { pct })}>
      <Progress percent={pct} showInfo={false} size={[54, 6]} status={status} strokeColor={stroke} />
      <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{pct}%</Text>
    </Space>
  )
}

// Come è morto un task, detto per quello che è. `oom` indica il sizing, `health` indica
// l'applicazione, `scheduler` è una sostituzione da deploy o uno scale-in: sono tre storie diverse che
// portano a interventi opposti, e chiamarle tutte "il task è ripartito" fa perdere il pomeriggio.
const STOP_TONE = { oom: 'error', health: 'warning', scheduler: 'default', user: 'default', other: 'warning' }

function StoppedTasks({ stopped = [], t }) {
  if (!stopped.length) return null
  return (
    <div style={{ marginTop: 14 }}>
      <Text strong style={{ fontSize: 12 }}>
        {t('instances.stopped')}
      </Text>
      <div style={{ marginTop: 6 }}>
        {stopped.map((s) => (
          <div key={s.taskId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0', fontSize: 12 }}>
            <Text type="secondary" style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>
              {s.stoppedAt ? new Date(s.stoppedAt).toLocaleTimeString() : '—'}
            </Text>
            <Text code style={{ fontSize: 11 }}>
              {s.shortId}
            </Text>
            {s.kind && <Tag color={STOP_TONE[s.kind]}>{t(`instances.stop.${s.kind}`)}</Tag>}
            <Text type="secondary" style={{ wordBreak: 'break-word' }}>
              {[s.stoppedReason, ...(s.containerReasons ?? [])].filter(Boolean).join(' · ') || '—'}
            </Text>
          </div>
        ))}
      </div>
    </div>
  )
}

const fmtBytes = (n) => {
  const v = Number(n) || 0
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}G`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`
  return String(v)
}

// Pannello "Istanze": una riga per task ECS. Le metriche di servizio sono MEDIE sulla flotta, e una
// media su tre replica nasconde il caso che si sta cercando — un task che macina CPU mentre gli altri
// stanno bene. Qui i task sono separati, e da ognuno si salta ai suoi log.
export default function InstancesPanel({ service, account, onTaskLogs, t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!service) {
      setData(null)
      return
    }
    let stale = false
    setLoading(true)
    setError(null)
    const acct = account ? `&account=${encodeURIComponent(account)}` : ''
    fetch(`/api/task-metrics?service=${encodeURIComponent(service)}${acct}&lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !stale && setData(d))
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [service, account, reloadKey, lang])

  const tasks = data?.tasks ?? []
  const mixedRevisions = (data?.revisions?.length ?? 0) > 1

  const columns = [
    {
      title: t('instances.col.task'),
      key: 'task',
      render: (_, r) => (
        <Space size={6}>
          {/* Il tooltip porta ciò che non merita una colonna ma serve quando serve: id intero, rete, e
              quanto è durato il pull dell'immagine (un pull lento è una causa vera di avvii lenti). */}
          <Tooltip
            title={
              <>
                <div>{r.taskId}</div>
                <div>{`↓${fmtBytes(r.netRxBytes)} ↑${fmtBytes(r.netTxBytes)}`}</div>
                {r.pullMs != null && <div>{t('instances.pull', { s: (r.pullMs / 1000).toFixed(1) })}</div>}
              </>
            }
          >
            <Text code style={{ fontSize: 12 }}>
              {r.shortId}
            </Text>
          </Tooltip>
          {r.az && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {r.az}
            </Text>
          )}
          {r.status && r.status !== 'RUNNING' && <Tag color="warning">{r.status}</Tag>}
          {/* Pacchetti scartati o in errore: compaiono solo quando non sono zero. Spiegano timeout che
              dall'applicazione sembrano inspiegabili, e mostrarli sempre a zero sarebbe rumore. */}
          {(r.netDropped > 0 || r.netErrors > 0) && (
            <Tooltip title={t('instances.netTroubleHint')}>
              <Tag color="warning">{t('instances.netTrouble', { n: r.netDropped + r.netErrors })}</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      // Lo stato NEL TARGET GROUP, per task. È la risposta a "0/2 target sani → quale?": un task può
      // essere su e verde per ECS e non ricevere traffico dal load balancer, e per chi usa il servizio
      // quello è giù. Il motivo (`Target.ResponseCodeMismatch`, draining…) sta nel tooltip.
      title: t('instances.col.state'),
      key: 'stato',
      width: 130,
      render: (_, r) => {
        if (r.target) {
          const ok = r.target.state === 'healthy'
          const draining = r.target.state === 'draining'
          return (
            <Tooltip title={[r.target.reason, r.target.description].filter(Boolean).join(' · ') || undefined}>
              <Tag color={ok ? 'success' : draining ? 'default' : 'error'}>{r.target.state}</Tag>
            </Tooltip>
          )
        }
        // Nessun target group: resta la salute del container, se il task ne dichiara una.
        if (r.health) return <Tag color={r.health === 'HEALTHY' ? 'success' : 'warning'}>{r.health.toLowerCase()}</Tag>
        return <Text type="secondary">—</Text>
      },
    },
    {
      title: t('instances.col.revision'),
      key: 'revision',
      width: 84,
      render: (_, r) => (r.revision ? <Text style={{ fontSize: 12 }}>{`v${r.revision}`}</Text> : '—'),
    },
    { title: t('instances.col.cpu'), key: 'cpu', width: 118, render: (_, r) => <Usage pct={r.cpuPct} t={t} /> },
    { title: t('instances.col.mem'), key: 'mem', width: 118, render: (_, r) => <Usage pct={r.memPct} t={t} /> },
    {
      // Latenza della SINGOLA replica, dagli access log dell'ALB. p95 in colonna e il resto nel
      // tooltip: il p50 dice com'è di solito, il p95 dice cosa sente chi sta peggio, e su tre replica
      // è il confronto tra righe che indica il colpevole — non il numero assoluto.
      title: t('instances.col.latency'),
      key: 'lat',
      width: 96,
      render: (_, r) => {
        if (!r.latency) return <Text type="secondary">—</Text>
        return (
          <Tooltip
            title={t('instances.latencyDetail', {
              p50: r.latency.p50,
              p99: r.latency.p99,
              max: r.latency.max,
              n: r.latency.requests,
              err: r.latency.errors,
            })}
          >
            <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{`${r.latency.p95}ms`}</Text>
          </Tooltip>
        )
      },
    },
    {
      // Su Fargate il disco effimero si riempie senza che nessuno lo guardi: un servizio che scrive
      // file (upload, conversioni, sandbox) muore lì prima che in memoria.
      title: t('instances.col.disk'),
      key: 'disk',
      width: 118,
      render: (_, r) => <Usage pct={r.diskPct} t={t} />,
    },
    {
      title: '',
      key: 'azioni',
      width: 44,
      align: 'right',
      render: (_, r) =>
        onTaskLogs ? (
          // Si passa anche l'ELENCO delle istanze, non solo quella scelta: il pannello log deve poter
          // offrire subito le altre e il ritorno a «Tutte». Ricavarle dalle risposte dei log non basta,
          // perché con un filtro attivo ne torna una sola e si resterebbe chiusi dentro un task.
          <Link
            type="secondary"
            onClick={() => onTaskLogs(r.taskId, tasks.map((x) => x.taskId))}
            title={t('instances.logsOfTask')}
          >
            <FileTextOutlined />
          </Link>
        ) : null,
    },
  ]

  return (
    <>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('instances.window')}
        </Text>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => setReloadKey((k) => k + 1)}>
          {t('logs.refresh')}
        </Button>
      </Space>

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}

      {loading && !data ? (
        <div style={{ textAlign: 'center', paddingTop: 60 }}>
          <Spin tip={t('logs.loading')} />
        </div>
      ) : data?.notApplicable ? (
        <Empty style={{ paddingTop: 50 }} description={t('instances.notApplicable')} />
      ) : data?.error ? (
        // Il caso tipico è Container Insights spento sul cluster: è una risposta, non un guasto.
        <Alert type="warning" showIcon message={data.error} description={t('instances.needsInsights')} />
      ) : tasks.length === 0 ? (
        <Empty style={{ paddingTop: 50 }} description={t('instances.empty')} />
      ) : (
        <>
          {/* Due revision insieme = rollout in corso: spiega da sé perché un task si comporta
              diversamente dagli altri, e senza dirlo si finisce a cercare un bug che non c'è. */}
          {mixedRevisions && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 8 }}
              message={t('instances.mixedRevisions', { list: data.revisions.map((r) => `v${r}`).join(', ') })}
            />
          )}
          <Table
            size="small"
            rowKey="taskId"
            dataSource={tasks}
            columns={columns}
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
          <StoppedTasks stopped={data.stopped} t={t} />
          {/* Da dove viene (o non viene) la latenza. Detta, non lasciata dedurre da una colonna di
              trattini: senza access log ALB la latenza per replica non esiste, e un pannello che tace
              lascia credere che il servizio non abbia traffico. */}
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
            {data.latencySource?.available
              ? t('instances.latencyFrom', { n: data.latencySource.objects, m: data.latencySource.window })
              : t('instances.noLatency')}
          </Text>
        </>
      )}
    </>
  )
}
