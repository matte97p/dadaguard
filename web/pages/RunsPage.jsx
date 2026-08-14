import { useMemo, useState } from 'react'
import { Table, Tag, Space, Typography, Segmented, Switch, Input, Alert, Empty, Skeleton, Button, Tooltip } from 'antd'
import { FileTextOutlined, SyncOutlined } from '@ant-design/icons'
import { PageIntro, HeroRow, HeroStat, PANEL_CARD } from './pageKit.jsx'
import { usePoll } from '../usePoll.js'
import { fmtAgo, fmtMs, fmtSchedule } from '../format.js'
import { levelColor, MONO, SURFACE } from '../theme.js'
import { OUTCOME_TAG, outcomeColor, runElapsed, useTick } from '../components/runBits.jsx'
import RunLogsDrawer from '../components/RunLogsDrawer.jsx'

const { Text } = Typography

// Pagina ESECUZIONI: cosa sta girando adesso, e com'è finita ogni singola corsa di prima.
//
// Perché non basta la card di un cron: la card risponde «il cron va / è saltato», che è la domanda di
// un watchdog. Su un job LUNGO — uno scraper che macina un'ora — le domande vere sono altre due, e
// nessuna vista le copriva: *sta girando in questo momento, e da quanto?* e *quella di stanotte com'è
// andata, e dove sono i suoi log?*. Uno stato aggregato non le distingue nemmeno: un cron «up» può
// essere fermo, a metà corsa, o appena finito male con l'exit code a zero.
//
// La pagina è UNA tabella di RUN, non una di cron: l'unità di cui si parla è l'esecuzione. I cron che
// nella finestra non hanno corso stanno in fondo, perché «non è partito» è una risposta anche quella —
// ed è quella che nessuna lista di esecuzioni, per definizione, mostrerebbe.
const WINDOWS = [
  { label: '6h', value: 360 },
  { label: '24h', value: 1440 },
  { label: '7g', value: 10_080 },
  { label: '30g', value: 43_200 },
]

// Le run di tutti i cron, appiattite in righe: una riga = una esecuzione. Pura.
export function flattenRuns(crons = [], prefect = null) {
  const righe = []
  for (const c of crons) {
    for (const r of c.runs ?? []) {
      righe.push({
        ...r,
        key: `${c.key}#${r.id ?? r.startedAt}`,
        cronKey: c.key,
        cronName: c.name,
        cronType: c.type,
        account: c.account,
        accountLabel: c.accountLabel,
        accountColor: c.color,
      })
    }
  }
  for (const r of prefect?.runs ?? []) {
    righe.push({
      ...r,
      key: `prefect#${r.id}`,
      cronKey: null,
      cronName: r.cron,
      cronType: 'prefect',
      account: null,
      accountLabel: null,
      accountColor: null,
    })
  }
  return righe.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

// Il tipo di sorgente in una parola: dice DA DOVE arriva la riga, che su questa pagina è metà del
// contesto (un job dell'orchestratore non ha né exit code né log group).
const TYPE_KEY = { lambda: 'runs.type.lambda', 'ecs-scheduled': 'runs.type.ecs', prefect: 'runs.type.prefect' }

// Le colonne della tabella, in una funzione a parte: così si possono rendere (e quindi provare) fuori
// dal browser, che in questo repo è l'unico modo di provare della UI — i test girano su `node --test`,
// senza DOM. Una colonna che lancia su una run senza durata è una pagina bianca, e va scoperta qui.
export function runColumns({ t = (k) => k, onOpen = () => {} } = {}) {
  return [
    {
      title: t('runs.col.cron'),
      dataIndex: 'cronName',
      render: (name, r) => (
        <Space size={6} wrap>
          <span style={{ fontFamily: MONO }}>{name}</span>
          {r.accountLabel && (
            <Tag bordered={false} color={r.accountColor ?? undefined} style={{ marginInlineEnd: 0, fontSize: 11 }}>
              {r.accountLabel}
            </Tag>
          )}
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t(TYPE_KEY[r.cronType] ?? 'runs.type.other')}
          </Text>
        </Space>
      ),
    },
    {
      title: t('runs.col.started'),
      dataIndex: 'startedAt',
      width: 190,
      render: (ts) =>
        ts ? (
          <Tooltip title={new Date(ts).toLocaleString()}>
            <span>{fmtAgo(ts, t)}</span>
          </Tooltip>
        ) : (
          '—'
        ),
    },
    {
      title: t('runs.col.duration'),
      width: 120,
      render: (_, r) => {
        const ms = runElapsed(r)
        if (ms == null) return '—'
        // Su una run in corso il numero CRESCE: è il segnale che il lavoro sta avvenendo, e va detto
        // che non è una durata finale.
        return r.running ? (
          <Space size={4}>
            <SyncOutlined spin style={{ color: levelColor('info'), fontSize: 11 }} />
            <span>{fmtMs(ms)}</span>
          </Space>
        ) : (
          fmtMs(ms)
        )
      },
    },
    {
      title: t('runs.col.outcome'),
      width: 210,
      render: (_, r) => (
        <Space size={6} wrap>
          {OUTCOME_TAG(r.outcome, t)}
          {/* Il MOTIVO, quando c'è: «uscito 137 · OutOfMemoryError» è la riga che chiude la domanda
              senza aprire i log. Un exit code da solo non la chiude, quindi va accompagnato. */}
          {r.exitCode != null && r.exitCode !== 0 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('runs.exit', { code: r.exitCode })}
            </Text>
          )}
          {r.timedOut && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('runs.timedOut')}
            </Text>
          )}
          {r.stopReason && /OutOfMemory|OOMKilled/i.test(r.stopReason) && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('runs.oom')}
            </Text>
          )}
          {r.state && r.cronType === 'prefect' && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {r.state}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '',
      width: 96,
      render: (_, r) => (
        <Button size="small" icon={<FileTextOutlined />} onClick={() => onOpen(r)}>
          {t('runs.logs')}
        </Button>
      ),
    },
  ]
}

export default function RunsPage({ t = (k) => k, lang, refreshKey, accountFilter = 'all' }) {
  const [minutes, setMinutes] = useState(1440)
  const [soloProblemi, setSoloProblemi] = useState(false)
  const [query, setQuery] = useState('')
  const [aperta, setAperta] = useState(null) // { cron, run } della run di cui si leggono i log

  // Polling educato (in pausa a tab nascosto, rinfresca al rientro): una run in corso va vista
  // avanzare, ma senza chiamare AWS quando nessuno guarda. `refreshKey` = il tasto Aggiorna globale.
  const { data, loading, error, refreshing, lastUpdated } = usePoll(
    `/api/runs?minutes=${minutes}&lang=${lang}&k=${refreshKey ?? 0}`,
    { intervalMs: 30_000 },
  )

  const crons = useMemo(
    () => (data?.crons ?? []).filter((c) => accountFilter === 'all' || c.account === accountFilter),
    [data, accountFilter],
  )
  // L'orchestratore non ha account AWS: con un filtro per account attivo le sue run non appartengono a
  // quell'account e sparirebbero. Si nasconde tutta la sorgente, invece di mostrarla filtrata a metà.
  const prefect = accountFilter === 'all' ? data?.prefect : null

  const righe = useMemo(() => flattenRuns(crons, prefect), [crons, prefect])
  const inCorso = useMemo(() => righe.filter((r) => r.running), [righe])
  // L'orologio batte solo se c'è una run viva: su una pagina di corse finite i numeri sono fermi.
  useTick(inCorso.length > 0)

  const filtrate = useMemo(() => {
    const q = query.trim().toLowerCase()
    return righe.filter(
      (r) =>
        (!soloProblemi || r.outcome === 'failed' || r.outcome === 'unknown') &&
        (!q || String(r.cronName ?? '').toLowerCase().includes(q)),
    )
  }, [righe, soloProblemi, query])

  // Cron che nella finestra non hanno corso: «non è partito» è una risposta, e una tabella di
  // esecuzioni non può darla per definizione.
  const senzaRun = useMemo(() => crons.filter((c) => (c.runs ?? []).length === 0), [crons])
  const prossima = useMemo(
    () =>
      crons
        .filter((c) => c.nextRunAt)
        .sort((a, b) => a.nextRunAt - b.nextRunAt)[0] ?? null,
    [crons],
  )
  const falliteFinestra = righe.filter((r) => r.outcome === 'failed').length

  const cronOf = (riga) => crons.find((c) => c.key === riga.cronKey) ?? { key: riga.cronKey, name: riga.cronName }
  const columns = useMemo(() => runColumns({ t, onOpen: (r) => setAperta({ cron: cronOf(r), run: r }) }), [t, crons])

  return (
    <>
      <PageIntro
        title={t('runs.title')}
        desc={t('runs.desc')}
        extra={
          <Space size={12} wrap>
            <Segmented size="small" value={minutes} onChange={setMinutes} options={WINDOWS} />
            <Space size={6}>
              <Switch size="small" checked={soloProblemi} onChange={setSoloProblemi} />
              <Text style={{ fontSize: 12 }}>{t('runs.onlyProblems')}</Text>
            </Space>
            <Input.Search
              allowClear
              size="small"
              placeholder={t('runs.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 190 }}
            />
          </Space>
        }
      />

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {(data?.problems ?? []).map((p) => (
        <Alert key={p.account} type="warning" showIcon message={`${p.account}: ${p.error}`} style={{ marginBottom: 8 }} />
      ))}
      {/* Sorgente configurata ma non raggiungibile: dirlo, altrimenti «nessun job dell'orchestratore»
          si legge come «nessuno sta girando», che è la bugia peggiore su questa pagina. */}
      {data?.prefect?.error && <Alert type="warning" showIcon message={`Prefect: ${data.prefect.error}`} style={{ marginBottom: 8 }} />}
      {data?.truncated && <Alert type="info" showIcon message={t('runs.tooMany')} style={{ marginBottom: 8 }} />}

      {loading && !data ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <>
          <HeroRow>
            <HeroStat label={t('runs.hero.running')} value={inCorso.length} color={inCorso.length ? levelColor('info') : undefined} />
            <HeroStat label={t('runs.hero.failed')} value={falliteFinestra} color={falliteFinestra ? levelColor('bad') : undefined} />
            <HeroStat label={t('runs.hero.crons')} value={crons.filter((c) => c.enabled).length} />
            {prossima && (
              <HeroStat
                label={t('runs.hero.next')}
                size={14}
                value={`${prossima.name} · ${new Date(prossima.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
              />
            )}
          </HeroRow>

          {/* In corso ADESSO, in cima e a parte: è la domanda per cui si apre questa pagina, e in una
              tabella ordinata per orario si perderebbe fra le corse di ieri. */}
          {inCorso.length > 0 && (
            <div style={{ ...PANEL_CARD, marginBottom: 16, borderColor: levelColor('info') }}>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                {t('runs.nowTitle')}
              </Text>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {inCorso.map((r) => (
                  <div
                    key={r.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flexWrap: 'wrap',
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: SURFACE.rowBg,
                      borderLeft: `3px solid ${outcomeColor('running')}`,
                    }}
                  >
                    <SyncOutlined spin style={{ color: levelColor('info') }} />
                    <span style={{ fontFamily: MONO }}>{r.cronName}</span>
                    {r.accountLabel && (
                      <Tag bordered={false} color={r.accountColor ?? undefined} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                        {r.accountLabel}
                      </Tag>
                    )}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('runs.for', { d: fmtMs(runElapsed(r) ?? 0) })}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {t(TYPE_KEY[r.cronType] ?? 'runs.type.other')}
                    </Text>
                    <Button size="small" icon={<FileTextOutlined />} onClick={() => setAperta({ cron: cronOf(r), run: r })}>
                      {t('runs.logs')}
                    </Button>
                  </div>
                ))}
              </Space>
            </div>
          )}

          {filtrate.length === 0 ? (
            <Empty style={{ padding: '48px 0' }} description={t('runs.empty')} />
          ) : (
            <Table
              size="small"
              rowKey="key"
              columns={columns}
              dataSource={filtrate}
              pagination={filtrate.length > 30 ? { pageSize: 30, showSizeChanger: false } : false}
              onRow={(r) => ({ style: { cursor: 'pointer' }, onDoubleClick: () => setAperta({ cron: cronOf(r), run: r }) })}
            />
          )}

          {senzaRun.length > 0 && (
            <div style={{ ...PANEL_CARD, marginTop: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                {t('runs.noRunTitle', { n: senzaRun.length })}
              </Text>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {senzaRun.map((c) => (
                  <Space key={c.key} size={8} wrap>
                    <span style={{ fontFamily: MONO }}>{c.name}</span>
                    {c.accountLabel && (
                      <Tag bordered={false} color={c.color ?? undefined} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                        {c.accountLabel}
                      </Tag>
                    )}
                    {/* Spento di proposito ≠ non è partito: due situazioni con due destinatari diversi. */}
                    <Tag bordered={false} color={c.enabled ? 'warning' : 'default'} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                      {c.enabled ? t('runs.neverRan') : t('runs.disabled')}
                    </Tag>
                    {c.scheduleMinutes && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {fmtSchedule(`${c.scheduleMinutes}m`, t)}
                      </Text>
                    )}
                    {c.error && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {c.error}
                      </Text>
                    )}
                  </Space>
                ))}
              </Space>
            </div>
          )}

          {lastUpdated && (
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 12 }}>
              {refreshing ? t('runs.refreshing') : t('runs.updated', { ago: fmtAgo(lastUpdated, t) })}
            </Text>
          )}
        </>
      )}

      <RunLogsDrawer
        open={Boolean(aperta)}
        onClose={() => setAperta(null)}
        cron={aperta?.cron}
        run={aperta?.run}
        t={t}
        lang={lang}
      />
    </>
  )
}
