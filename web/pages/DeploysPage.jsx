import { useEffect, useMemo, useState } from 'react'
import { Alert, Empty, Typography, Space, Badge, Tag, Segmented, Select, Button, Skeleton, Tooltip, Drawer } from 'antd'
import { ClockCircleOutlined } from '@ant-design/icons'
import { PageIntro, PANEL_CARD, HeroStat, HeroRow } from './pageKit.jsx'

const { Text } = Typography
const MONO = 'ui-monospace, SFMono-Regular, monospace'

// Stato build CodeBuild → colore (stripe + tag + tick del trend) + etichetta i18n.
const STATUS = {
  IN_PROGRESS: { color: '#1677ff', tag: 'processing', key: 'deploys.running' },
  SUCCEEDED: { color: '#52c41a', tag: 'success', key: 'deploys.ok' },
  FAILED: { color: '#cf1322', tag: 'error', key: 'deploys.failed' },
  FAULT: { color: '#cf1322', tag: 'error', key: 'deploys.failed' },
  TIMED_OUT: { color: '#cf1322', tag: 'error', key: 'deploys.failed' },
  STOPPED: { color: '#8c8c8c', tag: 'default', key: 'deploys.stopped' },
}
const FALLBACK = { color: '#8c8c8c', tag: 'default', key: null }
const FAILED_STATUSES = ['FAILED', 'FAULT', 'TIMED_OUT']
const PERIOD_MS = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6 }
const TREND_MAX = 10 // build mostrate nel mini-trend a pallini

// "quanto fa": min → ore → giorni → settimane, così non si vedono mai "419h fa".
function fmtAgo(from, t) {
  if (!from) return ''
  const min = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60000))
  if (min < 1) return t('deploys.now')
  if (min < 60) return t('deploys.minAgo', { m: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('deploys.hAgo', { h, m: min % 60 })
  const d = Math.floor(h / 24)
  if (d < 7) return t('deploys.dAgo', { d, h: h % 24 })
  return t('deploys.wAgo', { w: Math.floor(d / 7), d: d % 7 })
}

function fmtDur(ms) {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// Nome fase leggibile: DOWNLOAD_SOURCE → "Download source".
function phaseLabel(type = '') {
  return type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ')
}
const phaseColor = (status) => (status ? (STATUS[status] ?? FALLBACK).color : '#8c8c8c')

function matchStatus(b, f) {
  if (f === 'running') return b.inProgress
  if (f === 'failed') return FAILED_STATUSES.includes(b.status)
  if (f === 'ok') return b.status === 'SUCCEEDED'
  return true
}

function matchPeriod(b, f) {
  if (f === 'all' || !PERIOD_MS[f] || !b.startedAt) return true
  return Date.now() - new Date(b.startedAt).getTime() <= PERIOD_MS[f]
}

// Raggruppa le build per servizio, dal più recente. Per ogni servizio calcola l'ultima build,
// i conteggi ok/fallito e la lista (per il trend). In-corso prima, poi ordine alfabetico.
function groupByService(builds) {
  const map = new Map()
  for (const b of builds) {
    const svc = b.service || b.project || '—'
    if (!map.has(svc)) map.set(svc, [])
    map.get(svc).push(b)
  }
  const groups = []
  for (const [service, arr] of map) {
    const sorted = [...arr].sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0))
    groups.push({
      service,
      builds: sorted,
      latest: sorted[0],
      ok: sorted.filter((x) => x.status === 'SUCCEEDED').length,
      failed: sorted.filter((x) => FAILED_STATUSES.includes(x.status)).length,
    })
  }
  return groups.sort((a, b) => {
    const ai = a.latest.inProgress ? 0 : 1
    const bi = b.latest.inProgress ? 0 : 1
    if (ai !== bi) return ai - bi
    return a.service.localeCompare(b.service)
  })
}

// Mini-trend: pallini colorati per stato, dal più vecchio (sx) al più recente (dx). Mostra le ultime N.
function DeployTrend({ builds, t }) {
  const recent = builds.slice(0, TREND_MAX).reverse()
  if (recent.length < 2) return null
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }} aria-hidden>
      {recent.map((b, i) => {
        const st = STATUS[b.status] ?? FALLBACK
        return (
          <Tooltip key={i} title={`#${b.number} · ${t(st.key ?? 'deploys.stopped')}`}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: st.color, opacity: b.inProgress ? 0.55 : 1 }} />
          </Tooltip>
        )
      })}
    </span>
  )
}

// Blocco sinistro condiviso da riga-servizio e riga-build: stato + nome + #num + trigger, sotto
// commit·durata (o fase, se in corso), e — se fallita — la riga rossa "Fallita in FASE: motivo".
function BuildInfo({ b, name, t }) {
  const sub = [b.commit, b.inProgress ? (b.phase ? b.phase.toLowerCase() : null) : fmtDur(b.durationMs)]
    .filter(Boolean)
    .join(' · ')
  const st = STATUS[b.status] ?? FALLBACK
  const failed = FAILED_STATUSES.includes(b.status)
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <Space size={8} wrap style={{ rowGap: 2 }}>
        {b.inProgress && <Badge status="processing" />}
        <Text strong style={{ whiteSpace: 'nowrap' }}>
          {name}
        </Text>
        {st.key && (
          <Tag color={st.tag} bordered={false} style={{ marginInlineEnd: 0 }}>
            {t(st.key)}
          </Tag>
        )}
        {b.number != null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            #{b.number}
          </Text>
        )}
        {b.trigger && (
          <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '17px', padding: '0 6px', opacity: 0.85 }}>
            {t(`deploys.trigger.${b.trigger}`)}
          </Tag>
        )}
      </Space>
      {sub && (
        <div>
          <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO }}>
            {sub}
          </Text>
        </div>
      )}
      {failed && (b.failPhase || b.failReason) && (
        <div style={{ marginTop: 2, minWidth: 0 }}>
          <Tooltip title={b.failReason || undefined}>
            <Text style={{ fontSize: 12, color: '#ff7875', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {b.failPhase ? t('deploys.failedIn', { phase: phaseLabel(b.failPhase) }) : t('deploys.failed')}
              {b.failReason ? `: ${b.failReason}` : ''}
            </Text>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

// Wrapper cliccabile per riga-servizio/riga-build → apre il drawer di dettaglio.
function ClickableRow({ b, onOpen, t, children }) {
  const st = STATUS[b.status] ?? FALLBACK
  return (
    <div
      role="button"
      tabIndex={0}
      title={t('deploys.openDetail')}
      onClick={() => onOpen(b)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(b))}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '8px 12px',
        borderRadius: 8,
        borderLeft: `3px solid ${st.color}`,
        background: b.inProgress ? 'rgba(22,119,255,0.10)' : 'rgba(128,128,128,0.05)',
        cursor: 'pointer',
      }}
    >
      {children}
    </div>
  )
}

// Riga per-servizio (default): ultima build a sinistra (con eventuale motivo del fallimento),
// a destra mini-trend + tasso di successo (ok/decisi) + "quanto fa". Click → dettaglio.
function ServiceRow({ g, onOpen, t }) {
  const b = g.latest
  const when = b.inProgress ? fmtAgo(b.startedAt, t) : fmtAgo(b.endedAt, t)
  const decided = g.ok + g.failed
  const rateColor = g.failed ? (g.ok ? '#faad14' : '#ff4d4f') : '#52c41a'
  // Cloudflare registra solo i rollout RIUSCITI → trend/tasso di successo non hanno senso: li nascondo.
  const isCf = b.provider === 'cloudflare'
  return (
    <ClickableRow b={b} onOpen={onOpen} t={t}>
      <BuildInfo b={b} name={g.service} t={t} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, whiteSpace: 'nowrap' }}>
        {!isCf && <DeployTrend builds={g.builds} t={t} />}
        {!isCf && decided > 0 && (
          <Tooltip title={t('deploys.rateTip', { ok: g.ok, total: decided })}>
            <Text style={{ fontSize: 13, fontWeight: 600, color: rateColor, fontVariantNumeric: 'tabular-nums' }}>
              {g.ok}/{decided}
            </Text>
          </Tooltip>
        )}
        <Text type="secondary" style={{ fontSize: 11, minWidth: 62, textAlign: 'right' }}>
          <ClockCircleOutlined style={{ marginInlineEnd: 3 }} />
          {when}
        </Text>
      </div>
    </ClickableRow>
  )
}

// Riga della singola build (vista "storico completo"): info a sinistra, "quanto fa" a destra. Click → dettaglio.
function BuildRow({ b, onOpen, t }) {
  const when = b.inProgress ? fmtAgo(b.startedAt, t) : fmtAgo(b.endedAt, t)
  return (
    <ClickableRow b={b} onOpen={onOpen} t={t}>
      <BuildInfo b={b} name={b.service} t={t} />
      <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
        <ClockCircleOutlined style={{ marginInlineEnd: 3 }} />
        {when}
      </Text>
    </ClickableRow>
  )
}

// Timeline delle fasi CodeBuild nel drawer: pallino stato + nome fase + durata; per le fasi fallite,
// il messaggio d'errore sotto (monospace).
function PhaseTimeline({ phases = [] }) {
  if (!phases.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {phases.map((p, i) => (
        <div key={i}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: phaseColor(p.status), flex: 'none' }} />
            <Text style={{ flex: 1 }}>{phaseLabel(p.type || '')}</Text>
            <Text type="secondary" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              {fmtDur(p.durationMs)}
            </Text>
          </div>
          {p.message && (
            <Text style={{ display: 'block', marginInlineStart: 16, fontSize: 12, fontFamily: MONO, color: '#ff7875', whiteSpace: 'pre-wrap' }}>
              {p.message}
            </Text>
          )}
        </div>
      ))}
    </div>
  )
}

function MetaLine({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
      <Text type="secondary" style={{ minWidth: 78 }}>
        {label}
      </Text>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  )
}

// Drawer di dettaglio di UNA build: stato, meta (account/commit/trigger/durata/quando), motivo del
// fallimento, timeline delle fasi e link diretto ai log su CloudWatch. Tutto già nei dati, zero fetch.
function DeployBuildDrawer({ build, accountLabel, onClose, t }) {
  const b = build ?? {}
  const st = STATUS[b.status] ?? FALLBACK
  const failed = FAILED_STATUSES.includes(b.status)
  return (
    <Drawer
      open={!!build}
      onClose={onClose}
      width={520}
      title={
        <Space size={8} wrap>
          <Text strong>{b.service}</Text>
          {b.number != null && <Text type="secondary">#{b.number}</Text>}
          {st.key && (
            <Tag color={st.tag} bordered={false}>
              {t(st.key)}
            </Tag>
          )}
        </Space>
      }
    >
      {build && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {accountLabel && <MetaLine label={t('deploys.account')}>{accountLabel}</MetaLine>}
            {b.commit && (
              <MetaLine label="commit">
                <Text style={{ fontFamily: MONO }}>{b.commit}</Text>
              </MetaLine>
            )}
            {b.trigger && <MetaLine label={t('deploys.triggerLabel')}>{t(`deploys.trigger.${b.trigger}`)}</MetaLine>}
            {b.author && <MetaLine label={t('deploys.authorLabel')}>{b.author}</MetaLine>}
            {!(b.provider === 'cloudflare') && (
              <MetaLine label={t('deploys.durationLabel')}>{b.inProgress ? '—' : fmtDur(b.durationMs) || '—'}</MetaLine>
            )}
            <MetaLine label={t('deploys.whenLabel')}>{fmtAgo(b.inProgress ? b.startedAt : b.endedAt, t) || '—'}</MetaLine>
          </Space>

          {failed && b.failReason && (
            <Alert
              type="error"
              showIcon
              message={b.failPhase ? t('deploys.failedIn', { phase: phaseLabel(b.failPhase) }) : t('deploys.failed')}
              description={<span style={{ fontFamily: MONO, fontSize: 12 }}>{b.failReason}</span>}
            />
          )}

          {b.phases?.length > 0 && (
            <div>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                {t('deploys.phases')}
              </Text>
              <PhaseTimeline phases={b.phases} />
            </div>
          )}

          {b.logsUrl ? (
            <Button type="primary" href={b.logsUrl} target="_blank" rel="noreferrer" block>
              {t('deploys.openLogs')}
            </Button>
          ) : b.deployUrl ? (
            <Button type="primary" href={b.deployUrl} target="_blank" rel="noreferrer" block>
              {t('deploys.openCf')}
            </Button>
          ) : null}
        </Space>
      )}
    </Drawer>
  )
}

// Pillole conteggio stato nell'header dell'account (solo quelle > 0).
function CountPills({ builds }) {
  const running = builds.filter((b) => b.inProgress).length
  const ok = builds.filter((b) => b.status === 'SUCCEEDED').length
  const failed = builds.filter((b) => FAILED_STATUSES.includes(b.status)).length
  return (
    <Space size={4}>
      {running > 0 && <Badge count={running} color="#1677ff" />}
      {ok > 0 && <Badge count={ok} color="#52c41a" />}
      {failed > 0 && <Badge count={failed} color="#cf1322" />}
    </Space>
  )
}

// Griglia responsiva: 1 colonna su schermo stretto, 2+ su schermo largo (riempie la larghezza, niente
// buco al centro delle righe). `auto-fit` → un solo elemento occupa comunque tutta la riga.
// `min(100%, 560px)` invece di `560px` secco → niente overflow orizzontale sotto i 560px (schermi stretti).
const ROW_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 560px), 1fr))', gap: 6, marginTop: 12 }

// Sezione a tutta larghezza per un account. Default: una riga per servizio (riepilogo affidabilità);
// toggle "storico completo" → tutte le build. Account senza progetti di deploy → riga compatta.
function AccountSection({ acc, all, filtered, anyFilter, expanded, onToggle, onOpen, t }) {
  if (acc.error) {
    return (
      <div style={PANEL_CARD}>
        <Space>
          {acc.color && <Badge color={acc.color} />}
          <Text strong>{acc.label}</Text>
        </Space>
        <Alert type="warning" showIcon style={{ marginTop: 8 }} message={acc.error} />
      </div>
    )
  }

  const noProjects = acc.noProjects && all.length === 0
  const groups = filtered.length ? groupByService(filtered) : []

  return (
    <div style={PANEL_CARD}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Space>
          {acc.color && <Badge color={acc.color} />}
          <Text strong style={{ fontSize: 15 }}>
            {acc.label}
          </Text>
          {!noProjects && groups.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('deploys.serviceCount', { n: groups.length })}
            </Text>
          )}
        </Space>
        <Space size={12}>
          <CountPills builds={all} />
          {filtered.length > 0 && (
            <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={onToggle}>
              {expanded ? t('deploys.summary') : t('deploys.history', { n: filtered.length })}
            </Button>
          )}
        </Space>
      </div>

      {noProjects ? (
        <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          {t('deploys.noProjects')}
        </Text>
      ) : filtered.length === 0 ? (
        <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          {anyFilter ? t('deploys.noneFiltered') : t('deploys.none')}
        </Text>
      ) : expanded ? (
        <div style={ROW_GRID}>
          {filtered.map((b) => (
            <BuildRow key={b.id || `${b.project}:${b.number}`} b={b} onOpen={onOpen} t={t} />
          ))}
        </div>
      ) : (
        <div style={ROW_GRID}>
          {groups.map((g) => (
            <ServiceRow key={g.service} g={g} onOpen={onOpen} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function DeploysSkeleton() {
  return (
    <>
      <HeroRow>
        {[70, 60, 70].map((w, i) => (
          <Skeleton.Button key={i} active size="large" style={{ width: w, height: 40 }} />
        ))}
      </HeroRow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {[3, 1].map((rows, i) => (
          <div key={i} style={PANEL_CARD}>
            <Skeleton active title={{ width: 170 }} paragraph={{ rows, width: '100%' }} />
          </div>
        ))}
      </div>
    </>
  )
}

// Pagina Deploy: build CodeBuild di deploy (`cato-*-*-deploy`) per account — cosa sta uscendo ora e
// com'è andata (per servizio: ultima build, tasso di successo, trend). Click su una build → dettaglio
// (fasi + motivo del fallimento + log CloudWatch). Read-only, on-demand. Mostra TUTTI gli account risolti.
export default function DeploysPage({ t = (k) => k, lang }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [periodFilter, setPeriodFilter] = useState('all')
  const [serviceFilter, setServiceFilter] = useState('all')
  const [expanded, setExpanded] = useState(() => new Set())
  const [selected, setSelected] = useState(null) // { build, accountLabel } aperto nel drawer

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/deploys?lang=${lang}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [lang])

  // Tutti gli account risolti, ordinati: quelli con build (o in errore) prima, i "senza deploy" in coda;
  // a parità, per label.
  const accounts = useMemo(() => {
    const list = data ? Object.entries(data) : []
    return list.sort(([, a], [, b]) => {
      const av = a.error || (a.builds?.length ?? 0) > 0 ? 0 : 1
      const bv = b.error || (b.builds?.length ?? 0) > 0 ? 0 : 1
      if (av !== bv) return av - bv
      return String(a.label ?? '').localeCompare(String(b.label ?? ''))
    })
  }, [data])

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('deploys.filter.all') },
      { value: 'running', label: t('deploys.filter.running') },
      { value: 'failed', label: t('deploys.filter.failed') },
      { value: 'ok', label: t('deploys.filter.ok') },
    ],
    [t],
  )
  const periodOptions = useMemo(
    () => [
      { value: 'all', label: t('deploys.period.all') },
      { value: '24h', label: t('deploys.period.24h') },
      { value: '7d', label: t('deploys.period.7d') },
      { value: '30d', label: t('deploys.period.30d') },
    ],
    [t],
  )
  const serviceOptions = useMemo(() => {
    const set = new Set()
    for (const acc of data ? Object.values(data) : []) for (const b of acc.builds ?? []) if (b.service) set.add(b.service)
    return [{ value: 'all', label: t('deploys.allServices') }, ...[...set].sort().map((s) => ({ value: s, label: s }))]
  }, [data, t])

  const anyFilter = statusFilter !== 'all' || periodFilter !== 'all' || serviceFilter !== 'all'
  const toggleExpand = (key) =>
    setExpanded((prev) => {
      const n = new Set(prev)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })

  const filterBuilds = (list) =>
    list
      .filter((b) => matchStatus(b, statusFilter))
      .filter((b) => matchPeriod(b, periodFilter))
      .filter((b) => serviceFilter === 'all' || b.service === serviceFilter)

  const hero = useMemo(() => {
    const all = accounts.flatMap(([, acc]) => acc.builds ?? [])
    return {
      running: all.filter((b) => b.inProgress || b.status === 'IN_PROGRESS').length,
      ok: all.filter((b) => b.status === 'SUCCEEDED').length,
      failed: all.filter((b) => FAILED_STATUSES.includes(b.status)).length,
    }
  }, [accounts])

  return (
    <>
      <PageIntro
        title={t('deploys.title')}
        desc={t('deploys.desc')}
        extra={
          <Space wrap size={8}>
            <Segmented size="small" value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
            <Segmented size="small" value={periodFilter} onChange={setPeriodFilter} options={periodOptions} />
            <Select size="small" value={serviceFilter} onChange={setServiceFilter} options={serviceOptions} style={{ minWidth: 150 }} />
          </Space>
        }
      />

      {loading && !data && <DeploysSkeleton />}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      {data && accounts.length === 0 && <Empty description={t('deploys.noAccounts')} style={{ marginTop: 24 }} />}

      {accounts.length > 0 && (
        <>
          <HeroRow>
            {hero.running > 0 && <HeroStat label={t('deploys.running')} value={hero.running} color="#1677ff" size={18} />}
            <HeroStat label={t('deploys.ok')} value={hero.ok} color={hero.ok ? '#52c41a' : undefined} size={18} />
            <HeroStat label={t('deploys.failed')} value={hero.failed} color={hero.failed ? '#ff4d4f' : undefined} size={18} />
          </HeroRow>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {accounts.map(([key, acc]) => {
              const all = acc.builds ?? []
              const filtered = filterBuilds(all)
              // Con un filtro attivo, nascondi gli account che non matchano (declutter);
              // in vista piena (nessun filtro) restano tutti, anche quelli senza deploy.
              if (anyFilter && filtered.length === 0 && !acc.error) return null
              return (
                <AccountSection
                  key={key}
                  acc={acc}
                  all={all}
                  filtered={filtered}
                  anyFilter={anyFilter}
                  expanded={expanded.has(key)}
                  onToggle={() => toggleExpand(key)}
                  onOpen={(b) => setSelected({ build: b, accountLabel: acc.label })}
                  t={t}
                />
              )
            })}
          </div>
        </>
      )}

      <DeployBuildDrawer build={selected?.build} accountLabel={selected?.accountLabel} onClose={() => setSelected(null)} t={t} />
    </>
  )
}
