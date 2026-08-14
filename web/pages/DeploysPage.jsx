import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Typography, Space, Badge, Tag, Segmented, Select, Button, Skeleton, Tooltip, Drawer } from 'antd'
import { ClockCircleOutlined } from '@ant-design/icons'
import { PageIntro, PANEL_CARD, HeroStat, HeroRow, EmptyState } from './pageKit.jsx'
import { shortActor, fmtAgo } from '../format.js'
import { usePoll } from '../usePoll.js'
import PollStatus from '../components/PollStatus.jsx'

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
// Colore dell'etichetta di avvio. `hotfix` è rosso perché è l'unico valore che significa "in
// produzione gira codice che nessun test ha visto": se si legge come gli altri, non serve a niente.
const TRIGGER_TAG = { hotfix: 'error', restart: 'blue' }
// Le azioni che NON sono build: un riavvio forzato, l'apertura o la chiusura a mano di una porta su un
// security group (break-glass), una shell aperta dentro a un container. Nessuna ha fasi, durata, log né
// tasso di successo da calcolare, e ognuna ha una frase sua: senza, cadevano tutte nel ramo del riavvio
// e la pagina diceva «stessa immagine, nessuna build» sopra un break-glass.
const AZIONI_A_MANO = {
  restart: { tag: 'blue', frase: 'deploys.sameImage' },
  'sg-open': { tag: 'error', frase: 'deploys.sgOpen' },
  'sg-close': { tag: 'success', frase: 'deploys.sgClose' },
  exec: { tag: 'warning', frase: 'deploys.exec' },
}
const isManualRestart = (b) => Boolean(AZIONI_A_MANO[b?.kind])
// Azione fatta a mano = una di quelle sopra, o una build lanciata fuori dalla CI.
const isByHand = (b) => isManualRestart(b) || b?.trigger === 'hotfix' || b?.trigger === 'manuale'
const PERIOD_MS = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6 }
const TREND_MAX = 10 // build mostrate nel mini-trend a pallini

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
  if (f === 'byhand') return isByHand(b)
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
    // Tasso di successo e trend contano solo le BUILD: un riavvio riuscito non dice niente
    // sull'affidabilità dei rilasci, e mescolarlo gonfierebbe il rapporto proprio quando un
    // servizio va male (ogni riavvio per rimetterlo in piedi lo farebbe sembrare più sano).
    const onlyBuilds = sorted.filter((x) => !isManualRestart(x))
    groups.push({
      service,
      builds: sorted,
      trend: onlyBuilds,
      latest: sorted[0],
      ok: onlyBuilds.filter((x) => x.status === 'SUCCEEDED').length,
      failed: onlyBuilds.filter((x) => FAILED_STATUSES.includes(x.status)).length,
    })
  }
  return groups.sort((a, b) => {
    const ai = a.latest.inProgress ? 0 : 1
    const bi = b.latest.inProgress ? 0 : 1
    if (ai !== bi) return ai - bi
    return a.service.localeCompare(b.service)
  })
}

// Mini-trend: pallini colorati per stato, dal più vecchio (sx) al più recente (dx), ultime N.
// Ogni pallino è CLICCABILE → apre QUELLA build (stopPropagation, così il resto della riga apre l'ultima).
function DeployTrend({ builds, onOpen, t }) {
  const recent = builds.slice(0, TREND_MAX).reverse()
  if (recent.length < 2) return null
  return (
    <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {recent.map((b, i) => {
        const st = STATUS[b.status] ?? FALLBACK
        return (
          <Tooltip key={i} title={`#${b.number} · ${t(st.key ?? 'deploys.stopped')}`}>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onOpen?.(b)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  onOpen?.(b)
                }
              }}
              style={{ width: 9, height: 9, borderRadius: 2, background: st.color, opacity: b.inProgress ? 0.55 : 1, cursor: onOpen ? 'pointer' : 'default' }}
            />
          </Tooltip>
        )
      })}
    </span>
  )
}

// Blocco sinistro condiviso da riga-servizio e riga-build: stato + nome + #num + trigger, sotto
// commit·durata (o fase, se in corso), e — se fallita — la riga rossa "Fallita in FASE: motivo".
function BuildInfo({ b, name, t }) {
  const isCf = b.provider === 'cloudflare'
  const restart = isManualRestart(b)
  // CF: niente durata (non c'è) → al suo posto il branch (solo Pages). L'AUTORE no: sta già
  // nell'intestazione come "da <nome>", e ripeterlo qui per email lo scriveva due volte per riga.
  // Riavvio: al posto di commit e durata (non ne ha) il fatto che conta — non ha rilasciato codice.
  const sub = restart
    ? t(AZIONI_A_MANO[b.kind].frase, { porte: (b.porte ?? []).join(', ') || '?' })
    : [
        b.commit,
        b.inProgress ? (b.phase ? b.phase.toLowerCase() : null) : isCf ? null : fmtDur(b.durationMs),
        isCf && b.kind === 'pages' && b.branch ? b.branch : null,
      ]
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
          <Tag
            color={AZIONI_A_MANO[b.kind]?.tag ?? TRIGGER_TAG[b.trigger]}
            bordered={false}
            style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '17px', padding: '0 6px', opacity: TRIGGER_TAG[b.trigger] ? 1 : 0.85 }}
          >
            {t(`deploys.trigger.${b.trigger}`)}
          </Tag>
        )}
        {/* Chi ha PREMUTO. Su un hotfix o un riavvio è l'informazione principale della riga — e non
            coincide con l'autore del commit, che è quello che la riga mostrava prima. */}
        {b.forcedBy && (
          <Tooltip title={b.viaTeleport ? `${b.forcedBy} · ${t('deploys.viaTeleport')}` : b.forcedBy}>
            <Text style={{ fontSize: 11, fontWeight: 600 }}>{t('deploys.forcedBy', { who: shortActor(b.forcedBy) })}</Text>
          </Tooltip>
        )}
        {b.author && !restart && (
          <Tooltip title={b.author}>
            <Text type="secondary" style={{ fontSize: 11, opacity: 0.85 }}>
              {t('deploys.by', { who: shortActor(b.author) })}
            </Text>
          </Tooltip>
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
      // data-build: ancora per il video demo, vedi pageKit.jsx.
      data-build={b.service}
      onClick={() => onOpen(b)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(b))}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '8px 12px',
        borderRadius: 8,
        borderLeft: `3px solid ${st.color}`,
        background: b.inProgress ? 'rgba(22,119,255,0.10)' : 'var(--dg-row)',
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
        {!isCf && <DeployTrend builds={g.trend ?? g.builds} onOpen={onOpen} t={t} />}
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
            {b.forcedBy && (
              <MetaLine label={t('deploys.forcedByLabel')}>
                {b.forcedBy}
                {b.viaTeleport ? ` · ${t('deploys.viaTeleport')}` : ''}
              </MetaLine>
            )}
            {b.author && !isManualRestart(b) && <MetaLine label={t('deploys.authorLabel')}>{b.author}</MetaLine>}
            {b.cluster && <MetaLine label={t('deploys.clusterLabel')}>{b.cluster}</MetaLine>}
            {!(b.provider === 'cloudflare') && !isManualRestart(b) && (
              <MetaLine label={t('deploys.durationLabel')}>{b.inProgress ? '—' : fmtDur(b.durationMs) || '—'}</MetaLine>
            )}
            <MetaLine label={t('deploys.whenLabel')}>{fmtAgo(b.inProgress ? b.startedAt : b.endedAt, t) || '—'}</MetaLine>
            {b.kind === 'pages' && b.branch && (
              <MetaLine label={t('deploys.branchLabel')}>
                {b.branch}
                {b.env ? ` · ${b.env}` : ''}
              </MetaLine>
            )}
            {b.versions?.length > 1 && (
              <MetaLine label={t('deploys.rollout')}>
                {b.versions.map((v) => `${String(v.id).slice(0, 8)}${v.percentage != null ? ` ${v.percentage}%` : ''}`).join(' · ')}
              </MetaLine>
            )}
          </Space>

          {/* L'hotfix salta il gate della CI: il dettaglio è il posto dove dirlo per intero, perché
              nella riga ci sta solo l'etichetta rossa. */}
          {b.trigger === 'hotfix' && <Alert type="warning" showIcon message={t('deploys.hotfixWarn')} />}

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
          {/* Conteggi delle build VISIBILI (come l'hero): con i totali fissi il filtro sembrava inerte. */}
          <CountPills builds={filtered} />
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

// Pagina Deploy: build CodeBuild di deploy (`acme-*-*-deploy`) per account — cosa sta uscendo ora e
// com'è andata (per servizio: ultima build, tasso di successo, trend). Click su una build → dettaglio
// (fasi + motivo del fallimento + log CloudWatch). Read-only, on-demand. Mostra TUTTI gli account risolti.
export default function DeploysPage({ t = (k) => k, lang, refreshKey, accountFilter = 'all' }) {
  // Auto-refresh ogni 15s (pausa a tab nascosto, fresco al rientro): una build dura ~1 min, così la
  // vista non resta più ferma a uno snapshot vecchio mentre il deploy è già finito.
  const { data, loading, refreshing, error, lastUpdated, refresh } = usePoll(`/api/deploys?lang=${lang}`, {
    intervalMs: 15000,
  })
  const [statusFilter, setStatusFilter] = useState('all')
  const [periodFilter, setPeriodFilter] = useState('all')
  // Filtro iniziale da `?service=`: il pannello di un servizio linka qui GIÀ filtrato, altrimenti
  // arriveresti sui deploy di tutta la flotta da cercare a mano.
  // Deep-link `?service=`: arriva dalla pagina dei servizi. La guardia su `window` serve alla prova di
  // rendering senza browser (l'unico controllo automatico che questa UI puo' avere in questo repo).
  const [serviceFilter, setServiceFilter] = useState(() =>
    typeof window === 'undefined' ? 'all' : new URLSearchParams(window.location.search).get('service') ?? 'all',
  )
  const [expanded, setExpanded] = useState(() => new Set())
  const [selected, setSelected] = useState(null) // { build, accountLabel } aperto nel drawer

  // Il bottone "Aggiorna" globale nell'header fa +1 su refreshKey → forza un refresh anche di questa
  // pagina (che ha un fetch proprio, `/api/deploys`, separato da quello della dashboard).
  const seenRk = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey !== seenRk.current) {
      seenRk.current = refreshKey
      refresh()
    }
  }, [refreshKey, refresh])

  // Tutti gli account risolti, ordinati: quelli con build (o in errore) prima, i "senza deploy" in coda;
  // a parità, per label. Il filtro Account della barra in alto vale ANCHE qui: la chiave di
  // `/api/deploys` è la stessa dell'account (production/staging/…/cloudflare). Prima la pagina lo
  // ignorava del tutto → selezionavi un account e non cambiava niente: il filtro sembrava rotto.
  const accounts = useMemo(() => {
    const all = data ? Object.entries(data) : []
    const list = accountFilter === 'all' ? all : all.filter(([key]) => key === accountFilter)
    return list.sort(([, a], [, b]) => {
      const av = a.error || (a.builds?.length ?? 0) > 0 ? 0 : 1
      const bv = b.error || (b.builds?.length ?? 0) > 0 ? 0 : 1
      if (av !== bv) return av - bv
      return String(a.label ?? '').localeCompare(String(b.label ?? ''))
    })
  }, [data, accountFilter])

  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('deploys.filter.all') },
      { value: 'running', label: t('deploys.filter.running') },
      { value: 'failed', label: t('deploys.filter.failed') },
      { value: 'ok', label: t('deploys.filter.ok') },
      { value: 'byhand', label: t('deploys.filter.byhand') },
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
  // Servizi selezionabili = quelli degli account VISIBILI (se filtri per account, non ti offro
  // servizi di un altro account: sceglierli svuotava la pagina senza motivo apparente).
  const serviceOptions = useMemo(() => {
    const set = new Set()
    for (const [, acc] of accounts) for (const b of acc.builds ?? []) if (b.service) set.add(b.service)
    return [{ value: 'all', label: t('deploys.allServices') }, ...[...set].sort().map((s) => ({ value: s, label: s }))]
  }, [accounts, t])

  const anyFilter = statusFilter !== 'all' || periodFilter !== 'all' || serviceFilter !== 'all'
  const toggleExpand = (key) =>
    setExpanded((prev) => {
      const n = new Set(prev)
      n.has(key) ? n.delete(key) : n.add(key)
      return n
    })

  const filterBuilds = useCallback(
    (list) =>
      list
        .filter((b) => matchStatus(b, statusFilter))
        .filter((b) => matchPeriod(b, periodFilter))
        .filter((b) => serviceFilter === 'all' || b.service === serviceFilter),
    [statusFilter, periodFilter, serviceFilter],
  )

  // I numeroni in cima contano le build VISIBILI, filtri applicati. Prima erano sempre i totali della
  // flotta: filtravi "Falliti" e restava "ok 109" → sembrava che i filtri non facessero nulla.
  const hero = useMemo(() => {
    const all = accounts.flatMap(([, acc]) => filterBuilds(acc.builds ?? []))
    const builds = all.filter((b) => !isManualRestart(b))
    return {
      running: all.filter((b) => b.inProgress || b.status === 'IN_PROGRESS').length,
      ok: builds.filter((b) => b.status === 'SUCCEEDED').length,
      failed: all.filter((b) => FAILED_STATUSES.includes(b.status)).length,
      // Quante azioni sono passate fuori dalla CI. È il numero che prima non esisteva da nessuna
      // parte: chi guardava la pagina vedeva solo i rilasci automatici e concludeva che nessuno
      // avesse toccato la produzione a mano.
      byHand: all.filter(isByHand).length,
    }
  }, [accounts, filterBuilds])

  return (
    <>
      <PageIntro
        title={t('deploys.title')}
        desc={t('deploys.desc')}
        extra={
          <Space wrap size={8}>
            <PollStatus lastUpdated={lastUpdated} refreshing={refreshing} t={t} />
            <Segmented size="small" value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
            <Segmented size="small" value={periodFilter} onChange={setPeriodFilter} options={periodOptions} />
            <Select size="small" value={serviceFilter} onChange={setServiceFilter} options={serviceOptions} style={{ minWidth: 150 }} />
          </Space>
        }
      />

      {loading && !data && <DeploysSkeleton />}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
      {data && accounts.length === 0 && <EmptyState description={t('deploys.noAccounts')} />}

      {accounts.length > 0 && (
        <>
          <HeroRow>
            {hero.running > 0 && <HeroStat label={t('deploys.running')} value={hero.running} color="#1677ff" size={18} />}
            <HeroStat label={t('deploys.ok')} value={hero.ok} color={hero.ok ? '#52c41a' : undefined} size={18} />
            <HeroStat label={t('deploys.failed')} value={hero.failed} color={hero.failed ? '#ff4d4f' : undefined} size={18} />
            {hero.byHand > 0 && (
              <Tooltip title={t('deploys.manualTip')}>
                <span>
                  <HeroStat label={t('deploys.manual')} value={hero.byHand} color="#faad14" size={18} />
                </span>
              </Tooltip>
            )}
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
