import { useMemo, useState } from 'react'
import { Verdetto, Lista, Sezione, Pill, Tabs, Meter } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import { fmtAgo, fmtMs, fmtSchedule } from '../format.js'
import { matchesAny, isFiltering } from '../filters.js'
import { rangoLivello } from '../adattatori.js'
import { livelloCorsa, durataCorsa, durataTipica, motivoCorsa, statoCron } from '../rilasci.js'
import { useTick } from '../components/runBits.jsx'
import RunTimeline from '../components/RunTimeline.jsx'
import RunLogsDrawer from '../components/RunLogsDrawer.jsx'
import './rilasci.css'

// Pagina CRON: cosa sta girando adesso, e com'e' finita ogni corsa di prima.
//
// Perche' non basta la card di un cron: la card risponde «il cron va / e' saltato», che e' la domanda di
// un watchdog. Su un job LUNGO (uno scraper che macina un'ora) le domande vere sono altre: *sta girando
// in questo momento, e da quanto rispetto al solito?* e *quella di stanotte com'e' andata, perche', e
// dove sono i suoi log?*. Uno stato aggregato non le distingue nemmeno: un cron «up» puo' essere fermo,
// a meta' corsa, o appena finito male con l'exit code a zero.
//
// DUE VISTE, e non e' indecisione: «per cron» risponde guardando (la striscia delle ultime corse, chi
// e' piu' lento del solito, dove c'e' un buco), «tutte le corse» risponde leggendo (in ordine di orario,
// filtrabili per «solo problemi»). La scelta resta: e' una preferenza, non uno stato.
//
// I cron che nella finestra non hanno corso stanno nella lista come gli altri, con il loro stato: «non
// e' partito» e' una risposta, ed e' quella che una vista di sole esecuzioni non potrebbe dare.
const WINDOWS = [
  { key: 360, label: '6h' },
  { key: 1440, label: '24h' },
  { key: 10_080, label: '7g' },
  { key: 43_200, label: '30g' },
]
const COLONNE_CRON = 'minmax(0,1.1fr) 96px minmax(0,1.6fr) 150px 24px'
const COLONNE_CORSE = '96px minmax(0,1.1fr) minmax(0,1.6fr) 90px 24px'

// Le run di tutti i cron, appiattite in righe: una riga = una esecuzione. Pura.
export function flattenRuns(crons = [], prefect = null) {
  const righe = []
  for (const c of crons) {
    for (const r of c.runs ?? []) {
      righe.push({ ...r, key: `${c.key}#${r.id ?? r.startedAt}`, cronKey: c.key, cronName: c.name, cronType: c.type, account: c.account, accountLabel: c.accountLabel })
    }
  }
  for (const r of prefect?.runs ?? []) {
    righe.push({ ...r, key: `prefect#${r.id}`, cronKey: `prefect/${r.cron ?? '?'}`, cronName: r.cron, cronType: 'prefect', account: null, accountLabel: null })
  }
  return righe.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

// Le run dell'orchestratore raggruppate per flow, nella stessa forma dei cron AWS: cosi' la lista e'
// una sola e non «i cron, e poi in fondo anche gli altri». Pura.
export function prefectAsCrons(prefect = null, t = (k) => k) {
  const perFlow = new Map()
  for (const r of prefect?.runs ?? []) {
    const nome = r.cron ?? '?'
    if (!perFlow.has(nome)) perFlow.set(nome, [])
    perFlow.get(nome).push(r)
  }
  return [...perFlow.entries()].map(([nome, runs]) => ({
    key: `prefect/${nome}`,
    name: nome,
    type: 'prefect',
    accountLabel: t('runs.type.prefect'),
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

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// «Cosa e' successo» di un cron, in parole: la frase e il suggerimento sotto. Il suggerimento e' la
// cosa che serve per decidere: il motivo del fallimento, quanto manca rispetto al solito, la prossima.
function cosaCron(c, stato, t, now) {
  const runs = c.runs ?? []
  const viva = runs.find((r) => r.running)
  const ultima = runs.find((r) => !r.running)
  const tipica = durataTipica(c)
  const prossima = c.nextRunAt ? t('rilasci.cron.prossima', { ora: hhmm(c.nextRunAt) }) : null
  if (viva) {
    const da = durataCorsa(viva, now)
    return {
      cosa: t('rilasci.cron.inCorsoDa', { d: fmtMs(da ?? 0) }),
      hint: tipica ? t('rilasci.cron.diSolito', { d: fmtMs(tipica) }) : ultima?.outcome === 'failed' ? motivoCorsa(ultima, t) : null,
    }
  }
  if (!runs.length) {
    if (stato === 'off') return { cosa: t('rilasci.cron.spento'), hint: t('rilasci.cron.spentoHint') }
    return { cosa: t('rilasci.cron.nonPartito'), hint: c.error ?? prossima }
  }
  const quando = ultima?.startedAt ? fmtAgo(ultima.startedAt, t) : ''
  const durata = durataCorsa(ultima)
  if (ultima?.outcome === 'failed') return { cosa: t('rilasci.cron.fallito', { quando }), hint: motivoCorsa(ultima, t) }
  if (ultima?.outcome === 'unknown') return { cosa: t('rilasci.cron.ignoto', { quando }), hint: motivoCorsa(ultima, t) }
  return { cosa: t('rilasci.cron.ok', { quando, d: durata ? fmtMs(durata) : '?' }), hint: prossima }
}

export default function RunsPage({ t = (k) => k, lang, refreshKey, accountFilter = [] }) {
  const [minutes, setMinutes] = useState(1440)
  // La vista scelta persiste: e' una preferenza di chi guarda. Letta con la guardia perche' il
  // modulo puo' essere reso fuori dal browser, e `localStorage` puo' lanciare (finestra privata).
  const [vista, setVista] = useState(() => {
    try {
      return localStorage.getItem('dadaguard-runs-view') === 'lista' ? 'lista' : 'cron'
    } catch {
      return 'cron'
    }
  })
  const [soloProblemi, setSoloProblemi] = useState(false)
  const [query, setQuery] = useState('')
  const [aperta, setAperta] = useState(null) // { cron, run } del pannello aperto
  // Cron scelto: la vista passa da «le ultime di tutti» a «tutte le sue». E' il server a leggere piu' a
  // fondo: filtrare qui non aggiungerebbe le corse che non sono state chieste.
  const [soloCron, setSoloCron] = useState(null)

  const scegliVista = (v) => {
    setVista(v)
    try {
      localStorage.setItem('dadaguard-runs-view', v)
    } catch {
      /* preferenza non salvata: la vista funziona lo stesso */
    }
  }

  // Polling educato (in pausa a tab nascosto, rinfresca al rientro): una corsa in corso va vista
  // avanzare, ma senza chiamare AWS quando nessuno guarda. `refreshKey` = il tasto Aggiorna globale.
  const { data, loading, error } = usePoll(
    `/api/runs?minutes=${minutes}&lang=${lang}${soloCron ? `&cron=${encodeURIComponent(soloCron)}&limit=25` : ''}&k=${refreshKey ?? 0}`,
    { intervalMs: 30_000 },
  )

  const crons = useMemo(() => (data?.crons ?? []).filter((c) => matchesAny(c.account, accountFilter)), [data, accountFilter])
  // L'orchestratore non ha account AWS: con un filtro per account attivo le sue run non appartengono a
  // nessuno dei selezionati e sparirebbero. Si nasconde tutta la sorgente, invece di mostrarla a meta'.
  const prefect = !isFiltering(accountFilter) && !soloCron ? data?.prefect : null
  const tutti = useMemo(() => [...crons, ...prefectAsCrons(prefect, t)], [crons, prefect, t])
  const righe = useMemo(() => flattenRuns(crons, prefect), [crons, prefect])
  const inCorso = useMemo(() => tutti.filter((c) => (c.runs ?? []).some((r) => r.running)), [tutti])
  // L'orologio batte solo se c'e' una corsa viva: su una pagina di corse finite i numeri sono fermi.
  useTick(inCorso.length > 0)
  const now = Date.now()

  const cercato = (nome) => {
    const q = query.trim().toLowerCase()
    return !q || String(nome ?? '').toLowerCase().includes(q)
  }
  const problema = (l) => l === 'crit' || l === 'warn'

  // Per cron: dal piu' grave, poi per nome. Il problema e' lo STATO del cron (ultima corsa fallita,
  // non partito), non «ha una corsa rossa da qualche parte nella finestra» che resterebbe rosso per
  // giorni dopo essersi ripreso.
  const listaCron = useMemo(
    () =>
      tutti
        .map((c) => ({ c, stato: statoCron(c) }))
        .filter(({ c, stato }) => cercato(c.name) && (!soloProblemi || problema(stato)))
        .sort((a, b) => rangoLivello(a.stato) - rangoLivello(b.stato) || String(a.c.name).localeCompare(String(b.c.name))),
    [tutti, query, soloProblemi],
  )
  const listaCorse = useMemo(
    () => righe.filter((r) => cercato(r.cronName) && (!soloProblemi || problema(livelloCorsa(r)))),
    [righe, query, soloProblemi],
  )

  const stati = tutti.map(statoCron)
  const falliti = stati.filter((s) => s === 'crit').length
  const nonPartiti = stati.filter((s) => s === 'warn').length
  const corseFallite = righe.filter((r) => r.outcome === 'failed').length
  const prossima = useMemo(() => crons.filter((c) => c.nextRunAt).sort((a, b) => a.nextRunAt - b.nextRunAt)[0] ?? null, [crons])
  const cronOf = (riga) => tutti.find((c) => c.key === riga.cronKey) ?? { key: riga.cronKey, name: riga.cronName, runs: [riga] }
  const finestra = WINDOWS.find((w) => w.key === minutes)?.label ?? ''

  const verdetto = falliti
    ? {
        livello: 'crit',
        forte: t('rilasci.cron.v.falliti', { n: falliti }),
        resto: inCorso.length ? t('rilasci.cron.v.eInCorso', { n: inCorso.length }) : nonPartiti ? t('rilasci.cron.v.eNonPartiti', { n: nonPartiti }) : '',
      }
    : nonPartiti
      ? { livello: 'warn', forte: t('rilasci.cron.v.nonPartiti', { n: nonPartiti }), resto: inCorso.length ? t('rilasci.cron.v.eInCorso', { n: inCorso.length }) : '' }
      : inCorso.length
        ? { livello: 'info', forte: t('rilasci.cron.v.inCorso', { n: inCorso.length }), resto: t('rilasci.cron.v.restoOk') }
        : { livello: 'ok', forte: t('rilasci.cron.v.ok'), resto: '' }

  return (
    <div className="rl-pagina">
      <Verdetto
        livello={loading && !data ? null : verdetto.livello}
        forte={loading && !data ? null : verdetto.forte}
        resto={loading && !data ? t('rilasci.cron.v.attesa') : verdetto.resto}
        dettaglio={t('rilasci.cron.v.dettaglio', { n: tutti.length, finestra, f: corseFallite })}
      />

      {error && <div className="ui-readwarn">{error}</div>}
      {(data?.problems ?? []).map((p) => (
        <div key={p.account} className="ui-readwarn">
          {t('rilasci.nonLeggibile', { conto: p.account, errore: p.error })}
        </div>
      ))}
      {/* Sorgente configurata ma non raggiungibile: dirlo, altrimenti «nessun job dell'orchestratore»
          si legge come «nessuno sta girando», che e' la bugia peggiore su questa pagina. */}
      {data?.prefect?.error && <div className="ui-readwarn">{t('rilasci.nonLeggibile', { conto: 'Prefect', errore: data.prefect.error })}</div>}
      {data?.truncated && <div className="ui-readwarn">{t('runs.tooMany')}</div>}

      <div className="rl-tools">
        <input className="rl-cerca" type="search" placeholder={t('runs.search')} aria-label={t('runs.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="ui-seg" role="group" aria-label={t('rilasci.finestra')}>
          {WINDOWS.map((w) => (
            <button key={w.key} type="button" aria-pressed={minutes === w.key} onClick={() => setMinutes(w.key)}>
              {w.label}
            </button>
          ))}
        </div>
        <button type="button" className="rl-chip" aria-pressed={soloProblemi} onClick={() => setSoloProblemi((v) => !v)}>
          {t('runs.onlyProblems')}
        </button>
        {soloCron && (
          <button type="button" className="rl-chip" aria-pressed="true" onClick={() => setSoloCron(null)} title={t('rilasci.togliFiltro')}>
            {t('runs.onlyCron', { cron: soloCron.split('/').slice(1).join('/') })} ✕
          </button>
        )}
        {prossima && (
          <span className="ui-faint" style={{ marginLeft: 'auto', fontSize: 12.5 }}>
            {t('rilasci.cron.prossimaFlotta', { ora: hhmm(prossima.nextRunAt), nome: prossima.name })}
          </span>
        )}
      </div>

      {/* In corso ADESSO, in cima e in una sezione sua: e' la domanda per cui si apre questa pagina.
          La barra dice quanto e' passato rispetto al solito, e diventa arancio quando lo supera. */}
      {inCorso.length > 0 && (
        <Sezione titolo={t('runs.nowTitle')} sotto={t('rilasci.cron.inCorsoSotto')}>
          <Lista>
            {inCorso.map((c) => {
              const viva = c.runs.find((r) => r.running)
              const da = durataCorsa(viva, now) ?? 0
              const tipica = durataTipica(c)
              const pct = tipica ? (da / tipica) * 100 : null
              return (
                <button
                  key={c.key}
                  type="button"
                  className="ui-row ui-row-btn"
                  style={{ gridTemplateColumns: 'minmax(0,1.1fr) minmax(0,1.6fr) 150px 24px' }}
                  onClick={() => setAperta({ cron: c, run: viva })}
                >
                  <span className="ui-nm">
                    <span className="ui-kicon">⏱</span>
                    <span className="ui-name">
                      {c.name}
                      <small>{c.accountLabel}</small>
                    </span>
                  </span>
                  <span className="ui-what">
                    {t('rilasci.cron.inCorsoDa', { d: fmtMs(da) })}
                    <span className="ui-hint">
                      {tipica ? t(pct > 100 ? 'rilasci.cron.oltreSolito' : 'rilasci.cron.diSolito', { d: fmtMs(tipica) }) : t('rilasci.cron.senzaTipica')}
                    </span>
                  </span>
                  {pct != null ? <Meter valore={pct} livello={pct > 100 ? 'warn' : 'info'} title={`${Math.round(pct)}%`} /> : <span />}
                  <span className="ui-go">›</span>
                </button>
              )
            })}
          </Lista>
        </Sezione>
      )}

      <Tabs
        voci={[
          { key: 'cron', label: t('rilasci.cron.vistaCron'), n: listaCron.length },
          { key: 'lista', label: t('rilasci.cron.vistaCorse'), n: listaCorse.length },
        ]}
        attiva={vista}
        onCambia={scegliVista}
      />

      {loading && !data ? (
        <p className="ui-mute">{t('rilasci.cron.v.attesa')}</p>
      ) : vista === 'cron' ? (
        <Lista
          colonne={[t('rilasci.cron.col.cron'), t('rilasci.cron.col.ultima'), t('rilasci.cron.col.cosa'), t('rilasci.cron.col.corse'), '']}
          griglia={COLONNE_CRON}
          vuoto={t('runs.empty')}
        >
          {listaCron.map(({ c, stato }) => {
            const { cosa, hint } = cosaCron(c, stato, t, now)
            const ultima = (c.runs ?? []).find((r) => !r.running) ?? c.runs?.[0] ?? null
            return (
              <button
                key={c.key}
                type="button"
                className="ui-row ui-row-btn"
                style={{ gridTemplateColumns: COLONNE_CRON }}
                // data-cron: ancora per il video demo, come data-build sulla pagina Deploy.
                data-cron={c.name}
                onClick={() => setAperta({ cron: c, run: ultima })}
              >
                <span className="ui-nm">
                  <span className="ui-kicon">⏱</span>
                  <span className="ui-name">
                    {c.name}
                    <small>
                      {[c.accountLabel, c.scheduleMinutes ? fmtSchedule(`${c.scheduleMinutes}m`, t) : t(`runs.type.${c.type === 'lambda' ? 'lambda' : c.type === 'prefect' ? 'prefect' : 'ecs'}`)]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </span>
                </span>
                <Pill livello={stato}>{t(`rilasci.cron.stato.${stato}`)}</Pill>
                <span className="ui-what">
                  {cosa}
                  {hint && <span className="ui-hint">{hint}</span>}
                </span>
                <RunTimeline runs={c.runs ?? []} t={t} now={now} />
                <span className="ui-go">›</span>
              </button>
            )
          })}
        </Lista>
      ) : (
        <Lista
          colonne={[t('rilasci.cron.col.esito'), t('rilasci.cron.col.cron'), t('rilasci.cron.col.cosa'), t('runs.col.duration'), '']}
          griglia={COLONNE_CORSE}
          vuoto={t('runs.empty')}
        >
          {listaCorse.map((r) => {
            const d = durataCorsa(r, now)
            return (
              <button key={r.key} type="button" className="ui-row ui-row-btn" style={{ gridTemplateColumns: COLONNE_CORSE }} onClick={() => setAperta({ cron: cronOf(r), run: r })}>
                <Pill livello={livelloCorsa(r)}>{t(`runs.outcome.${r.outcome}`)}</Pill>
                <span className="ui-name">
                  {r.cronName}
                  <small>{[r.accountLabel, t(`runs.type.${r.cronType === 'lambda' ? 'lambda' : r.cronType === 'prefect' ? 'prefect' : 'ecs'}`)].filter(Boolean).join(' · ')}</small>
                </span>
                <span className="ui-what">
                  {r.startedAt ? `${new Date(r.startedAt).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${fmtAgo(r.startedAt, t)}` : '?'}
                  {motivoCorsa(r, t) && <span className="ui-hint">{motivoCorsa(r, t)}</span>}
                </span>
                <span className="ui-when ui-mono">{d != null ? fmtMs(d) : '?'}</span>
                <span className="ui-go">›</span>
              </button>
            )
          })}
        </Lista>
      )}

      {!soloCron && vista === 'cron' && listaCron.length > 0 && (
        <p className="ui-note">{t('rilasci.cron.nota')}</p>
      )}

      <RunLogsDrawer
        open={Boolean(aperta)}
        onClose={() => setAperta(null)}
        cron={aperta?.cron}
        run={aperta?.run}
        t={t}
        lang={lang}
        onSoloCron={aperta?.cron?.key && !String(aperta.cron.key).startsWith('prefect/') && !soloCron ? () => (setSoloCron(aperta.cron.key), setAperta(null)) : null}
      />
    </div>
  )
}
