import { useEffect, useState } from 'react'
import { Drawer, Tabs, Pill, Lista, Sezione, Rimedio, ListaLink, Meter } from '../ui/index.js'
import { detailTabs } from '../format.js'
import { livelloServizio, ownerServizio, comandoServizio } from '../adattatori.js'
import { controlliDi, cosaSuccede, altriProblemi, linkAltrove, sloDi, pct, diChi } from '../servizi.js'
import { etichettaServizio, tipoLabel, latenzaTesto } from './ServicesTable.jsx'
import LogsPanel from './LogsPanel.jsx'
import EventsPanel from './EventsPanel.jsx'
import InstancesPanel from './InstancesPanel.jsx'
import './servizi.css'

// Pannello unico per servizio, come nel mockup: prima cosa succede e cosa fare (col comando da
// copiare), poi i controlli spiegati uno per uno, la disponibilita' del mese contro l'obiettivo, le
// ultime righe di log, i link alle console che ne sanno di piu' e di chi e'. Istanze, log completi
// ed eventi restano in schede: si montano solo quando le apri, quindi aprire un servizio non scarica
// tutto il suo storico.
//
// Il bottone "Costi" resta TOLTO: la pagina Spesa ragiona per servizio AWS (EC2, S3, Bedrock), non
// per servizio monitorato, e da qui portava a numeri che non parlano di questo servizio.
export default function ServiceDetailDrawer({
  service,
  tab = 'overview',
  onTab,
  logsDefaultMinutes = 60,
  logsDefaultErrorsOnly = false,
  onClose,
  onNavigate,
  onDrift,
  onRemove,
  t = (k) => k,
  lang,
}) {
  const has = detailTabs(service)
  // Richiesta «apri i log DI QUESTA istanza» dalla scheda Istanze. Un oggetto nuovo a ogni clic, non
  // il solo id: ricliccare lo stesso task deve riapplicare il filtro anche se nel frattempo il
  // pannello log e' tornato su «Tutte». Si azzera cambiando servizio.
  const [logFocus, setLogFocus] = useState(null)
  useEffect(() => {
    setLogFocus(null)
  }, [service?.name, service?.account?.key])

  const schede = [
    { key: 'overview', label: t('detail.tab.overview') },
    has.instances && { key: 'instances', label: t('instances.button') },
    has.logs && { key: 'logs', label: t('logs.button') },
    has.events && { key: 'events', label: t('events.button') },
  ].filter(Boolean)
  // Se il servizio aperto non ha la scheda richiesta (i log di un bucket S3) si torna alla
  // panoramica, invece di mostrare una scheda vuota.
  const attiva = schede.some((s) => s.key === tab) ? tab : 'overview'
  const livello = service ? livelloServizio(service) : 'off'

  return (
    <Drawer
      aperto={Boolean(service)}
      onChiudi={onClose}
      titolo={service?.name}
      sopra={service && <Pill livello={livello}>{etichettaServizio(service, t)}</Pill>}
      sotto={
        service &&
        [service.account?.label, tipoLabel(service.type, t), service.region, t(`home.tocca.${ownerServizio(service)}`)]
          .filter(Boolean)
          .join(' · ')
      }
      etichettaChiudi={t('ui.chiudi')}
    >
      {service && (
        <>
          {/* Una scheda sola non e' una scelta: la barra sarebbe decorazione. */}
          {schede.length > 1 && <Tabs voci={schede} attiva={attiva} onCambia={onTab} />}
          {attiva === 'overview' && (
            <Panoramica
              s={service}
              livello={livello}
              has={has}
              onNavigate={onNavigate}
              onDrift={onDrift}
              onRemove={onRemove}
              onTab={onTab}
              t={t}
              lang={lang}
            />
          )}
          {attiva === 'instances' && (
            <InstancesPanel
              service={service.name}
              account={service.account?.key}
              resourceId={service.resourceId}
              onTaskLogs={(taskId, allTasks) => {
                setLogFocus({ task: taskId, tasks: allTasks ?? [] })
                onTab?.('logs')
              }}
              t={t}
              lang={lang}
            />
          )}
          {attiva === 'logs' && (
            <LogsPanel
              service={service.name}
              account={service.account?.key}
              resourceId={service.resourceId}
              focus={logFocus}
              defaultMinutes={logsDefaultMinutes}
              defaultErrorsOnly={logsDefaultErrorsOnly}
              t={t}
              lang={lang}
            />
          )}
          {attiva === 'events' && (
            <EventsPanel service={service.name} account={service.account?.key} resourceId={service.resourceId} t={t} lang={lang} />
          )}
        </>
      )}
    </Drawer>
  )
}

function Panoramica({ s, livello, has, onNavigate, onDrift, onRemove, onTab, t, lang }) {
  const problema = livello === 'crit' || livello === 'warn'
  const cosa = cosaSuccede(s)
  const altri = altriProblemi(s)
  // Il comando: quello del controllo colpevole, se il server l'ha messo li', poi quello del servizio.
  const comando = (s.cause && s.checks?.[s.cause]?.comando) || comandoServizio(s)
  const controlli = controlliDi(s)
  const slo = sloDi(s)
  const link = linkAltrove(s, t)
  const chi = diChi(s)
  const lat = latenzaTesto(s, t)
  const [togli, setTogli] = useState(false)

  return (
    <>
      {cosa && (
        <div>
          <b>{cosa}</b>
          {altri > 0 && <div className="ui-mute">{t('svc.altriControlli', { n: altri })}</div>}
        </div>
      )}

      {problema ? (
        <Rimedio
          livello={livello}
          titolo={comando ? t('svc.cosaFare') : t('svc.cosaFareSenzaComando')}
          testo={t(`svc.rimedio.${ownerServizio(s)}`)}
          comando={comando}
          t={t}
        />
      ) : (
        <Rimedio titolo={t('svc.nienteDaFare')} testo={livello === 'off' ? t('svc.spentoSpiega') : t('svc.tuttoVerde')} t={t} />
      )}

      {controlli.length > 0 && (
        <Sezione titolo={t('svc.controlli')} sotto={t('svc.controlliSotto')}>
          <Lista>
            {controlli.map((c) => (
              <div key={c.chiave} className="ui-row" style={{ gridTemplateColumns: '96px minmax(0, 1fr)' }}>
                <Pill livello={c.livello}>{c.livello === 'off' ? t('svc.nd') : t(`home.liv.${c.livello}`)}</Pill>
                <span className="ui-what">
                  <b>{t(`svc.ck.${c.chiave}`)}</b> <span className="ui-mute">{t(`svc.ckSpiega.${c.chiave}`)}</span>
                  {c.testo && <span className="ui-hint">{c.testo}</span>}
                </span>
              </div>
            ))}
          </Lista>
        </Sezione>
      )}

      <dl className="sv-kv">
        {s.account?.label && (
          <>
            <dt>{t('svc.kv.ambiente')}</dt>
            <dd>{[s.account.label, s.region].filter(Boolean).join(' · ')}</dd>
          </>
        )}
        {lat && (
          <>
            <dt>{t('svc.kv.latenza')}</dt>
            <dd className="ui-mono">{lat}</dd>
          </>
        )}
        {s.checks?.runtime?.nextRunLabel && (
          <>
            <dt>{t('svc.kv.prossima')}</dt>
            <dd>{s.checks.runtime.nextRunLabel}</dd>
          </>
        )}
        {s.resourceId && (
          <>
            <dt>{t('svc.kv.risorsa')}</dt>
            <dd className="ui-mono ui-mute">{s.resourceId}</dd>
          </>
        )}
      </dl>

      <Sezione titolo={t('svc.disponibilita')}>
        <Slo slo={slo} t={t} lang={lang} />
      </Sezione>

      {has.logs && problema && <UltimeRighe s={s} onTutte={() => onTab?.('logs')} t={t} lang={lang} />}

      {link.length > 0 && (
        <Sezione titolo={t('svc.altrove')} sotto={t('svc.altroveSotto')}>
          <ListaLink link={link} />
        </Sezione>
      )}

      {chi && (
        <Sezione titolo={t('svc.diChi')}>
          <dl className="sv-kv">
            {chi.team && (
              <>
                <dt>{t('svc.kv.team')}</dt>
                <dd>{chi.team}</dd>
              </>
            )}
            {chi.slack && (
              <>
                <dt>{t('svc.kv.canale')}</dt>
                <dd className="ui-mono">{chi.slack}</dd>
              </>
            )}
            {chi.runbook && (
              <>
                <dt>{t('svc.kv.runbook')}</dt>
                <dd>
                  {/^https?:\/\//.test(chi.runbook) ? (
                    <a href={chi.runbook} target="_blank" rel="noopener noreferrer">
                      {chi.runbook}
                    </a>
                  ) : (
                    chi.runbook
                  )}
                </dd>
              </>
            )}
          </dl>
        </Sezione>
      )}

      <div className="sv-azioni">
        {has.deploy && (
          // Col servizio in query: la pagina Deploy si apre gia' filtrata su questo servizio.
          <button type="button" className="ui-kbd" onClick={() => onNavigate?.(`/deploy?service=${encodeURIComponent(s.name)}`)}>
            {t('svc.az.deploy')}
          </button>
        )}
        <button type="button" className="ui-kbd" onClick={() => onNavigate?.('/topologia')}>
          {t('svc.az.dipende')}
        </button>
        {onDrift && s.checks?.drift && (
          <button type="button" className="ui-kbd" onClick={onDrift}>
            {t('svc.az.terraform')}
          </button>
        )}
        {/* Togliere dalla lista chiede conferma con un secondo clic sullo stesso bottone: niente
            finestra in piu' sopra il pannello, e un clic sbagliato da solo non cancella niente. */}
        {onRemove && (
          <button type="button" className="ui-kbd" onClick={() => (togli ? onRemove(s) : setTogli(true))} onBlur={() => setTogli(false)}>
            {togli ? t('svc.az.togliConferma') : t('svc.az.togli')}
          </button>
        )}
      </div>
      <p className="ui-note">{t('home.soloLettura')}</p>
    </>
  )
}

// Obiettivo e budget d'errore. Senza obiettivo lo si dice, con il tag che serve per metterlo: il
// numero lo decide chi possiede il servizio, Dadaguard non se lo inventa.
function Slo({ slo, t, lang }) {
  if (!slo) return <p className="ui-note">{t('svc.slo.nessuno')}</p>
  const obiettivo = pct(slo.obiettivo, lang, 2)
  return (
    <div className="sv-slo">
      <div className="sv-slo-h">
        <b>{t('svc.slo.obiettivo', { pct: obiettivo })}</b>
        {slo.rimasto != null && (
          <Pill livello={slo.livello}>{slo.sforato ? t('svc.slo.finito') : t('svc.slo.rimasto', { n: slo.rimasto })}</Pill>
        )}
      </div>
      {slo.rimasto != null && <Meter valore={slo.rimasto} livello={slo.livello} />}
      <span className="ui-faint">
        {slo.disponibilita != null ? t('svc.slo.misurata', { pct: pct(slo.disponibilita, lang, 2) }) : t('svc.slo.nonMisurata')}
        {slo.sforato ? ` ${t('svc.slo.sforatoSpiega')}` : ''}
      </span>
    </div>
  )
}

// Le ultime righe di errore dell'ultima ora: la domanda «cosa dice?» ha quasi sempre risposta li'.
// Si chiedono solo per un servizio con un problema: su uno sano sarebbe una lettura dei log a ogni
// apertura del pannello per non mostrare niente.
function UltimeRighe({ s, onTutte, t, lang }) {
  const [righe, setRighe] = useState(null)
  useEffect(() => {
    let vivo = true
    setRighe(null)
    const q = new URLSearchParams({
      service: s.name,
      errorsOnly: 'true',
      skipHealth: 'true',
      minutes: '60',
      lang: lang ?? '',
    })
    if (s.account?.key) q.set('account', s.account.key)
    if (s.resourceId) q.set('resourceId', s.resourceId)
    fetch(`/api/logs?${q}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => vivo && setRighe(d?.notApplicable || d?.error ? [] : (d?.events ?? []).slice(-5)))
      .catch(() => vivo && setRighe([]))
    return () => {
      vivo = false
    }
  }, [s.name, s.account?.key, s.resourceId, lang])
  if (righe == null || righe.length === 0) return null
  const ora = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '')
  return (
    <Sezione
      titolo={t('svc.log')}
      sotto={t('svc.logSotto')}
      extra={
        <button type="button" className="ui-kbd" onClick={onTutte}>
          {t('svc.logTutti')}
        </button>
      }
    >
      <pre className="sv-logs">{righe.map((e) => `${ora(e.ts)} ${String(e.message ?? '').trim()}`).join('\n')}</pre>
    </Sezione>
  )
}
