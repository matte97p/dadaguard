import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Verdetto, Card, Lista, Pill, Dot, Tabs, Drawer, Rimedio, ListaLink, Sezione } from '../ui/index.js'
import { shortActor, fmtAgo, fmtMs, awsErrorText } from '../format.js'
import { groupByService, isServiceRow } from '../deployRows.js'
import { AZIONI_A_MANO, isManualRestart, isByHand, humanActor, FAILED_STATUSES } from '../deployKinds.js'
import { usePoll } from '../usePoll.js'
import { matchesAny, isFiltering, asList, listaDaUrl } from '../filters.js'
import { esitoBuild, rangoLivello } from '../adattatori.js'
import { fasceDeploy, ultimiDeploy, contaDeploy, asseDeploy, linkBuild } from '../rilasci.js'
import './rilasci.css'

// Pagina DEPLOY: cosa sta uscendo adesso e com'e' andata, servizio per servizio. Le build di deploy di
// CodeBuild, i rollout di Cloudflare e le azioni fatte A MANO (riavvii forzati, hotfix fuori dalla CI,
// porte aperte in break-glass, shell nei container), che sono la cosa che una pagina di soli rilasci
// automatici non avrebbe mai mostrato. Read-only, tutto gia' nei dati di /api/deploys.

const PERIOD_MS = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6 }
// Le stesse finestre in ORE, che e' l'unita' con cui il server le dichiara in `finestre.conf`.
const PERIOD_ORE = { '24h': 24, '7d': 168, '30d': 720 }
const COLONNE_SERVIZI = 'minmax(0,1.1fr) 96px minmax(0,1.4fr) 76px 110px'
const COLONNE_BUILD = 'minmax(0,1.1fr) 96px minmax(0,1.4fr) 110px'

// Nome fase leggibile: DOWNLOAD_SOURCE → "Download source".
function phaseLabel(type = '') {
  return type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ')
}

function matchStatus(b, f) {
  if (f === 'running') return b.inProgress
  if (f === 'failed') return FAILED_STATUSES.includes(b.status)
  if (f === 'ok') return b.status === 'SUCCEEDED'
  if (f === 'byhand') return isByHand(b)
  return true
}

function matchPeriod(b, f) {
  if (!PERIOD_MS[f] || !b.startedAt) return true
  return Date.now() - new Date(b.startedAt).getTime() <= PERIOD_MS[f]
}

// L'etichetta della pillola. Lo stato della BUILD non si mostra sulle azioni a mano riuscite: non c'era
// nessuna build, e un «riuscito» accanto a «porta aperta a mano, e' drift» dice la cosa sbagliata (la
// chiamata e' andata a buon fine, la situazione no). Sui tentativi RESPINTI invece si': e' la notizia.
function etichettaEsito(b, t) {
  const l = esitoBuild(b)
  if (isByHand(b) && l === 'ok') return t('rilasci.dep.esito.mano')
  return t(`rilasci.dep.esito.${l}`)
}
// Il colore della pillola: un'apertura di porta a mano o un hotfix riusciti sono arancio, non verdi.
// Non sono guasti, ma sono la cosa da notare, e il verde insegnerebbe a non guardarli.
function livelloPillola(b) {
  const l = esitoBuild(b)
  return l === 'ok' && (b.kind === 'sg-open' || b.trigger === 'hotfix' || b.kind === 'exec') ? 'warn' : l
}

// Il nome della riga: un'azione su un security group si chiamava con l'id del gruppo, e in testa va la
// PORTA, che e' la cosa di cui si parla; l'id scende nella riga sotto, perche' serve per richiudere.
function titoloBuild(b, t) {
  const sg = b.kind === 'sg-open' || b.kind === 'sg-close'
  return sg ? t('deploys.sgPort', { porte: (b.porte ?? []).join(', ') || '?' }) : b.service
}

// Chi l'ha avviata, in parole. «Forzato da» solo se dietro c'e' una PERSONA: su una pipeline e' la
// definizione del contrario, e chi legge si mette a cercare un collega che non esiste.
function chiBuild(b, t) {
  if (b.forcedBy) return t(humanActor(b) ? 'deploys.forcedBy' : 'deploys.byActor', { who: shortActor(b.forcedBy) })
  if (b.trigger && b.trigger !== 'auto') return t(`deploys.trigger.${b.trigger}`)
  return t('rilasci.dep.dallaCi')
}

// «Cosa e' successo»: la frase e il suggerimento sotto. Su un fallimento la fase e il motivo tradotto
// da AWS (`ClusterNotFoundException` sull'account payer vuol dire «chiamata nell'account sbagliato»);
// su un'azione a mano la frase che dice cosa ha fatto, perche' non ha commit ne' durata.
function cosaBuild(b, t) {
  const l = esitoBuild(b)
  if (isManualRestart(b)) {
    const frase =
      b.kind === 'restart' && !humanActor(b) ? (b.actorKind === 'ci' ? 'deploys.restartOfDeploy' : 'deploys.restartAuto') : AZIONI_A_MANO[b.kind]?.frase
    const sg = b.kind === 'sg-open' || b.kind === 'sg-close'
    return {
      cosa: t(frase, { porte: (b.porte ?? []).join(', ') || '?' }),
      hint: l === 'crit' && b.failReason ? awsErrorText(b.failReason, t) : sg ? b.service : null,
    }
  }
  if (l === 'crit')
    return {
      cosa: b.failPhase ? t('deploys.failedIn', { phase: phaseLabel(b.failPhase) }) : t('rilasci.dep.cosa.fallito'),
      hint: b.failReason ? awsErrorText(b.failReason, t) : null,
    }
  if (l === 'info') return { cosa: t('rilasci.dep.cosa.inCorso', { fase: b.phase ? phaseLabel(b.phase) : '?' }), hint: b.commit ? t('rilasci.dep.commit', { c: b.commit }) : null }
  if (l === 'off') return { cosa: t('rilasci.dep.cosa.fermato'), hint: null }
  const cf = b.provider === 'cloudflare'
  return {
    cosa: cf || b.durationMs == null ? t('rilasci.dep.cosa.okSenzaDurata') : t('rilasci.dep.cosa.ok', { d: fmtMs(b.durationMs) }),
    hint: [b.author ? t('deploys.by', { who: shortActor(b.author) }) : null, b.kind === 'pages' && b.branch ? b.branch : null].filter(Boolean).join(' · ') || null,
  }
}

const quandoBuild = (b, t) => fmtAgo(b.inProgress ? b.startedAt : b.endedAt ?? b.startedAt, t)

// I quadratini degli ultimi deploy: verde riuscito, rosso fallito, blu in corso, contorno arancio = a
// mano. La legenda sta nel titolo, perche' nella riga non c'e' posto per scriverla.
function Ultimi({ builds, t }) {
  const q = ultimiDeploy(builds, 5)
  if (!q.length) return <span />
  return (
    <span className="rl-hist" title={t('rilasci.dep.ultimiLegenda')}>
      {q.map(({ build, livello, aMano }, i) => (
        <i key={build.id ?? i} className={`ui-${livello}${aMano ? ' rl-mano' : ''}`} />
      ))}
    </span>
  )
}

// L'istogramma per fascia di tempo. Ogni colonna e' una pila di quadratini, uno per deploy: con i
// numeri piccoli che abbiamo (qualche rilascio all'ora) contarli a occhio funziona meglio di un'asse.
function Istogramma({ builds, ore, t, lang }) {
  const now = Date.now()
  const fasce = useMemo(() => fasceDeploy(builds, { now, ore, n: 24 }), [builds, ore])
  const max = Math.max(1, ...fasce.map((f) => f.ok + f.crit + f.info + f.off))
  const alt = (n) => `${Math.max(0, (n / max) * 100)}%`
  return (
    <Card titolo={t('rilasci.dep.isto.titolo', { finestra: t(`deploys.period.${ore === 24 ? '24h' : ore === 168 ? '7d' : '30d'}`) })} nota={t('rilasci.dep.isto.legenda')}>
      <div className="rl-bars" role="img" aria-label={t('rilasci.dep.isto.titolo', { finestra: '' })}>
        {fasce.map((f) => {
          const tot = f.ok + f.crit + f.info + f.off
          return (
            <div key={f.da} title={t('rilasci.dep.isto.fascia', { ora: new Date(f.da).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), ok: f.ok, ko: f.crit, mano: f.aMano })}>
              {tot > 0 && (
                <>
                  {f.ok > 0 && <i className="ui-bg-ok" style={{ height: alt(f.ok - Math.min(f.ok, f.aMano)) }} />}
                  {f.aMano > 0 && <i className="ui-bg-warn" style={{ height: alt(Math.min(f.ok, f.aMano)) }} />}
                  {f.info > 0 && <i className="ui-bg-info" style={{ height: alt(f.info) }} />}
                  {f.crit > 0 && <i className="ui-bg-crit" style={{ height: alt(f.crit) }} />}
                  {f.off > 0 && <i className="ui-bg-off" style={{ height: alt(f.off) }} />}
                </>
              )}
            </div>
          )
        })}
      </div>
      <div className="ui-axis">
        {asseDeploy({ now, ore, adesso: t('rilasci.adesso'), locale: lang }).map((e, i) => (
          <span key={i}>{e}</span>
        ))}
      </div>
    </Card>
  )
}

// Le fasi CodeBuild nel pannello: pallino, nome, durata; per le fasi fallite il messaggio sotto.
function Fasi({ phases = [] }) {
  const livello = (s) => (s === 'SUCCEEDED' ? 'ok' : s === 'IN_PROGRESS' ? 'info' : FAILED_STATUSES.includes(s) ? 'crit' : 'off')
  return (
    <div className="rl-fasi">
      {phases.map((p, i) => (
        <div key={i}>
          <Dot livello={livello(p.status)} />
          <span>{phaseLabel(p.type || '')}</span>
          <span className="ui-mono ui-mute">{p.durationMs != null ? fmtMs(p.durationMs) : ''}</span>
          {p.message && <pre>{p.message}</pre>}
        </div>
      ))}
    </div>
  )
}

// Il pannello di UNA build: cosa e' successo e cosa fare, i fatti (commit, chi, quando, durata), gli
// ultimi deploy dello stesso servizio, le fasi e i link alle console che ne sanno di piu'.
function PannelloBuild({ sel, onClose, t }) {
  const b = sel?.build ?? {}
  const l = esitoBuild(b)
  const { cosa, hint } = sel ? cosaBuild(b, t) : {}
  const link = sel ? linkBuild(b, t) : []
  const kv = sel
    ? [
        [t('deploys.account'), sel.accountLabel],
        ['commit', b.commit, true],
        [t('deploys.branchLabel'), b.kind === 'pages' && b.branch ? `${b.branch}${b.env ? ` · ${b.env}` : ''}` : null],
        [t('deploys.triggerLabel'), b.trigger ? t(`deploys.trigger.${b.trigger}`) : null],
        [t('deploys.forcedByLabel'), b.forcedBy ? `${b.forcedBy}${b.viaTeleport ? ` · ${t('deploys.viaTeleport')}` : ''}` : null],
        [t('deploys.authorLabel'), !isManualRestart(b) ? b.author : null],
        [t('deploys.clusterLabel'), b.cluster],
        [t('deploys.durationLabel'), b.provider !== 'cloudflare' && !isManualRestart(b) && !b.inProgress && b.durationMs != null ? fmtMs(b.durationMs) : null],
        [t('deploys.whenLabel'), b.startedAt ? new Date(b.inProgress ? b.startedAt : b.endedAt ?? b.startedAt).toLocaleString() : null],
        [t('deploys.rollout'), b.versions?.length > 1 ? b.versions.map((v) => `${String(v.id).slice(0, 8)}${v.percentage != null ? ` ${v.percentage}%` : ''}`).join(' · ') : null, true],
        ['build', b.number != null ? `#${b.number}` : null, true],
      ].filter(([, v]) => v)
    : []
  return (
    <Drawer
      aperto={Boolean(sel)}
      onChiudi={onClose}
      etichettaChiudi={t('ui.chiudi')}
      sopra={sel ? <Pill livello={livelloPillola(b)}>{etichettaEsito(b, t)}</Pill> : null}
      titolo={sel ? titoloBuild(b, t) : ''}
      sotto={sel ? [sel.accountLabel, chiBuild(b, t), quandoBuild(b, t)].filter(Boolean).join(' · ') : null}
    >
      {sel && (
        <>
          <Rimedio livello={l === 'crit' ? 'crit' : livelloPillola(b) === 'warn' ? 'warn' : null} titolo={cosa} testo={l === 'crit' && b.failReason ? b.failReason : hint} comando={b.comando ?? null} t={t} />
          {/* L'hotfix salta il gate della CI: il pannello e' il posto dove dirlo per intero, perche'
              nella riga ci sta solo la pillola arancio. */}
          {b.trigger === 'hotfix' && <Rimedio livello="warn" testo={t('deploys.hotfixWarn')} t={t} />}
          <dl className="rl-kv">
            {kv.map(([k, v, mono]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd className={mono ? 'ui-mono' : undefined}>{v}</dd>
              </div>
            ))}
            {sel.recenti?.length > 1 && (
              <>
                <dt>{t('rilasci.dep.ultimi5')}</dt>
                <dd>
                  <Ultimi builds={sel.recenti} t={t} />
                </dd>
              </>
            )}
          </dl>
          {b.phases?.length > 0 && (
            <Sezione titolo={t('deploys.phases')}>
              <Fasi phases={b.phases} />
            </Sezione>
          )}
          {link.length > 0 && (
            <Sezione titolo={t('rilasci.altrove')}>
              <ListaLink link={link} />
            </Sezione>
          )}
        </>
      )}
    </Drawer>
  )
}

export default function DeploysPage({ t = (k) => k, lang, refreshKey, accountFilter = [] }) {
  // ⚠️ La finestra la porta anche il SERVER, non solo il filtro qui: il periodo scelto viaggia in
  // `?ore=` e il server taglia alla fonte. Prima tornavano sempre le ultime 15 build per progetto, e
  // scegliere «30g» non mostrava niente di piu'. Auto-refresh ogni 15s: una build dura un minuto.
  const [periodFilter, setPeriodFilter] = useState('24h')
  const { data, loading, error, refresh } = usePoll(`/api/deploys?lang=${lang}&ore=${PERIOD_ORE[periodFilter] ?? 24}`, { intervalMs: 15000 })
  const [statusFilter, setStatusFilter] = useState('all')
  // Deep-link `?service=a,b`: il pannello di un servizio linka qui GIA' filtrato. La guardia su
  // `window` serve al rendering senza browser.
  const [serviceFilter, setServiceFilter] = useState(() => (typeof window === 'undefined' ? [] : listaDaUrl(window.location.search, 'service')))
  const [query, setQuery] = useState('')
  const [vista, setVista] = useState('servizi')
  const [selected, setSelected] = useState(null) // { build, accountLabel, recenti }

  // Il bottone "Aggiorna" globale fa +1 su refreshKey: questa pagina ha un fetch proprio.
  const seenRk = useRef(refreshKey)
  useEffect(() => {
    if (refreshKey !== seenRk.current) {
      seenRk.current = refreshKey
      refresh()
    }
  }, [refreshKey, refresh])

  // Il filtro Account della barra in alto vale anche qui: la chiave di `/api/deploys` e' la stessa
  // dell'account. Prima la pagina lo ignorava, e il filtro sembrava rotto.
  const accounts = useMemo(() => (data ? Object.entries(data).filter(([key]) => matchesAny(key, accountFilter)) : []), [data, accountFilter])

  const cercato = useCallback(
    (b) => {
      const q = query.trim().toLowerCase()
      return !q || [b.service, b.commit, b.author, b.forcedBy].some((x) => String(x ?? '').toLowerCase().includes(q))
    },
    [query],
  )
  // Le build della finestra con filtro di servizio e ricerca, ma SENZA il filtro di stato: servono ai
  // conteggi sulle schede, che devono dire quanti ce ne sono dietro ognuna prima di sceglierla.
  const nellaFinestra = useMemo(
    () =>
      accounts.flatMap(([key, acc]) =>
        (acc.builds ?? [])
          .filter((b) => matchPeriod(b, periodFilter) && matchesAny(b.service, serviceFilter) && cercato(b))
          .map((b) => ({ ...b, accountKey: key, accountLabel: acc.label })),
      ),
    [accounts, periodFilter, serviceFilter, cercato],
  )
  const visibili = useMemo(() => nellaFinestra.filter((b) => matchStatus(b, statusFilter)), [nellaFinestra, statusFilter])
  const conta = useMemo(() => contaDeploy(nellaFinestra), [nellaFinestra])

  // Una riga per servizio, con identita' account + nome: `backend` esiste in piu' ambienti, e il nome
  // da solo non dice quale stai guardando. Dal piu' grave: chi e' fallito, poi chi sta uscendo adesso.
  const gruppi = useMemo(() => {
    const out = []
    for (const [key, acc] of accounts) {
      const proprie = visibili.filter((b) => b.accountKey === key)
      for (const g of groupByService(proprie)) {
        // Gli ultimi 5 vengono da TUTTE le build del servizio nella finestra, non da quelle filtrate:
        // filtrando «falliti» la striscia tutta rossa direbbe il falso sull'andamento.
        const tutte = nellaFinestra.filter((b) => b.accountKey === key && (g.sgGroup ? !isServiceRow(b) : b.service === g.service && isServiceRow(b)))
        out.push({ ...g, accountKey: key, accountLabel: acc.label, recenti: tutte.filter((b) => !isManualRestart(b) || isByHand(b)) })
      }
    }
    return out.sort((a, b) => {
      if (a.sgGroup !== b.sgGroup) return a.sgGroup ? 1 : -1
      return rangoLivello(esitoBuild(a.latest)) - rangoLivello(esitoBuild(b.latest)) || String(a.service).localeCompare(String(b.service))
    })
  }, [accounts, visibili, nellaFinestra])

  // Le scelte di servizio che arrivano dal link restano visibili e si tolgono una per una: un filtro
  // attivo che non si vede e' la ragione numero uno per cui «la pagina e' vuota».
  const togliServizio = (s) => setServiceFilter((prev) => asList(prev).filter((x) => x !== s))
  const apri = (build, accountLabel, recenti) => setSelected({ build, accountLabel, recenti })

  const erroriConti = accounts.filter(([, acc]) => acc.error)
  const senzaProgetti = accounts.filter(([, acc]) => acc.noProjects && !(acc.builds ?? []).length)
  const ore = PERIOD_ORE[periodFilter] ?? 24
  const finestra = t(`deploys.period.${periodFilter}`)

  // Il verdetto: «i rilasci stanno passando?». Le azioni a mano restano un numero e non entrano nel
  // giudizio: un hotfix a mano non e' un guasto, e' una scelta, e marcarlo rosso insegnerebbe a
  // ignorare il rosso.
  const verdetto = conta.crit
    ? { livello: 'crit', forte: t('rilasci.dep.v.falliti', { n: conta.crit }), resto: conta.info ? t('rilasci.dep.v.eInCorso', { n: conta.info }) : '' }
    : conta.info
      ? { livello: 'info', forte: t('rilasci.dep.v.inCorso', { n: conta.info }), resto: t('rilasci.dep.v.nessunFallito') }
      : nellaFinestra.length
        ? { livello: 'ok', forte: t('rilasci.dep.v.ok', { n: conta.ok }), resto: '' }
        : { livello: null, forte: null, resto: t('rilasci.dep.v.nessuno') }

  const schede = [
    { key: 'all', label: t('deploys.filter.all'), n: nellaFinestra.length },
    { key: 'failed', label: t('deploys.filter.failed'), n: conta.crit },
    { key: 'running', label: t('deploys.filter.running'), n: conta.info },
    { key: 'ok', label: t('deploys.filter.ok'), n: conta.ok },
    { key: 'byhand', label: t('deploys.filter.byhand'), n: conta.aMano },
  ]

  return (
    <div className="rl-pagina">
      <Verdetto
        livello={loading && !data ? null : verdetto.livello}
        forte={loading && !data ? null : verdetto.forte}
        resto={loading && !data ? t('rilasci.dep.v.attesa') : verdetto.resto}
        dettaglio={t('rilasci.dep.v.dettaglio', { finestra })}
      />

      {error && <div className="ui-readwarn">{error}</div>}
      {erroriConti.map(([key, acc]) => (
        <div key={key} className="ui-readwarn">
          {t('rilasci.nonLeggibile', { conto: acc.label ?? key, errore: acc.error })}
        </div>
      ))}

      {data && (
        <>
          <Istogramma builds={nellaFinestra} ore={ore} t={t} lang={lang} />
          <div className="ui-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
            <div className="ui-stat">
              <b className={conta.ok ? 'ui-t-ok' : undefined}>{conta.ok}</b>
              <span>{t('rilasci.dep.stat.ok')}</span>
            </div>
            <div className="ui-stat">
              <b className={conta.crit ? 'ui-t-crit' : undefined}>{conta.crit}</b>
              <span>{t('rilasci.dep.stat.ko')}</span>
            </div>
            <div className="ui-stat">
              <b className={conta.info ? 'ui-t-info' : undefined}>{conta.info}</b>
              <span>{t('rilasci.dep.stat.inCorso')}</span>
            </div>
            <div className="ui-stat" title={t('deploys.manualTip')}>
              <b className={conta.aMano ? 'ui-t-warn' : undefined}>{conta.aMano}</b>
              <span>{t('rilasci.dep.stat.mano')}</span>
            </div>
          </div>
        </>
      )}

      <div className="rl-tools">
        <input className="rl-cerca" type="search" placeholder={t('rilasci.dep.cerca')} aria-label={t('rilasci.dep.cerca')} value={query} onChange={(e) => setQuery(e.target.value)} />
        {/* Niente «sempre»: oltre i 7 giorni le azioni a mano (da CloudTrail) non ci sono piu', e una
            lista che mescola due orizzonti fa concludere «a marzo nessuno ha aperto porte». */}
        <div className="ui-seg" role="group" aria-label={t('rilasci.finestra')}>
          {Object.keys(PERIOD_ORE).map((p) => (
            <button key={p} type="button" aria-pressed={periodFilter === p} onClick={() => setPeriodFilter(p)}>
              {t(`deploys.period.${p}`)}
            </button>
          ))}
        </div>
        {asList(serviceFilter).map((s) => (
          <button key={s} type="button" className="rl-chip" aria-pressed="true" onClick={() => togliServizio(s)} title={t('rilasci.togliFiltro')}>
            {s} ✕
          </button>
        ))}
      </div>

      <Tabs voci={schede} attiva={statusFilter} onCambia={setStatusFilter} />

      <div className="rl-tools">
        <Tabs
          voci={[
            { key: 'servizi', label: t('rilasci.dep.vistaServizi'), n: gruppi.length },
            { key: 'build', label: t('rilasci.dep.vistaBuild'), n: visibili.length },
          ]}
          attiva={vista}
          onCambia={setVista}
        />
      </div>

      {loading && !data ? (
        <p className="ui-mute">{t('rilasci.dep.v.attesa')}</p>
      ) : vista === 'servizi' ? (
        <Lista
          colonne={[t('rilasci.dep.col.servizio'), t('rilasci.dep.col.esito'), t('rilasci.dep.col.cosa'), t('rilasci.dep.col.ultimi'), t('rilasci.dep.col.quando')]}
          griglia={COLONNE_SERVIZI}
          vuoto={isFiltering(serviceFilter) || statusFilter !== 'all' || query ? t('deploys.noneFiltered') : data && !accounts.length ? t('deploys.noAccounts') : t('deploys.none')}
        >
          {gruppi.map((g) => {
            const b = g.latest
            const { cosa, hint } = cosaBuild(b, t)
            return (
              <button
                key={`${g.accountKey}/${g.service}`}
                type="button"
                className="ui-row ui-row-btn"
                style={{ gridTemplateColumns: COLONNE_SERVIZI }}
                // data-build: ancora per il video demo, vedi pageKit.jsx.
                data-build={b.service}
                title={t('deploys.openDetail')}
                onClick={() => apri(b, g.accountLabel, g.recenti)}
              >
                <span className="ui-name">
                  {g.sgGroup ? t('deploys.sgGroup', { n: g.builds.length }) : g.service}
                  <small>{[g.accountLabel, chiBuild(b, t)].filter(Boolean).join(' · ')}</small>
                </span>
                <Pill livello={livelloPillola(b)}>{etichettaEsito(b, t)}</Pill>
                <span className="ui-what">
                  {cosa}
                  {hint && <span className="ui-hint">{hint}</span>}
                </span>
                {b.provider === 'cloudflare' ? <span /> : <Ultimi builds={g.recenti} t={t} />}
                <span className="ui-when">
                  {quandoBuild(b, t)}
                  {b.commit && (
                    <>
                      <br />
                      <span className="ui-mono">{String(b.commit).slice(0, 8)}</span>
                    </>
                  )}
                </span>
              </button>
            )
          })}
        </Lista>
      ) : (
        <Lista
          colonne={[t('rilasci.dep.col.servizio'), t('rilasci.dep.col.esito'), t('rilasci.dep.col.cosa'), t('rilasci.dep.col.quando')]}
          griglia={COLONNE_BUILD}
          vuoto={t('deploys.noneFiltered')}
        >
          {[...visibili]
            .sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0))
            .map((b) => {
              const { cosa, hint } = cosaBuild(b, t)
              const recenti = nellaFinestra.filter((x) => x.accountKey === b.accountKey && x.service === b.service)
              return (
                <button
                  key={b.id || `${b.project}:${b.number}`}
                  type="button"
                  className="ui-row ui-row-btn"
                  style={{ gridTemplateColumns: COLONNE_BUILD }}
                  data-build={b.service}
                  onClick={() => apri(b, b.accountLabel, recenti)}
                >
                  <span className="ui-name">
                    {titoloBuild(b, t)}
                    {b.number != null && <span className="ui-faint"> #{b.number}</span>}
                    <small>{[b.accountLabel, chiBuild(b, t)].filter(Boolean).join(' · ')}</small>
                  </span>
                  <Pill livello={livelloPillola(b)}>{etichettaEsito(b, t)}</Pill>
                  <span className="ui-what">
                    {cosa}
                    {hint && <span className="ui-hint">{hint}</span>}
                  </span>
                  <span className="ui-when">
                    {quandoBuild(b, t)}
                    {b.commit && (
                      <>
                        <br />
                        <span className="ui-mono">{String(b.commit).slice(0, 8)}</span>
                      </>
                    )}
                  </span>
                </button>
              )
            })}
        </Lista>
      )}

      {senzaProgetti.length > 0 && (
        <p className="ui-note">
          {t('rilasci.dep.senzaProgetti', { conti: senzaProgetti.map(([k, a]) => a.label ?? k).join(', ') })}
        </p>
      )}

      <PannelloBuild sel={selected} onClose={() => setSelected(null)} t={t} />
    </div>
  )
}
