import { useMemo, useState } from 'react'
import { Table, Tag, Space, Typography, Segmented, Switch, Input, Alert, Skeleton, Button, Tooltip } from 'antd'
import { FileTextOutlined, SyncOutlined, BarsOutlined, DashboardOutlined } from '@ant-design/icons'
import { PageIntro, HeroRow, HeroStat, Section, Toolbar, EmptyState } from './pageKit.jsx'
import { usePoll } from '../usePoll.js'
import { fmtAgo, fmtMs, fmtSchedule } from '../format.js'
import { familyPrefixes, splitFamily } from '../serviceName.js'
import { levelColor, MONO, FONT, SPACE } from '../theme.js'
import { OUTCOME_TAG, runElapsed, useTick } from '../components/runBits.jsx'
import { matchesAny, isFiltering } from '../filters.js'
import RunTimeline from '../components/RunTimeline.jsx'
import RunLogsDrawer from '../components/RunLogsDrawer.jsx'
import PollStatus from '../components/PollStatus.jsx'

const { Text } = Typography

// Pagina ESECUZIONI: cosa sta girando adesso, e com'è finita ogni singola corsa di prima.
//
// Perché non basta la card di un cron: la card risponde «il cron va / è saltato», che è la domanda di
// un watchdog. Su un job LUNGO (uno scraper che macina un'ora) le domande vere sono altre due, e
// nessuna vista le copriva: *sta girando in questo momento, e da quanto?* e *quella di stanotte com'è
// andata, e dove sono i suoi log?*. Uno stato aggregato non le distingue nemmeno: un cron «up» può
// essere fermo, a metà corsa, o appena finito male con l'exit code a zero.
//
// DUE VISTE, e non è indecisione: la timeline risponde guardando (chi gira, chi è più lento del
// solito, dove c'è un buco), la lista risponde leggendo (tutte le corse di tutti in ordine di orario,
// filtrabili per «solo problemi»). La prima è quella che si apre la mattina, la seconda quella che
// serve quando cerchi una corsa precisa. La scelta resta dov'è: è una preferenza, non uno stato.
//
// I cron che nella finestra non hanno corso stanno in fondo, sempre: «non è partito» è una risposta, ed
// è quella che una vista di esecuzioni, per definizione, non potrebbe dare.
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

// Le run dell'orchestratore raggruppate per flow, nella stessa forma dei cron AWS: così la timeline è
// una sola vista e non «i cron, e poi in fondo anche gli altri». Pura/testabile.
export function prefectAsCrons(prefect = null, t = (k) => k) {
  const perFlow = new Map()
  for (const r of prefect?.runs ?? []) {
    const nome = r.cron ?? '—'
    if (!perFlow.has(nome)) perFlow.set(nome, [])
    perFlow.get(nome).push(r)
  }
  return [...perFlow.entries()].map(([nome, runs]) => ({
    key: `prefect/${nome}`,
    name: nome,
    type: 'prefect',
    accountLabel: t('runs.type.prefect'),
    color: null,
    enabled: true,
    // L'orchestratore non dichiara una cadenza leggibile qui: meglio niente che un numero inventato.
    scheduleMinutes: null,
    nextRunAt: null,
    runs: runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)),
    running: runs.filter((r) => r.running).length,
    lastOutcome: runs.find((r) => !r.running)?.outcome ?? (runs.length ? 'running' : null),
    lastRunAt: runs[0]?.startedAt ?? null,
  }))
}

// Il tipo di sorgente in una parola: dice DA DOVE arriva la riga, che su questa pagina è metà del
// contesto (un job dell'orchestratore non ha né exit code né log group).
const TYPE_KEY = { lambda: 'runs.type.lambda', 'ecs-scheduled': 'runs.type.ecs', prefect: 'runs.type.prefect' }

// Le colonne della tabella, in una funzione a parte: così si possono rendere (e quindi provare) fuori
// dal browser, che in questo repo è l'unico modo di provare della UI: i test girano su `node --test`,
// senza DOM. Una colonna che lancia su una run senza durata è una pagina bianca, e va scoperta qui.
export function runColumns({ t = (k) => k, onOpen = () => {}, onPickCron = null, prefissi = null } = {}) {
  return [
    {
      title: t('runs.col.cron'),
      dataIndex: 'cronName',
      render: (name, r) => {
        // Testa condivisa muta + coda in evidenza, come nella timeline e nelle card dei servizi: i cron
        // hanno tutti la stessa testa, e leggerla trenta volte è rumore che schiaccia la parte utile.
        const { family, tail } = splitFamily(name, prefissi)
        const nome = (
          <>
            {family && <span style={{ opacity: 0.42 }}>{family}</span>}
            {tail}
          </>
        )
        return (
        <Space size={SPACE.sm} wrap>
          {/* Il nome apre TUTTE le esecuzioni di quel cron: nella vista d'insieme ognuno porta le sue
              ultime poche, e «fammi vedere solo questo, più a fondo» è la mossa naturale dopo aver
              visto una riga rossa. */}
          {onPickCron && r.cronKey ? (
            <Button type="link" size="small" style={{ padding: 0, fontFamily: MONO, height: 'auto' }} onClick={() => onPickCron(r.cronKey)}>
              {nome}
            </Button>
          ) : (
            <span style={{ fontFamily: MONO }}>{nome}</span>
          )}
          {r.accountLabel && (
            <Tag bordered={false} color={r.accountColor ?? undefined} style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
              {r.accountLabel}
            </Tag>
          )}
          <Text type="secondary" style={{ fontSize: FONT.micro }}>
            {t(TYPE_KEY[r.cronType] ?? 'runs.type.other')}
          </Text>
        </Space>
        )
      },
    },
    {
      title: t('runs.col.started'),
      dataIndex: 'startedAt',
      width: 170,
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
      width: 110,
      align: 'right',
      render: (_, r) => {
        const ms = runElapsed(r)
        if (ms == null) return '—'
        // Su una run in corso il numero CRESCE: è il segnale che il lavoro sta avvenendo, e va detto
        // che non è una durata finale.
        return r.running ? (
          <Space size={4}>
            <SyncOutlined spin style={{ color: levelColor('info'), fontSize: 10 }} />
            <span>{fmtMs(ms)}</span>
          </Space>
        ) : (
          fmtMs(ms)
        )
      },
    },
    {
      title: t('runs.col.outcome'),
      width: 220,
      render: (_, r) => (
        <Space size={SPACE.sm} wrap>
          {OUTCOME_TAG(r.outcome, t)}
          {/* Il MOTIVO, quando c'è: «uscita 137 · memoria esaurita» è la riga che chiude la domanda
              senza aprire i log. Un exit code da solo non la chiude, quindi va accompagnato. */}
          {r.exitCode != null && r.exitCode !== 0 && (
            <Text type="secondary" style={{ fontSize: FONT.micro }}>
              {t('runs.exit', { code: r.exitCode })}
            </Text>
          )}
          {r.timedOut && (
            <Text type="secondary" style={{ fontSize: FONT.micro }}>
              {t('runs.timedOut')}
            </Text>
          )}
          {r.stopReason && /OutOfMemory|OOMKilled/i.test(r.stopReason) && (
            <Text type="secondary" style={{ fontSize: FONT.micro }}>
              {t('runs.oom')}
            </Text>
          )}
          {r.state && r.cronType === 'prefect' && (
            <Text type="secondary" style={{ fontSize: FONT.micro }}>
              {r.state}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: '',
      width: 90,
      align: 'right',
      render: (_, r) => (
        <Button size="small" type="text" icon={<FileTextOutlined />} onClick={() => onOpen(r)}>
          {t('runs.logs')}
        </Button>
      ),
    },
  ]
}

export default function RunsPage({ t = (k) => k, lang, refreshKey, accountFilter = [] }) {
  const [minutes, setMinutes] = useState(1440)
  // La vista scelta persiste: e' una preferenza di chi guarda, e riportarla a «timeline» a ogni
  // ricarica e' una piccola offesa quotidiana. Letta con la guardia perche' questo modulo viene reso
  // anche fuori dal browser (prova di rendering senza DOM), dove `localStorage` non esiste.
  const [vista, setVista] = useState(() => (typeof localStorage === 'undefined' ? 'timeline' : localStorage.getItem('dadaguard-runs-view') ?? 'timeline'))
  const [soloProblemi, setSoloProblemi] = useState(false)
  const [query, setQuery] = useState('')
  const [aperta, setAperta] = useState(null) // { cron, run } della run di cui si leggono i log
  // Cron scelto: la vista passa da «le ultime di tutti» a «tutte le sue». È il server a leggere più a
  // fondo (vedi runsOverview): filtrare lato client non aggiungerebbe le run che non sono state chieste.
  const [soloCron, setSoloCron] = useState(null)

  const scegliVista = (v) => {
    setVista(v)
    if (typeof localStorage !== 'undefined') localStorage.setItem('dadaguard-runs-view', v)
  }

  // Polling educato (in pausa a tab nascosto, rinfresca al rientro): una run in corso va vista
  // avanzare, ma senza chiamare AWS quando nessuno guarda. `refreshKey` = il tasto Aggiorna globale.
  const { data, loading, error, refreshing, lastUpdated } = usePoll(
    `/api/runs?minutes=${minutes}&lang=${lang}${soloCron ? `&cron=${encodeURIComponent(soloCron)}&limit=25` : ''}&k=${refreshKey ?? 0}`,
    { intervalMs: 30_000 },
  )

  const crons = useMemo(
    () => (data?.crons ?? []).filter((c) => matchesAny(c.account, accountFilter)),
    [data, accountFilter],
  )
  // L'orchestratore non ha account AWS: con un filtro per account attivo le sue run non appartengono a
  // nessuno dei selezionati e sparirebbero. Si nasconde tutta la sorgente, invece di mostrarla a metà.
  const prefect = !isFiltering(accountFilter) && !soloCron ? data?.prefect : null

  const tutti = useMemo(() => [...crons, ...prefectAsCrons(prefect, t)], [crons, prefect, t])
  const righe = useMemo(() => flattenRuns(crons, prefect), [crons, prefect])
  const inCorso = useMemo(() => righe.filter((r) => r.running), [righe])
  // L'orologio batte solo se c'è una run viva: su una pagina di corse finite i numeri sono fermi.
  useTick(inCorso.length > 0)

  const cercato = (nome) => {
    const q = query.trim().toLowerCase()
    return !q || String(nome ?? '').toLowerCase().includes(q)
  }
  const haProblemi = (c) => (c.runs ?? []).some((r) => r.outcome === 'failed' || r.outcome === 'unknown')

  // Timeline: righe di cron. Chi sta girando va in cima, in una sezione sua.
  const conRun = useMemo(
    () => tutti.filter((c) => (c.runs ?? []).length > 0 && cercato(c.name) && (!soloProblemi || haProblemi(c))),
    [tutti, query, soloProblemi],
  )
  const vive = useMemo(() => conRun.filter((c) => c.running > 0), [conRun])
  const ferme = useMemo(() => conRun.filter((c) => !c.running), [conRun])

  // Lista: righe di esecuzione.
  const filtrate = useMemo(
    () =>
      righe.filter(
        (r) => (!soloProblemi || r.outcome === 'failed' || r.outcome === 'unknown') && cercato(r.cronName),
      ),
    [righe, soloProblemi, query],
  )

  // Cron che nella finestra non hanno corso: «non è partito» è una risposta, e una vista di esecuzioni
  // non può darla per definizione.
  const senzaRun = useMemo(() => crons.filter((c) => (c.runs ?? []).length === 0 && cercato(c.name)), [crons, query])
  const prossima = useMemo(() => crons.filter((c) => c.nextRunAt).sort((a, b) => a.nextRunAt - b.nextRunAt)[0] ?? null, [crons])
  const falliteFinestra = righe.filter((r) => r.outcome === 'failed').length

  const cronOf = (riga) => tutti.find((c) => c.key === riga.cronKey) ?? { key: riga.cronKey, name: riga.cronName }
  const apri = (cron, run) => setAperta({ cron, run })
  // I prefissi di famiglia si contano sul gruppo mostrato: la testa muta funziona solo se è la stessa
  // su tutte le righe.
  const prefissi = useMemo(() => familyPrefixes(tutti.map((c) => c.name)), [tutti])
  const columns = useMemo(
    () => runColumns({ t, onOpen: (r) => apri(cronOf(r), r), onPickCron: soloCron ? null : setSoloCron, prefissi }),
    [t, tutti, soloCron, prefissi],
  )

  return (
    <>
      <PageIntro
        title={t('runs.title')}
        desc={t('runs.desc')}
        extra={
          <Toolbar>
            <PollStatus lastUpdated={lastUpdated} refreshing={refreshing} t={t} />
            {soloCron && (
              <Tag closable color="processing" onClose={() => setSoloCron(null)} style={{ marginInlineEnd: 0 }}>
                {t('runs.onlyCron', { cron: soloCron.split('/').slice(1).join('/') })}
              </Tag>
            )}
            <Segmented
              size="small"
              value={vista}
              onChange={scegliVista}
              options={[
                { value: 'timeline', icon: <DashboardOutlined />, title: t('runs.view.timeline') },
                { value: 'lista', icon: <BarsOutlined />, title: t('runs.view.list') },
              ]}
            />
            <Segmented size="small" value={minutes} onChange={setMinutes} options={WINDOWS} />
            <Space size={SPACE.xs}>
              <Switch size="small" checked={soloProblemi} onChange={setSoloProblemi} />
              <Text style={{ fontSize: FONT.small }}>{t('runs.onlyProblems')}</Text>
            </Space>
            <Input.Search
              allowClear
              size="small"
              placeholder={t('runs.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 170 }}
            />
          </Toolbar>
        }
      />

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: SPACE.md }} />}
      {(data?.problems ?? []).map((p) => (
        <Alert key={p.account} type="warning" showIcon message={`${p.account}: ${p.error}`} style={{ marginBottom: SPACE.sm }} />
      ))}
      {/* Sorgente configurata ma non raggiungibile: dirlo, altrimenti «nessun job dell'orchestratore»
          si legge come «nessuno sta girando», che è la bugia peggiore su questa pagina. */}
      {data?.prefect?.error && (
        <Alert type="warning" showIcon message={`Prefect: ${data.prefect.error}`} style={{ marginBottom: SPACE.sm }} />
      )}
      {data?.truncated && <Alert type="info" showIcon message={t('runs.tooMany')} style={{ marginBottom: SPACE.sm }} />}

      {loading && !data ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <>
          <HeroRow>
            <HeroStat
              label={t('runs.hero.running')}
              value={inCorso.length}
              color={inCorso.length ? levelColor('info') : undefined}
            />
            <HeroStat
              label={t('runs.hero.failed')}
              value={falliteFinestra}
              color={falliteFinestra ? levelColor('bad') : undefined}
            />
            <HeroStat label={t('runs.hero.crons')} value={crons.filter((c) => c.enabled).length} />
            {prossima && (
              <HeroStat
                label={t('runs.hero.next')}
                size={FONT.lead}
                value={new Date(prossima.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                hint={prossima.name}
              />
            )}
          </HeroRow>

          {vista === 'timeline' ? (
            <>
              {/* In corso ADESSO, in cima e in una sezione sua: è la domanda per cui si apre questa
                  pagina, e in mezzo alle corse di ieri si perderebbe. */}
              {vive.length > 0 && (
                <Section title={t('runs.nowTitle')} tone="live" style={{ marginBottom: SPACE.lg }}>
                  <RunTimeline crons={vive} t={t} onOpenRun={apri} onPickCron={soloCron ? null : setSoloCron} />
                </Section>
              )}
              {ferme.length > 0 ? (
                <Section title={t('runs.allTitle')} aside={<Text type="secondary" style={{ fontSize: FONT.micro }}>{t('runs.widthIsDuration')}</Text>}>
                  <RunTimeline crons={ferme} t={t} onOpenRun={apri} onPickCron={soloCron ? null : setSoloCron} />
                </Section>
              ) : (
                vive.length === 0 && <EmptyState description={t('runs.empty')} />
              )}
            </>
          ) : filtrate.length === 0 ? (
            <EmptyState description={t('runs.empty')} />
          ) : (
            <Section title={t('runs.listTitle')}>
              <Table
                className="dg-sticky"
                size="small"
                rowKey="key"
                columns={columns}
                dataSource={filtrate}
                pagination={filtrate.length > 40 ? { pageSize: 40, showSizeChanger: false, size: 'small' } : false}
                onRow={(r) => ({ style: { cursor: 'pointer' }, onDoubleClick: () => apri(cronOf(r), r) })}
              />
            </Section>
          )}

          {senzaRun.length > 0 && (
            <Section title={t('runs.noRunTitle', { n: senzaRun.length })} style={{ marginTop: SPACE.lg }}>
              <Space direction="vertical" size={SPACE.xs} style={{ width: '100%' }}>
                {senzaRun.map((c) => (
                  <Space key={c.key} size={SPACE.sm} wrap>
                    <span style={{ fontFamily: MONO, fontSize: FONT.small }}>{c.name}</span>
                    {c.accountLabel && (
                      <Tag bordered={false} color={c.color ?? undefined} style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                        {c.accountLabel}
                      </Tag>
                    )}
                    {/* Spento di proposito ≠ non è partito: due situazioni con due destinatari diversi. */}
                    <Tag bordered={false} color={c.enabled ? 'warning' : 'default'} style={{ marginInlineEnd: 0, fontSize: 10.5 }}>
                      {c.enabled ? t('runs.neverRan') : t('runs.disabled')}
                    </Tag>
                    {c.scheduleMinutes && (
                      <Text type="secondary" style={{ fontSize: FONT.micro }}>
                        {fmtSchedule(`${c.scheduleMinutes}m`, t)}
                      </Text>
                    )}
                    {c.error && (
                      <Text type="secondary" style={{ fontSize: FONT.micro }}>
                        {c.error}
                      </Text>
                    )}
                  </Space>
                ))}
              </Space>
            </Section>
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
