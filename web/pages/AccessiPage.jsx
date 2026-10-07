import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { Verdetto, Lista, Sezione, Pill, ListaLink } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import PollStatus from '../components/PollStatus.jsx'
import Loading from '../components/Loading.jsx'
import { fmtAgo, fmtMs } from '../format.js'
import { cercaVoce, daSistemare, destinazioneVista, filtraRighe, inOrdine, linkAudit, proprietariMacchine } from '../accessi.js'
import './ops.css'
import './accessi.css'

// Superficie "Accessi": chi entra dove, e se qualcosa negli accessi non va ADESSO.
//
// Perché questa pagina esiste: i dati c'erano già tutti e non li guardava nessuno. Il 28/08/2026 un
// connector applicato con ruoli inesistenti ha chiuso fuori dal login tutto il team per due ore, e la
// notizia è arrivata come un messaggio in chat mentre la riga con la causa era nel log dal primo
// tentativo.
//
// ⚠️ Read-only per costruzione. I bottoni che AGISCONO stanno nella Web UI di Teleport, che ha l'audit
// e il replay: qui ci sono i link. Una piattaforma che osserva e che può anche scrivere diventa una
// via d'accesso, ed è il contrario del motivo per cui la guardi.
//
// ── Perché è fatta così (rifatta il 07/10/2026) ────────────────────────────────────────────────────
// La stesura di prima teneva insieme due mestieri (gli accessi e la salute dei Mac del dev-env) e
// apriva con cinque riassunti che ripetevano gli stessi numeri: il titolo, «da guardare:», due card di
// conteggi, «guardato e a posto», e poi le schede coi conteggi. Sotto, tabelle larghe dove una riga
// sana pesava quanto una rotta. Ora:
//   · i Mac del dev-env hanno la loro pagina (Flotta), e `?vista=devEnv` ci rimanda;
//   · in cima UNA frase («3 cose da sistemare», «Tutto in ordine») e sotto UN elenco in ordine di
//     urgenza, ognuna con chi, cosa, quando e il posto dove si agisce (`daSistemare()` in accessi.js);
//   · tutto il resto (le persone in ordine, i database letti, le sessioni chiuse) sta chiuso sotto una
//     riga sola, e si apre per chi lo cerca;
//   · la mappa «chi ha cosa» resta raggiungibile, ma in fondo e chiusa: e' un elenco da consultare,
//     non una cosa da sistemare, e non deve pesare quanto l'elenco di sopra.

// I gradini della finestra li dichiara `server/finestre.conf` e li serve `/api/finestre`. Il ripiego
// serve al primo caricamento e al caso in cui quella chiamata non risponda.
const FINESTRE_RIPIEGO = [1, 6, 24, 168]

// «3m fa» in chiaro, il timestamp intero al passaggio del mouse: la domanda è sempre «è di adesso?».
function Quando({ ts, t, lang }) {
  if (!ts) return null
  return (
    <span className="ui-when" title={new Date(ts).toLocaleString(lang === 'it' ? 'it-IT' : 'en-GB')}>
      {fmtAgo(ts, t)}
    </span>
  )
}

// Un nome che porta al suo audit in Teleport, quando la config dice come. Senza modello resta testo.
function Nome({ href, children }) {
  if (!href) return <span>{children}</span>
  return (
    <a href={href} target="_blank" rel="noreferrer" className="acc-link">
      {children}
    </a>
  )
}

// La finestra come pillole della barra (`ui-seg`).
function Finestra({ ore, gradini, onChange, t }) {
  if (!gradini?.length || gradini.length < 2) return null
  const etichetta = (h) => (h < 24 ? `${h}h` : h % 24 === 0 && h < 168 ? `${h / 24}g` : h === 168 ? '7g' : `${Math.round(h / 24)}g`)
  return (
    <div className="ui-seg" role="group" aria-label={t('finestra.label')}>
      {gradini.map((h) => (
        <button key={h} type="button" aria-pressed={ore === h} onClick={() => onChange(h)}>
          {etichetta(h)}
        </button>
      ))}
    </div>
  )
}

// Una sezione chiusa di default: una riga che dice cosa c'e' dentro, e si apre col clic o con Invio.
function Chiusa({ id, titolo, riassunto, aperta, onApri, children, t }) {
  return (
    <section className="ui-sezione" id={id}>
      <h2>{titolo}</h2>
      <button type="button" className="acc-chiusa" aria-expanded={aperta} aria-controls={`${id}-dentro`} onClick={() => onApri(!aperta)}>
        <span className="acc-chiusa-testo">{riassunto}</span>
        <span className="acc-chiusa-azione">{aperta ? t('accessi.chiudi') : t('accessi.mostra')}</span>
      </button>
      {aperta && (
        <div id={`${id}-dentro`} className="acc-dentro">
          {children}
        </div>
      )}
    </section>
  )
}

export default function AccessiPage({ t, lang }) {
  // ⚠️ Parte da UN'ORA e non da 24: questa pagina si apre durante un guasto, e la finestra larga
  // costava l'attesa che l'ha fatta sembrare rotta.
  const [ore, setOre] = useState(1)
  const [gradini, setGradini] = useState(FINESTRE_RIPIEGO)
  useEffect(() => {
    fetch('/api/finestre')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const f = d?.finestre?.find((x) => x.chiave === 'teleport')
        if (f?.max) setGradini(FINESTRE_RIPIEGO.filter((g) => g <= f.max))
      })
      .catch(() => {})
  }, [])

  // I link di prima (`?vista=persone`, `?vista=database`, quelli dei messaggi Slack gia' nel canale)
  // portano ancora nel posto giusto: un'ancora dell'elenco, la mappa aperta, o la pagina Flotta.
  const [params] = useSearchParams()
  const { hash } = useLocation()
  const destinazione = destinazioneVista(params.get('vista'), hash)
  const [query, setQuery] = useState('')
  const [restoAperto, setRestoAperto] = useState(false)
  const [mappaAperta, setMappaAperta] = useState(destinazione.ancora === 'chiHaCosa')

  const { data: dati, loading, refreshing, error: errore, lastUpdated } = usePoll(`/api/teleport?ore=${ore}`, {
    intervalMs: 20000,
    enabled: !destinazione.flotta,
  })
  // La mappa (chi ha cosa) e' una lettura a parte e cara (tre fonti), e si carica solo da aperta.
  const { data: mappa, refreshing: mappaRefreshing, error: mappaErrore } = usePoll('/api/accessi/mappa?ore=168', {
    intervalMs: 120000,
    enabled: mappaAperta && !destinazione.flotta,
  })

  const audit = dati?.audit ?? {}
  const battito = dati?.heartbeat
  const voci = useMemo(() => daSistemare(audit, { proprietari: proprietariMacchine(battito) }), [audit, battito])
  const resto = useMemo(() => inOrdine(audit, voci), [audit, voci])

  // L'ancora si raggiunge quando la pagina c'e': prima dei dati l'elemento non esiste ancora.
  const pronta = Boolean(dati)
  useEffect(() => {
    if (!pronta || !destinazione.ancora) return
    const el = document.getElementById(destinazione.ancora) ?? document.querySelector(`[data-ancora="${destinazione.ancora}"]`)
    el?.scrollIntoView({ block: 'start' })
  }, [pronta, destinazione.ancora])

  if (destinazione.flotta) return <Navigate to={destinazione.flotta} replace />
  if (errore && !dati) return <div className="ui-readwarn">{String(errore)}</div>
  if (loading || !dati) return <Loading text={t('accessi.caricamento')} />

  // Senza la sezione `teleport:` nella config non si mostra un vuoto che sembra un guasto.
  if (!dati.configurato) {
    return (
      <div className="ui-pagina">
        <Verdetto resto={t('accessi.title')} dettaglio={t('accessi.desc')} />
        <Lista vuoto={t('accessi.nonConfigurato')}>{[]}</Lista>
      </div>
    )
  }

  const ultime = (n) => (n === 1 ? t('accessi.ultimaOra') : t('accessi.ultimeOre', { n }))
  const finestraDetta = audit.ore && audit.ore !== ore ? `${ultime(audit.ore)} · ${t('accessi.inAggiornamento')}` : ultime(audit.ore ?? ore)

  const filtrate = filtraRighe(voci, { cerca: cercaVoce, query })
  const persone = filtraRighe(resto.persone, { cerca: (p) => [p.utente, ...(p.db ?? []).map((d) => d.nome)], query })
  const database = filtraRighe(resto.database, { cerca: (d) => [d.nome, d.servizio, d.ambiente, ...(d.chi ?? [])], query })
  const ssh = filtraRighe(resto.ssh, { cerca: (m) => [m.macchina, ...(m.chi ?? [])], query })
  const cercando = Boolean(query.trim())

  const crit = voci.some((v) => v.livello === 'crit')
  const errori = [audit.errore].filter(Boolean)
  // Quante sono urgenti, quando non lo sono tutte: dice da dove cominciare senza leggere l'elenco.
  const urgenti = voci.filter((x) => x.livello === 'crit').length
  const v = voci.length
    ? {
        livello: crit ? 'crit' : 'warn',
        forte: t('accessi.v.daSistemare', { n: voci.length }),
        resto: urgenti && urgenti < voci.length ? `, ${t('accessi.v.diCuiUrgenti', { n: urgenti })}` : null,
      }
    : { livello: 'ok', forte: t('accessi.v.tuttoInOrdine') }

  const nomi = (elenco = [], max = 4) =>
    elenco.length > max ? `${elenco.slice(0, max).join(', ')} ${t('accessi.eAltri', { n: elenco.length - max })}` : elenco.join(', ')
  const riassuntoResto = [
    resto.persone.length ? t('accessi.resto.persone', { n: resto.persone.length, nomi: nomi(resto.persone.map((p) => p.utente)) }) : null,
    resto.database.length ? t('accessi.resto.database', { n: resto.database.length }) : null,
    resto.ssh.length ? t('accessi.resto.ssh', { n: resto.ssh.length }) : null,
  ].filter(Boolean)

  return (
    <div className="ui-pagina">
      <Verdetto
        livello={errori.length ? 'warn' : v.livello}
        forte={v.forte}
        resto={v.resto}
        dettaglio={`${finestraDetta} · ${t('accessi.v.fonti')}`}
        extra={<PollStatus lastUpdated={lastUpdated} refreshing={refreshing || mappaRefreshing} t={t} />}
      />

      <div className="ui-filtri acc-filtri">
        <Finestra ore={ore} gradini={gradini} onChange={setOre} t={t} />
        <input
          type="search"
          className="ui-campo"
          placeholder={t('accessi.search')}
          aria-label={t('accessi.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {errori.map((e) => (
        <div key={e} className="ui-readwarn">
          {e}
        </div>
      ))}
      {/* ⚠️ Un campione spacciato per totale e' peggio di nessun numero. */}
      {audit.troncato && <div className="ui-readwarn">{t('accessi.troncato')}</div>}

      <Sezione titolo={t('accessi.daSistemare')} sotto={voci.length ? t('accessi.daSistemareSotto') : null}>
        {filtrate.length ? (
          <div className="acc-voci">
            {filtrate.map((x) => (
              <Voce key={x.id} v={x} dati={dati} t={t} lang={lang} />
            ))}
          </div>
        ) : (
          <div className="acc-vuoto">{cercando && voci.length ? t('accessi.nessunRisultato') : t('accessi.nienteDaSistemare', { finestra: finestraDetta })}</div>
        )}
      </Sezione>

      {riassuntoResto.length > 0 && (
        <Chiusa
          id="resto"
          titolo={t('accessi.inOrdine')}
          riassunto={riassuntoResto.join(' · ')}
          aperta={restoAperto || cercando}
          onApri={setRestoAperto}
          t={t}
        >
          {persone.length > 0 && (
            <Lista colonne={[t('accessi.col.persona'), t('accessi.col.attivita'), t('accessi.col.ultima')]} griglia="minmax(0, 1fr) minmax(0, 2fr) 120px" grigliaMobile="minmax(0, 1fr) auto">
              {persone.map((p) => (
                <div key={p.utente} className="ui-row acc-riga">
                  <span className="ui-name">
                    <Nome href={linkAudit(dati.auditUserUrl, 'utente', p.utente)}>{p.utente}</Nome>
                  </span>
                  <span className="ui-what ui-mute">
                    {[
                      t('accessi.loginN', { n: p.loginOk ?? 0 }),
                      p.sessioniDb ? t('accessi.sessioniDbN', { n: p.sessioniDb }) : null,
                      p.query
                        ? (p.db ?? []).length
                          ? t('accessi.querySu', { n: p.query, db: p.db.slice(0, 3).map((d) => d.nome).join(', ') })
                          : t('accessi.queryN', { n: p.query })
                        : null,
                      p.sessioniSsh ? t('accessi.sshN', { n: p.sessioniSsh }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <Quando ts={p.ultima} t={t} lang={lang} />
                </div>
              ))}
            </Lista>
          )}
          {database.length > 0 && (
            <Lista colonne={[t('accessi.col.database'), t('accessi.col.attivita'), t('accessi.col.quantePersone')]} griglia="minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1.4fr)" grigliaMobile="minmax(0, 1fr) auto">
              {database.map((d) => (
                <div key={`${d.servizio}/${d.nome}`} className="ui-row acc-riga">
                  <span className="ui-name">
                    {d.nome && d.nome !== '?' ? d.nome : d.servizio} {d.ambiente && <span className="acc-amb">{d.ambiente}</span>}
                    {d.nome && d.nome !== '?' && <small>{d.servizio}</small>}
                  </span>
                  <span className="ui-what ui-mute">
                    {t('accessi.queryN', { n: d.query ?? 0 })}
                    {d.scritture > 0 ? ` · ${t('accessi.scrittureN', { n: d.scritture })}` : ''}
                  </span>
                  <span className="ui-who">{(d.chi ?? []).join(', ') || t('accessi.personeN', { n: d.persone ?? 0 })}</span>
                </div>
              ))}
            </Lista>
          )}
          {ssh.length > 0 && (
            <Lista colonne={[t('accessi.col.macchina'), t('accessi.col.chiEntrato'), t('accessi.col.ultima')]} griglia="minmax(0, 1.2fr) minmax(0, 2fr) 120px" grigliaMobile="minmax(0, 1fr) auto">
              {ssh.map((m) => (
                <div key={m.macchina} className="ui-row acc-riga">
                  <span className="ui-name">
                    <Nome href={linkAudit(dati.auditNodeUrl, 'macchina', m.macchina)}>{m.macchina}</Nome>
                  </span>
                  <span className="ui-what ui-mute">
                    {t('accessi.sshDi', { n: m.sessioni ?? 0, chi: (m.chi ?? []).join(', ') })}
                  </span>
                  <Quando ts={m.ultima} t={t} lang={lang} />
                </div>
              ))}
            </Lista>
          )}
          {cercando && !persone.length && !database.length && !ssh.length && <div className="acc-vuoto">{t('accessi.nessunRisultato')}</div>}
          <p className="ui-note">{t('accessi.sshRegistrate')}</p>
        </Chiusa>
      )}

      <Chiusa
        id="chiHaCosa"
        titolo={t('accessi.mappa.persone')}
        riassunto={t('accessi.mappa.riassunto')}
        aperta={mappaAperta}
        onApri={setMappaAperta}
        t={t}
      >
        <MappaAccessi mappa={mappa} errore={mappaErrore} dati={dati} query={query} t={t} lang={lang} />
      </Chiusa>

      {/* ⚠️ Read-only per costruzione: le azioni stanno nella Web UI di Teleport. */}
      {dati.webUrl && (
        <Sezione titolo={t('accessi.altrove')} sotto={t('accessi.doveSiAgisce')}>
          <ListaLink link={[{ label: t('accessi.vaiTeleport'), href: dati.webUrl, nota: t('accessi.vaiTeleportNota') }]} />
        </Sezione>
      )}
    </div>
  )
}

// Una voce di «da sistemare»: cosa, perche', chi, quando, e il link dove si agisce. Il colore sta su
// una riga sola (il bordo e la pillola): una pagina tutta rossa non ha una prima cosa da guardare.
function Voce({ v, dati, t, lang }) {
  const chi = (v.chi ?? []).map((u, i) => (
    <span key={u}>
      {i > 0 && ', '}
      <Nome href={linkAudit(dati.auditUserUrl, 'utente', u)}>{u}</Nome>
    </span>
  ))
  let titolo
  let perche = null
  let azione = null
  if (v.tipo === 'login') {
    titolo = v.motivo ? t('accessi.voce.login', { n: v.quante, motivo: v.motivo }) : t('accessi.voce.loginSenzaMotivo', { n: v.quante })
    perche = v.perTutti
      ? t('accessi.voce.loginPerTutti', { n: v.chi.length })
      : v.ruolo
        ? t('accessi.voce.loginRuolo')
        : v.fuori.length
          ? t('accessi.voce.loginFuori', { chi: v.fuori.join(', ') })
          : t('accessi.voce.loginPoiDentro')
    const durata = v.prima && v.ultima && v.ultima > v.prima ? fmtMs(v.ultima - v.prima) : null
    if (durata) perche = `${perche} ${t('accessi.voce.inTempo', { durata })}`
    azione = { label: t('accessi.az.audit'), href: linkAudit(dati.auditUserUrl, 'utente', v.chi[0]) ?? dati.webUrl }
  } else if (v.tipo === 'ssh') {
    titolo = t('accessi.voce.ssh', { n: v.aperte, macchina: v.macchina })
    perche = v.suaMacchina
      ? t('accessi.voce.sshSua')
      : v.diChi?.length
        ? t('accessi.voce.sshDiAltri', { di: v.diChi.join(', ') })
        : t('accessi.voce.sshPerche')
    azione = { label: t('accessi.az.sessione'), href: linkAudit(dati.auditNodeUrl, 'macchina', v.macchina) ?? dati.webUrl }
  } else if (v.tipo === 'scrittura') {
    const cosa = (v.azioni ?? []).map((a) => `${a.quante} ${a.etichetta}`).join(', ')
    titolo = cosa ? t('accessi.voce.scritturaCosa', { cosa, db: v.db }) : t('accessi.voce.scrittura', { n: v.quante, db: v.db })
    perche = [
      v.soloStruttura ? t('accessi.voce.scritturaStruttura') : t('accessi.voce.scritturaDati'),
      v.tabelle?.length ? t('accessi.voce.tabelle', { tabelle: v.tabelle.join(', ') }) : null,
      v.servizio && v.servizio !== v.db ? v.servizio : null,
    ]
      .filter(Boolean)
      .join(' · ')
    azione = { label: t('accessi.az.query'), href: linkAudit(dati.auditUserUrl, 'utente', v.chi[0]) ?? dati.webUrl }
  } else {
    titolo = t('accessi.voce.negato', { n: v.quante })
    perche = (v.negati ?? []).map((n) => t('accessi.negatoCombo', { n: n.quante, dbUser: n.dbUser, db: n.nome, servizio: n.servizio })).join(' · ')
    azione = { label: t('accessi.az.audit'), href: linkAudit(dati.auditUserUrl, 'utente', v.utente) ?? dati.webUrl }
  }
  return (
    <article className={`acc-voce acc-${v.livello}`} data-ancora={v.ancora}>
      <Pill livello={v.livello}>{t(`accessi.tipo.${v.tipo}`)}</Pill>
      <div className="acc-voce-corpo">
        <b className="acc-voce-titolo">{titolo}</b>
        {perche && <span className="acc-voce-perche">{perche}</span>}
        <span className="acc-voce-chi">
          {chi}
          {v.ultima ? (
            <>
              {' · '}
              <Quando ts={v.ultima} t={t} lang={lang} />
            </>
          ) : null}
        </span>
      </div>
      {azione?.href && /^https?:\/\//i.test(azione.href) && (
        <a className="acc-voce-azione" href={azione.href} target="_blank" rel="noopener noreferrer">
          {azione.label} <span aria-hidden="true">↗</span>
        </a>
      )}
    </article>
  )
}

// «Chi ha cosa»: una riga per persona e una per team. Nessuna pillola di stato, e non e' una
// dimenticanza: qui non c'e' una riga rotta da far emergere, c'e' un elenco da consultare.
function MappaAccessi({ mappa, errore, dati, query, t, lang }) {
  if (!mappa && !errore) return <div className="acc-vuoto">{t('accessi.mappa.caricamento')}</div>
  const fonti = mappa?.fonti ?? {}
  const nota =
    [
      fonti.ruoli?.assente ? t('accessi.mappa.senzaMappa', { param: fonti.ruoli.assente }) : null,
      fonti.ruoli?.errore ? t('accessi.mappa.fonteRotta', { fonte: 'SSM', motivo: fonti.ruoli.errore }) : null,
      fonti.sso?.errore ? t('accessi.mappa.fonteRotta', { fonte: 'Identity Center', motivo: fonti.sso.errore }) : null,
      fonti.teleport?.errore ? t('accessi.mappa.fonteRotta', { fonte: 'Teleport', motivo: fonti.teleport.errore }) : null,
      errore ? String(errore) : null,
    ]
      .filter(Boolean)
      .join(' · ') || null
  const persone = filtraRighe(mappa?.persone ?? [], {
    cerca: (r) => [r.persona, r.ssoUtente, ...(r.teams ?? []), ...(r.ruoli ?? []), ...(r.gruppiSso ?? [])],
    query,
  })
  const teams = filtraRighe(mappa?.teams ?? [], { cerca: (r) => [r.team, ...(r.ruoli ?? []), ...(r.membri ?? [])], query })
  const perAccount = (permessi = []) => {
    const m = new Map()
    for (const p of permessi) m.set(p.account, [...(m.get(p.account) ?? []), p.permissionSet])
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }
  const etichette = (valori = [], vuoto) =>
    valori.length ? (
      <span className="ui-who">
        {valori.map((x) => (
          <b key={x} style={{ marginInlineEnd: 4 }}>
            {x}
          </b>
        ))}
      </span>
    ) : (
      <span className="ui-faint">{vuoto}</span>
    )
  return (
    <>
      {nota && <div className="ui-readwarn">{nota}</div>}
      <Lista
        colonne={[t('accessi.col.persona'), t('accessi.mappa.col.team'), t('accessi.mappa.col.ruoli'), t('accessi.mappa.col.portale'), t('accessi.mappa.col.ultimoLogin')]}
        griglia="minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1.4fr) 120px"
        grigliaMobile="minmax(0, 1fr) auto"
        vuoto={t('accessi.mappa.vuoto')}
      >
        {persone.map((r) => (
          <div key={r.persona} className="ui-row acc-riga">
            <span className="ui-name">
              <Nome href={linkAudit(dati.auditUserUrl, 'utente', r.persona)}>{r.persona}</Nome>
              {r.soloSso && <small>{t('accessi.mappa.soloPortale')}</small>}
            </span>
            <span className="ui-what">{r.teamsNoti ? etichette(r.teams, t('accessi.mappa.nessunTeam')) : <span className="ui-faint">{t('accessi.mappa.senzaLogin')}</span>}</span>
            <span className="ui-what" title={r.ruoli.join(' · ')}>
              {r.ruoli.length ? t('accessi.mappa.ruoliN', { n: r.ruoli.length }) : <span className="ui-faint">0</span>}
              {r.teamsSenzaRuoli?.length > 0 && (
                <span className="ui-hint" title={r.teamsSenzaRuoli.join(' · ')}>
                  {t('accessi.mappa.soloRepoN', { n: r.teamsSenzaRuoli.length })}
                </span>
              )}
            </span>
            <span className="ui-what ui-who">
              {r.permessi.length ? (
                perAccount(r.permessi).map(([account, ps]) => (
                  <b key={account} title={ps.join(' · ')} style={{ marginInlineEnd: 4 }}>
                    {`${account} · ${ps.length}`}
                  </b>
                ))
              ) : (
                <span className="ui-faint">{t('accessi.mappa.nessunPortale')}</span>
              )}
            </span>
            {r.ultimoLogin ? <Quando ts={r.ultimoLogin} t={t} lang={lang} /> : <span className="ui-when">{t('accessi.mappa.mai')}</span>}
          </div>
        ))}
      </Lista>
      <Lista
        colonne={[t('accessi.mappa.col.teamNome'), t('accessi.mappa.col.ruoli'), t('accessi.mappa.col.membri')]}
        griglia="minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1.5fr)"
        grigliaMobile="minmax(0, 1fr)"
        vuoto={t('accessi.mappa.vuotoTeam')}
      >
        {teams.map((r) => (
          <div key={r.team} className="ui-row acc-riga">
            <span className="ui-name">
              {r.team}
              {r.soloRepo && <small>{t('accessi.mappa.soloRepo')}</small>}
            </span>
            <span className="ui-what">{etichette(r.ruoli, '0')}</span>
            <span className="ui-what">{etichette(r.membri, t('accessi.mappa.nessunMembro'))}</span>
          </div>
        ))}
      </Lista>
      <p className="ui-note">{t('accessi.mappa.finestra', { n: Math.round((mappa?.ore ?? 168) / 24) })}</p>
    </>
  )
}
