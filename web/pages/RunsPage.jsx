import { useEffect, useMemo, useState } from 'react'
import { Verdetto, Lista, Sezione, Pill, Tabs, Meter } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import { fmtAgo, fmtMs, fmtSchedule } from '../format.js'
import { matchesAny, isFiltering, queryCerca } from '../filters.js'
import { rangoLivello } from '../adattatori.js'
import { livelloCorsa, durataCorsa, durataTipica, motivoCorsa, statoCron, nomeCron, avvisoReaper } from '../rilasci.js'
import { contaCron, verdettoCron } from '../../shared/cron.js'
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
const COLONNE_IN_CORSO = 'minmax(0,1.1fr) minmax(0,1.6fr) 150px 24px'
// Sul telefono la freccia (`.ui-go`) e le corse (`.rl-runs`) spariscono, e `.ui-what` va a tutta riga.
const COLONNE_CRON_M = 'minmax(0,1fr) auto'
const COLONNE_CORSE_M = 'auto minmax(0,1fr) auto'
const COLONNE_IN_CORSO_M = 'minmax(0,1fr)'
// La ricerca va anche al server (vedi `queryCerca`): si aspetta che chi scrive si fermi.
const ATTESA_CERCA_MS = 400

// Le run di tutti i cron, appiattite in righe: una riga = una esecuzione. Pura.
// Le corse del REAPER di un job (piegato nella sua riga, vedi `piegaReaper`) restano nella lista delle
// corse, col nome del job e `reaper` accanto: in una lista per orario una corsa è una corsa, e una
// fallita del reaper deve vedersi qui come quella di qualunque altro cron.
export function flattenRuns(crons = [], prefect = null) {
  const righe = []
  for (const c of crons.flatMap((x) => (x.reaper ? [x, { ...x.reaper, accountLabel: x.reaper.accountLabel ?? x.accountLabel }] : [x]))) {
    for (const r of c.runs ?? []) {
      righe.push({ ...r, key: `${c.key}#${r.id ?? r.startedAt}`, cronKey: c.key, cronName: nomeCron(c), cronType: c.type, account: c.account, accountLabel: c.accountLabel })
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
  const [cercaServer, setCercaServer] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setCercaServer(query), ATTESA_CERCA_MS)
    return () => clearTimeout(timer)
  }, [query])
  const [aperta, setAperta] = useState(null) // { cron, run } del pannello aperto
  // Cron scelto: la vista passa da «le ultime di tutti» a «tutte le sue». E' il server a leggere piu' a
  // fondo: filtrare qui non aggiungerebbe le corse che non sono state chieste.
  // Parte da `?cron=<account>/<nome>`: e' il link di ogni riga del canvas delle corse in Slack
  // (server/notify/corse.js), e il redirect da `/esecuzioni` lo tiene gia'. Senza, il link atterrava
  // sull'elenco di tutti i cron, da cercare a mano.
  const [soloCron, setSoloCron] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('cron') || null
    } catch {
      return null
    }
  })

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
  // Con un cron scelto la ricerca non va al server: quel cron e' gia' l'unico chiesto.
  const { data, loading, error } = usePoll(
    `/api/runs?minutes=${minutes}&lang=${lang}${soloCron ? `&cron=${encodeURIComponent(soloCron)}&limit=25` : queryCerca(cercaServer)}&k=${refreshKey ?? 0}`,
    { intervalMs: 30_000 },
  )

  // La risposta che c'e' e' ancora quella di PRIMA della ricerca (si aspetta che chi scrive si fermi, poi
  // il server): filtrarla qui darebbe «Nessuna esecuzione» per un cron che esiste ed e' solo oltre il
  // tetto. Si dice che si sta cercando. `data.query` assente = server che non cerca (demo): niente attesa.
  const cercato = queryCerca(query) ? query.trim().toLowerCase().slice(0, 64) : ''
  const inAttesa = !soloCron && data?.query !== undefined && data.query !== cercato
  const vuoto = inAttesa ? t('runs.cerco', { q: query.trim() }) : t('runs.empty')

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

  // Gli stessi campi della ricerca del server (scegliCron): un cron trovato per family dal server non
  // deve sparire qui perche' il nome dello schedule e' un altro.
  const trovati = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Anche sull'etichetta e sul Codice: si cerca quello che si VEDE, e il nome in vista è il percorso.
    const corrisponde = (c) => !q || [c.name, c.key, c.family, c.function, c.etichetta, c.codice].some((v) => String(v ?? '').toLowerCase().includes(q))
    // Il reaper segue il suo job: le sue corse stanno nella lista delle corse se il job è stato trovato.
    return new Set(tutti.filter(corrisponde).flatMap((c) => (c.reaper ? [c.key, c.reaper.key] : [c.key])))
  }, [tutti, query])
  const problema = (l) => l === 'crit' || l === 'warn'

  // Per cron: dal piu' grave, poi per nome. Il problema e' lo STATO del cron (ultima corsa fallita,
  // non partito), non «ha una corsa rossa da qualche parte nella finestra» che resterebbe rosso per
  // giorni dopo essersi ripreso.
  const listaCron = useMemo(
    () =>
      tutti
        .map((c) => ({ c, stato: statoCron(c) }))
        .filter(({ c, stato }) => trovati.has(c.key) && (!soloProblemi || problema(stato)))
        .sort((a, b) => rangoLivello(a.stato) - rangoLivello(b.stato) || nomeCron(a.c).localeCompare(nomeCron(b.c))),
    [tutti, trovati, soloProblemi],
  )
  // I cron della squadra infra (`infra: true`, lo decide il server con DADAGUARD_CORSE_INFRA) vanno
  // dopo quelli del prodotto, in una sezione loro: chi apre la pagina cerca prima i cron del prodotto.
  // Il verdetto qui sopra li conta lo stesso.
  const listaProdotto = useMemo(() => listaCron.filter(({ c }) => !c.infra), [listaCron])
  const listaInfra = useMemo(() => listaCron.filter(({ c }) => c.infra), [listaCron])
  const listaCorse = useMemo(
    () => righe.filter((r) => trovati.has(r.cronKey) && (!soloProblemi || problema(livelloCorsa(r)))),
    [righe, trovati, soloProblemi],
  )

  // I conti e il verdetto vengono da shared/cron.js: sono gli stessi del canvas delle corse in Slack.
  const { falliti, nonPartiti } = contaCron(tutti)
  const corseFallite = righe.filter((r) => r.outcome === 'failed').length
  const prossima = useMemo(() => crons.filter((c) => c.nextRunAt).sort((a, b) => a.nextRunAt - b.nextRunAt)[0] ?? null, [crons])
  // Una corsa del reaper apre il pannello del reaper: sta dentro la riga del job, non nella lista.
  const cronOf = (riga) =>
    tutti.find((c) => c.key === riga.cronKey) ??
    tutti.find((c) => c.reaper?.key === riga.cronKey)?.reaper ?? { key: riga.cronKey, name: riga.cronName, runs: [riga] }
  const finestra = WINDOWS.find((w) => w.key === minutes)?.label ?? ''

  const v = verdettoCron({ falliti, nonPartiti, inCorso: inCorso.length })

  const rigaCron = ({ c, stato }) => {
    const { cosa, hint: hintCorsa } = cosaCron(c, stato, t, now)
    const hint = avvisoReaper(c, t) ?? hintCorsa
    const ultima = (c.runs ?? []).find((r) => !r.running) ?? c.runs?.[0] ?? null
    return (
      <button
        key={c.key}
        type="button"
        className="ui-row ui-row-btn"
        // data-cron: ancora per il video demo, come data-build sulla pagina Deploy.
        data-cron={c.name}
        onClick={() => setAperta({ cron: c, run: ultima })}
      >
        <span className="ui-nm">
          <span className="ui-kicon">⏱</span>
          <span className="ui-name" title={nomeCron(c) !== c.name ? c.name : undefined}>
            {nomeCron(c)}
            <small>
              {[
                c.accountLabel,
                c.scheduleMinutes ? fmtSchedule(`${c.scheduleMinutes}m`, t) : t(`runs.type.${c.type === 'lambda' ? 'lambda' : c.type === 'prefect' ? 'prefect' : 'ecs'}`),
                c.reaper ? t('rilasci.cron.conReaper') : null,
              ]
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
  }
  const colonneCron = [t('rilasci.cron.col.cron'), t('rilasci.cron.col.ultima'), t('rilasci.cron.col.cosa'), t('rilasci.cron.col.corse'), '']
  const verdetto = { livello: v.livello, forte: t(...v.forte), resto: v.resto ? t(...v.resto) : '' }

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
      {/* Troncata: quanti ne restano fuori, e che il verdetto qui sopra vale solo per quelli letti.
          Un cron fallito oltre il tetto non si vede, e la pagina deve dirlo invece di dire «tutto ok». */}
      {data?.truncated && <div className="ui-readwarn">{t('runs.tooMany', { n: data.crons?.length ?? 0, tot: data.total ?? '?' })}</div>}

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
            {t('rilasci.cron.prossimaFlotta', { ora: hhmm(prossima.nextRunAt), nome: nomeCron(prossima) })}
          </span>
        )}
      </div>

      {/* In corso ADESSO, in cima e in una sezione sua: e' la domanda per cui si apre questa pagina.
          La barra dice quanto e' passato rispetto al solito, e diventa arancio quando lo supera. */}
      {inCorso.length > 0 && (
        <Sezione titolo={t('runs.nowTitle')} sotto={t('rilasci.cron.inCorsoSotto')}>
          <Lista griglia={COLONNE_IN_CORSO} grigliaMobile={COLONNE_IN_CORSO_M}>
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
                  onClick={() => setAperta({ cron: c, run: viva })}
                >
                  <span className="ui-nm">
                    <span className="ui-kicon">⏱</span>
                    <span className="ui-name">
                      {nomeCron(c)}
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
        <>
          {(listaProdotto.length > 0 || listaInfra.length === 0) && (
            <Lista colonne={colonneCron} griglia={COLONNE_CRON} grigliaMobile={COLONNE_CRON_M} vuoto={vuoto}>
              {listaProdotto.map(rigaCron)}
            </Lista>
          )}
          {listaInfra.length > 0 && (
            <Sezione titolo={t('rilasci.cron.infra')} sotto={t('rilasci.cron.infraSotto')}>
              <Lista colonne={colonneCron} griglia={COLONNE_CRON} grigliaMobile={COLONNE_CRON_M}>
                {listaInfra.map(rigaCron)}
              </Lista>
            </Sezione>
          )}
        </>
      ) : (
        <Lista
          colonne={[t('rilasci.cron.col.esito'), t('rilasci.cron.col.cron'), t('rilasci.cron.col.cosa'), t('runs.col.duration'), '']}
          griglia={COLONNE_CORSE}
          grigliaMobile={COLONNE_CORSE_M}
          vuoto={vuoto}
        >
          {listaCorse.map((r) => {
            const d = durataCorsa(r, now)
            return (
              <button key={r.key} type="button" className="ui-row ui-row-btn" onClick={() => setAperta({ cron: cronOf(r), run: r })}>
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
