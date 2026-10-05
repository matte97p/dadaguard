import { useEffect, useState } from 'react'
import { Drawer, Rimedio, ListaLink, Lista, Sezione, Pill } from '../ui/index.js'
import { LogLines } from '../logline.jsx'
import { fmtAgo, fmtMs, fmtSchedule } from '../format.js'
import { livelloCorsa, durataCorsa, durataTipica, motivoCorsa, comandoCron, linkCron } from '../rilasci.js'

// Il pannello di UN cron, e dentro i log di UNA sua corsa, non «gli ultimi log di quel job».
//
// E' la differenza che rende utile la pagina: aprendo i log di un cron si legge quello che c'e' ADESSO
// nel log group, cioe' (su un job giornaliero) la corsa di stanotte mescolata a quella di ieri. Qui la
// finestra e' quella della corsa scelta (inizio e fine, piu' un minuto di coda per l'ultima riga di un
// traceback) e, dove esiste, lo stream e' quello del suo task: nessuna riga di un'altra corsa.
//
// Su una corsa IN CORSO il pannello si ricarica da se': e' il caso per cui la vista esiste (uno scraper
// a meta' lavoro), e chiedere di premere «Aggiorna» ogni dieci secondi non e' guardare un job che gira.
const LIVE_MS = 10_000

const ora = (ms) => (ms ? new Date(ms).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?')

export default function RunLogsDrawer({ open, onClose, cron, run, t = (k) => k, lang, onSoloCron = null }) {
  // La corsa di cui si leggono i log: parte da quella scelta nella pagina e si cambia dall'elenco.
  const [scelta, setScelta] = useState(run ?? null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => setScelta(run ?? null), [run?.id, run?.startedAt, open])

  const corsa = scelta
  useEffect(() => {
    if (!open || !corsa) return undefined
    let stale = false
    const carica = () => {
      setLoading(true)
      setError(null)
      const q = new URLSearchParams({ lang: lang ?? '', errorsOnly: String(errorsOnly), limit: '400' })
      if (corsa.source === 'prefect') {
        q.set('source', 'prefect')
        q.set('run', corsa.id)
      } else {
        q.set('cron', cron?.key ?? '')
        q.set('run', corsa.id ?? '')
        if (corsa.stream) q.set('stream', corsa.stream)
        if (corsa.startedAt) q.set('from', String(corsa.startedAt))
        if (corsa.endedAt) q.set('to', String(corsa.endedAt))
      }
      fetch(`/api/runs/logs?${q}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => !stale && setData(d))
        .catch((e) => !stale && setError(e.message))
        .finally(() => !stale && setLoading(false))
    }
    setData(null)
    carica()
    // Corsa finita: niente polling. Il log di una corsa chiusa non cambia piu', e ricaricarlo e' solo
    // traffico verso CloudWatch per riscrivere le stesse righe.
    const timer = corsa.running ? setInterval(carica, LIVE_MS) : null
    return () => {
      stale = true
      if (timer) clearInterval(timer)
    }
  }, [open, cron?.key, corsa?.id, corsa?.running, corsa?.endedAt, errorsOnly, reloadKey, lang])

  if (!open) return null
  const eventi = data?.events ?? []
  const tipica = durataTipica(cron)
  const motivo = motivoCorsa(corsa, t)
  const livello = corsa ? livelloCorsa(corsa) : 'off'
  const runs = cron?.runs ?? []

  return (
    <Drawer
      aperto={open}
      onChiudi={onClose}
      etichettaChiudi={t('ui.chiudi')}
      sopra={corsa ? <Pill livello={livello}>{t(`runs.outcome.${corsa.outcome}`)}</Pill> : null}
      titolo={cron?.name ?? corsa?.cron ?? ''}
      sotto={[cron?.accountLabel, cron?.scheduleMinutes ? fmtSchedule(`${cron.scheduleMinutes}m`, t) : null].filter(Boolean).join(' · ')}
    >
      {/* Il motivo prima di tutto: «uscita 137, memoria esaurita» chiude la domanda senza aprire i
          log, e il comando accanto e' il passo dopo se non basta. */}
      {motivo && (
        <Rimedio
          livello={livello}
          titolo={t('rilasci.cron.fallitaTitolo', { quando: ora(corsa.startedAt) })}
          testo={motivo}
          comando={comandoCron(cron)}
          t={t}
        />
      )}
      {corsa?.running && <Rimedio livello="info" titolo={t('runs.live')} testo={t('runs.logs.live')} t={t} />}

      <dl className="rl-kv">
        <dt>{t('rilasci.cron.kv.tipo')}</dt>
        <dd>{t(cron?.type === 'lambda' ? 'runs.type.lambda' : cron?.type === 'prefect' ? 'runs.type.prefect' : 'runs.type.ecs')}</dd>
        <dt>{t('rilasci.cron.kv.prossima')}</dt>
        <dd>{cron?.nextRunAt ? ora(cron.nextRunAt) : cron?.enabled === false ? t('runs.disabled') : t('rilasci.nonSo')}</dd>
        <dt>{t('rilasci.cron.kv.tipica')}</dt>
        <dd>{tipica ? fmtMs(tipica) : t('rilasci.nonSo')}</dd>
        {corsa && (
          <>
            <dt>{t('rilasci.cron.kv.durata')}</dt>
            <dd>{durataCorsa(corsa) != null ? fmtMs(durataCorsa(corsa)) : '?'}</dd>
            <dt>{t('rilasci.cron.kv.corsa')}</dt>
            <dd className="ui-mono">{String(corsa.id ?? '').slice(0, 12) || '?'}</dd>
          </>
        )}
        {(data?.logGroup || cron?.logGroup) && (
          <>
            <dt>{t('logs.group')}</dt>
            <dd className="ui-mono">{data?.logGroup ?? cron.logGroup}</dd>
          </>
        )}
      </dl>

      {runs.length > 0 && (
        <Sezione
          titolo={t('rilasci.cron.corse')}
          sotto={t('rilasci.cron.corseSotto')}
          // Nella pagina ogni cron porta solo le sue ultime corse: «fammi vedere solo questo, piu' a
          // fondo» e' la mossa naturale dopo aver visto una riga rossa.
          extra={
            onSoloCron && (
              <button type="button" className="rl-chip" onClick={onSoloCron}>
                {t('rilasci.cron.tutteSue')}
              </button>
            )
          }
        >
          <Lista griglia="92px minmax(0,1fr) auto">
            {runs.map((r) => (
              <button
                key={r.id ?? r.startedAt}
                type="button"
                className="ui-row ui-row-btn"
                style={{ background: r === corsa ? 'var(--brand-soft)' : undefined }}
                aria-pressed={r === corsa}
                onClick={() => setScelta(r)}
              >
                <Pill livello={livelloCorsa(r)}>{t(`runs.outcome.${r.outcome}`)}</Pill>
                <span className="ui-what">
                  {ora(r.startedAt)}
                  {motivoCorsa(r, t) && <span className="ui-hint">{motivoCorsa(r, t)}</span>}
                </span>
                <span className="ui-when">{durataCorsa(r) != null ? fmtMs(durataCorsa(r)) : fmtAgo(r.startedAt, t)}</span>
              </button>
            ))}
          </Lista>
        </Sezione>
      )}

      {corsa && (
        <Sezione
          titolo={t('rilasci.cron.log')}
          extra={
            <span className="rl-log-tools">
              <button type="button" className="rl-chip" aria-pressed={errorsOnly} onClick={() => setErrorsOnly((v) => !v)}>
                {t('logs.errorsOnly')}
              </button>
              <button type="button" className="rl-chip" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
                {loading ? t('logs.loading') : t('logs.refresh')}
              </button>
            </span>
          }
        >
          {error && <div className="ui-readwarn">{error}</div>}
          {data?.error && <div className="ui-readwarn">{data.error}</div>}
          {loading && !eventi.length ? (
            <p className="ui-mute">{t('logs.loading')}</p>
          ) : data?.notApplicable ? (
            <p className="ui-mute">{t('logs.notApplicable')}</p>
          ) : data && eventi.length === 0 ? (
            // Una corsa senza NESSUNA riga e' il caso in cui il task e' morto prima di scrivere (immagine
            // che non parte, segreto mancante): dirlo indirizza la ricerca.
            <p className="ui-mute">{t('runs.logs.empty')}</p>
          ) : eventi.length > 0 ? (
            <>
              <p className="ui-faint" style={{ margin: '0 0 4px', fontSize: 12 }}>
                {eventi.length}
                {data?.truncated ? ` · ${t('runs.logs.truncated')}` : ''}
              </p>
              <LogLines events={eventi} maxHeight="56vh" />
            </>
          ) : null}
        </Sezione>
      )}

      {linkCron(cron, t).length > 0 && (
        <Sezione titolo={t('rilasci.altrove')}>
          <ListaLink link={linkCron(cron, t)} />
        </Sezione>
      )}
    </Drawer>
  )
}
