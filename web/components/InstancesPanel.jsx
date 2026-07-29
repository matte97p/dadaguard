import { useEffect, useState } from 'react'
import { Table, Typography, Alert, Empty, Spin, Space, Button, Tag, Progress } from 'antd'
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
          <Text code style={{ fontSize: 12 }}>
            {r.shortId}
          </Text>
          {r.az && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {r.az}
            </Text>
          )}
          {r.status && r.status !== 'RUNNING' && <Tag color="warning">{r.status}</Tag>}
        </Space>
      ),
    },
    {
      title: t('instances.col.revision'),
      key: 'revision',
      width: 90,
      render: (_, r) => (r.revision ? <Text style={{ fontSize: 12 }}>{`v${r.revision}`}</Text> : '—'),
    },
    { title: t('instances.col.cpu'), key: 'cpu', width: 130, render: (_, r) => <Usage pct={r.cpuPct} t={t} /> },
    { title: t('instances.col.mem'), key: 'mem', width: 130, render: (_, r) => <Usage pct={r.memPct} t={t} /> },
    {
      title: t('instances.col.net'),
      key: 'net',
      width: 110,
      render: (_, r) => (
        <Text type="secondary" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {`↓${fmtBytes(r.netRxBytes)} ↑${fmtBytes(r.netTxBytes)}`}
        </Text>
      ),
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
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
            {t('instances.noLatency')}
          </Text>
        </>
      )}
    </>
  )
}
