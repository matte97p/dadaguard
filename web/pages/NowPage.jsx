import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Verdetto, Card, Dot, Lista, Sezione, RigaProblema, BarraUptime, Drawer, Rimedio, ListaLink, Pill } from '../ui/index.js'
import { buildSignals } from '../nowSignals.js'
import { displayName } from '../serviceName.js'
import { fmtAgo } from '../format.js'
import { matchesAny } from '../filters.js'
import {
  livelloServizio,
  livelloSegnale,
  ownerSegnale,
  teamServizio,
  comandoServizio,
  rangoLivello,
  contaLivelli,
  buildRecenti,
  statOggi,
  fasceDisponibilita,
  storicoPer,
  peggiore,
} from '../adattatori.js'

// Pagina «Adesso»: la home, a semaforo. In alto il verdetto in una frase, poi i numeri che lo
// reggono, poi l'elenco di quello che c'e' da sistemare dal piu' grave, poi cosa e' cambiato oggi.
//
// Nessuna fonte nuova: lo stato della flotta arriva da App (/api/status), i deploy anche (servono ai
// badge del menu), WAF e budget li legge questa pagina. I campi che il server non manda ancora
// (livello, owner, comando, storico) passano da web/adattatori.js, che li legge se ci sono e li
// deduce se mancano.

// Sigla del tipo nella casellina accanto al nome: dice DA DOVE arriva la riga prima di leggerla.
const SIGLA = {
  lambda: 'λ',
  ecs: 'ECS',
  'ecs-scheduled': '⏱',
  'cloudflare-worker': 'CF',
  acm: 'TLS',
  s3: 'S3',
  rds: 'DB',
  kinesis: 'KIN',
  sfn: 'SFN',
  ec2: 'EC2',
  alb: 'ALB',
  elasticache: 'RED',
}
const SIGLA_KIND = { deploy: 'CI', restart: '⟳', waf: 'WAF', budget: '$', anomaly: '$', alarm: '!' }

const ORE = 24

export default function NowPage({
  services = [],
  alarmiOrfani = [],
  statusReady = false,
  statusLoading,
  statusError,
  refreshKey,
  accountFilter = [],
  deploys = null,
  storico = null,
  metaOps = null,
  ruolo = 'dev',
  ambienti = [],
  ambiente = null,
  onAmbiente,
  onApriServizio,
  t = (k) => k,
  lang,
}) {
  const navigate = useNavigate()
  const [waf, setWaf] = useState(null)
  const [budgets, setBudgets] = useState(null)
  const [errori, setErrori] = useState([])
  const [aperto, setAperto] = useState(null)

  useEffect(() => {
    let vivo = true
    // Due fonti indipendenti: una che non risponde non deve spegnere l'altra, e mostrarne meta' e'
    // meglio che mostrare un errore solo.
    const prendi = (url, set) =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))))
        .then((j) => vivo && set(j))
        .catch((e) => vivo && setErrori((p) => [...p, e.message]))
    setErrori([])
    prendi(`/api/waf?hours=${ORE}`, setWaf)
    prendi(`/api/budgets?lang=${lang ?? ''}`, setBudgets)
    return () => {
      vivo = false
    }
  }, [lang, refreshKey])

  // I servizi dell'ambiente scelto. Il ruolo NON si applica qui: i numeri della card «Stato dei
  // servizi» parlano della flotta, e un totale che cambia col ruolo si legge come un guasto.
  const nelFiltro = useMemo(() => services.filter((s) => matchesAny(s.account?.key ?? '__none__', accountFilter)), [services, accountFilter])
  const perChiave = useMemo(() => {
    const m = new Map()
    for (const s of services) m.set(`svc:${s.account?.key ?? '-'}:${s.resourceId ?? s.name}`, s)
    return m
  }, [services])

  // «Da sistemare»: i segnali che mordono (rossi e arancio), dal piu' grave, filtrati per ambiente e
  // ruolo. Quelli informativi (un deploy in corso, un riavvio) stanno in «Cosa e' cambiato».
  const righe = useMemo(() => {
    const tutti = buildSignals({ services, deploys: deploys ?? {}, waf, budgets, alarmi: alarmiOrfani, hours: ORE, t, nameOf: displayName })
    return tutti
      .filter((s) => s.accountKey == null || matchesAny(s.accountKey, accountFilter))
      .map((s) => {
        const servizio = s.kind === 'service' ? perChiave.get(s.id) : null
        return { ...s, servizio, livello: livelloSegnale(s), owner: ownerSegnale(s, servizio), comando: s.comando ?? (servizio ? comandoServizio(servizio) : null) }
      })
      .filter((r) => (r.livello === 'crit' || r.livello === 'warn') && (ruolo === 'ops' || r.owner === 'dev'))
      .sort((a, b) => rangoLivello(a.livello) - rangoLivello(b.livello))
  }, [services, deploys, waf, budgets, alarmiOrfani, accountFilter, ruolo, perChiave, t])

  const conta = contaLivelli(nelFiltro)
  const serviziRotti = righe.filter((r) => r.kind === 'service' && r.livello === 'crit').length
  const deployFalliti = righe.filter((r) => r.kind === 'deploy' && r.livello === 'crit').length
  const daGuardare = righe.length - righe.filter((r) => r.livello === 'crit').length
  const altriRotti = righe.filter((r) => r.livello === 'crit').length - serviziRotti - deployFalliti

  const build = useMemo(() => buildRecenti(deploys ?? {}, { ore: ORE, accountKeys: accountFilter }), [deploys, accountFilter])
  const oggi = statOggi(build)
  const disp = fasceDisponibilita(storicoPer(storico, accountFilter), peggiore(nelFiltro.map(livelloServizio)))
  const inAttesa = !statusReady || statusLoading
  // DevOps: la spesa di oggi (somma degli account visibili, il giorno e' ancora parziale) e i login
  // falliti delle ultime 24 ore. null = non letto, e allora il riquadro non lo mostra.
  const spesaOggi = (() => {
    const voci = Object.entries(metaOps?.spesa ?? {}).filter(([k, v]) => Number.isFinite(v?.oggi) && (!accountFilter.length || accountFilter.includes(k)))
    return voci.length ? Math.round(voci.reduce((x, [, v]) => x + v.oggi, 0)) : null
  })()
  const loginFalliti = Number.isFinite(metaOps?.login?.loginFalliti) ? metaOps.login.loginFalliti : null

  const verdetto = (() => {
    if (!statusReady) return { forte: null, resto: t('home.v.attesa') }
    if (serviziRotti || deployFalliti || altriRotti) {
      const pezzi = [
        serviziRotti && t('home.v.serviziRotti', { n: serviziRotti }),
        deployFalliti && t('home.v.deployFalliti', { n: deployFalliti }),
        altriRotti && t('home.v.altriRotti', { n: altriRotti }),
      ].filter(Boolean)
      return { livello: 'crit', forte: pezzi.join(', '), resto: daGuardare ? t('home.v.eDaGuardare', { n: daGuardare }) : '' }
    }
    if (righe.length) return { livello: 'warn', forte: t('home.v.nienteRotto'), resto: t('home.v.eDaGuardare', { n: righe.length }) }
    return { livello: 'ok', forte: t('home.v.tuttoOk'), resto: '' }
  })()

  const etichetta = (r) => {
    if (r.kind === 'deploy') return r.livello === 'crit' ? t('home.pill.deployFallito') : t('home.pill.deploy')
    if (r.kind === 'budget' || r.kind === 'anomaly') return t('home.pill.spesa')
    return t(`home.liv.${r.livello}`)
  }
  const ownerLabel = (r) => (r.servizio && teamServizio(r.servizio)) || t(`home.owner.${r.owner}`)
  const apri = (r) => {
    if (r.servizio && onApriServizio) return onApriServizio(r.servizio)
    setAperto(r)
  }

  return (
    <>
      <Verdetto livello={verdetto.livello} forte={verdetto.forte} resto={verdetto.resto} dettaglio={t(`home.ruolo.${ruolo}`)} />

      {statusError && <div className="ui-readwarn">{statusError}</div>}
      {errori.length > 0 && <div className="ui-readwarn">{t('now.partial')}: {errori.join(' · ')}</div>}

      <div className="ui-hero">
        <Card titolo={t('home.statoServizi')} nota={inAttesa ? t('home.inLettura') : t('home.controllati', { n: nelFiltro.length })}>
          <div className="ui-stack" aria-hidden="true">
            {['crit', 'warn', 'ok', 'off'].map((k) => (conta[k] ? <i key={k} className={`ui-bg-${k === 'off' ? 'off' : k}`} style={{ flex: conta[k], opacity: k === 'off' ? 0.4 : 1 }} /> : null))}
          </div>
          <div className="ui-legend">
            {['crit', 'warn', 'ok', 'off'].map((k) => (
              <span key={k}>
                <Dot livello={k} />
                {conta[k]} {t(`home.liv.${k}`).toLowerCase()}
              </span>
            ))}
          </div>
          <h4 style={{ marginTop: 4 }}>
            <span>{t('home.disponibilita')}</span>
            <span>{disp.percento != null ? `${String(disp.percento).replace('.', lang === 'it' ? ',' : '.')}%` : disp.dedotto ? t('home.soloAdesso') : ''}</span>
          </h4>
          <BarraUptime fasce={disp.fasce} etichette={[t('home.asse.ieri'), '', '', t('home.asse.adesso')]} titolo={disp.dedotto ? t('home.storicoAssente') : undefined} />
        </Card>
        <Card titolo={t('home.oggi')}>
          <div className="ui-stats">
            <Stat valore={oggi.riusciti} label={t('home.stat.riusciti')} />
            <Stat valore={oggi.falliti} label={t('home.stat.falliti')} livello={oggi.falliti ? 'crit' : undefined} />
            <Stat valore={oggi.inCorso} label={t('home.stat.inCorso')} livello={oggi.inCorso ? 'info' : undefined} />
            <Stat valore={oggi.aMano} label={t('home.stat.aMano')} livello={oggi.aMano ? 'warn' : undefined} />
            <Stat valore={conta.crit} label={t('home.stat.rotti')} livello={conta.crit ? 'crit' : undefined} />
            <Stat valore={conta.warn} label={t('home.stat.daGuardare')} livello={conta.warn ? 'warn' : undefined} />
            {ruolo === 'ops' && spesaOggi != null && <Stat valore={`${spesaOggi} $`} label={t('home.stat.spesaOggi')} />}
            {ruolo === 'ops' && loginFalliti != null && <Stat valore={loginFalliti} label={t('home.stat.loginFalliti')} livello={loginFalliti ? 'warn' : undefined} />}
          </div>
        </Card>
      </div>

      {/* Le card per ambiente servono solo quando si guardano tutti insieme: con un ambiente scelto
          ripeterebbero la card qui sopra. Cliccarne una e' come sceglierlo dalla barra in alto. */}
      {ambiente == null && ambienti.length > 1 && (
        <div className="ui-envgrid">
          {ambienti.map((a) => {
            const c = contaLivelli(services.filter((s) => a.accounts.includes(s.account?.key)))
            const d = fasceDisponibilita(storicoPer(storico, a.accounts), a.livello, 24)
            return (
              <Card key={a.key} className="ui-envcard" onClick={() => onAmbiente?.(a.key)}>
                <span className="ui-h">
                  <Dot livello={a.livello} />
                  {a.label}
                </span>
                <span className="ui-c">
                  <span>
                    <b className={c.crit ? 'ui-t-crit' : ''}>{c.crit}</b> {t('home.env.rotti')}
                  </span>
                  <span>
                    <b className={c.warn ? 'ui-t-warn' : ''}>{c.warn}</b> {t('home.env.daGuardare')}
                  </span>
                  <span>
                    <b>{c.ok}</b> {t('home.env.ok')}
                  </span>
                </span>
                <BarraUptime fasce={d.fasce} altezza={14} />
              </Card>
            )
          })}
        </div>
      )}

      <Sezione titolo={t('home.daSistemare')} sotto={t('home.daSistemareSotto')}>
        <Lista vuoto={inAttesa ? t('home.inLettura') : t('home.nienteDaSistemare')}>
          {righe.map((r) => (
            <RigaProblema
              key={r.id}
              livello={r.livello}
              etichetta={etichetta(r)}
              icona={r.servizio ? SIGLA[r.servizio.type] ?? '·' : SIGLA_KIND[r.kind] ?? '·'}
              nome={r.title}
              sotto={[r.accountLabel, r.servizio?.type ? tipo(r.servizio.type, t) : t(`now.kind.${r.kind}`)].filter(Boolean).join(' · ')}
              cosa={r.detail || t(`now.kind.${r.kind}`)}
              owner={ownerLabel(r)}
              quando={r.when ? fmtAgo(r.when, t) : t('now.ongoing')}
              azione={r.servizio || r.to || comandoServizio(r.servizio) ? t('home.cosaFare') : ''}
              onApri={() => apri(r)}
            />
          ))}
        </Lista>
      </Sezione>

      <Sezione titolo={t('home.cambiato')} sotto={t('home.cambiatoSotto')}>
        <Cambiamenti build={build} storico={storico} accountFilter={accountFilter} t={t} />
      </Sezione>

      <Drawer
        aperto={Boolean(aperto)}
        onChiudi={() => setAperto(null)}
        titolo={aperto?.title}
        sopra={aperto && <Pill livello={aperto.livello}>{etichetta(aperto)}</Pill>}
        sotto={aperto && [aperto.accountLabel, t(`now.kind.${aperto.kind}`), t(`home.tocca.${aperto.owner}`)].filter(Boolean).join(' · ')}
        etichettaChiudi={t('ui.chiudi')}
      >
        {aperto && (
          <>
            <Rimedio livello={aperto.livello} titolo={aperto.detail} testo={aperto.full} comando={aperto.comando} t={t} />
            {aperto.when && <span className="ui-faint">{t('home.da', { quando: fmtAgo(aperto.when, t) })}</span>}
            {aperto.to && (
              <div>
                <button type="button" className="ui-kbd" onClick={() => (setAperto(null), navigate(aperto.to))}>
                  {t('home.apriPagina')}
                </button>
              </div>
            )}
            <ListaLink link={aperto.link ?? []} />
            <p className="ui-note">{t('home.soloLettura')}</p>
          </>
        )}
      </Drawer>
    </>
  )
}

function tipo(ty, t) {
  const k = `type.${ty}`
  const l = t(k)
  return l === k ? ty : l
}

function Stat({ valore, label, livello }) {
  return (
    <div className="ui-stat">
      <b className={livello ? `ui-t-${livello}` : undefined}>{valore}</b>
      <span>{label}</span>
    </div>
  )
}

// Cosa è cambiato, dal più recente: una riga per evento con l'ora, un'etichetta a parole (non un
// simbolo da decifrare) e il dettaglio che serve per agire. La striscia a puntini che c'era prima diceva
// quando si addensavano le cose, ma i segni si sovrapponevano e non si leggeva né cosa né dove.
// Le fonti sono due: la cronologia di /api/history (deploy, riavvii e inizio dei guasti, con «dopo il
// deploy X») e le build ancora in corso, che lo storico non conta perché non hanno un esito.
function Cambiamenti({ build, storico, accountFilter, t }) {
  const [tutti, setTutti] = useState(false)
  const righe = righeCambiamenti({ build, storico, accountFilter })
  if (!righe.length) return <Lista vuoto={t('home.nienteCambiato')} />
  const viste = tutti ? righe : righe.slice(0, 10)
  return (
    <div className="ui-tl">
      {viste.map((r) => (
        <div key={r.key} className="ui-e">
          <span className="ui-mono">{new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
          <Pill livello={r.livello}>{t(`home.ev.${r.etichetta}`)}</Pill>
          <span className="ui-name">
            {r.servizio ?? '?'}
            {r.env && <small>{r.env}</small>}
          </span>
          <span className={r.dopoDeploy ? 'ui-t-warn' : 'ui-mute'} style={{ fontSize: 13, textAlign: 'right' }}>
            {r.dopoDeploy
              ? t('home.ev.dopoDeploy', { min: r.dopoDeploy.minuti, commit: r.dopoDeploy.commit ?? '' })
              : [r.chi, r.commit].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
      {righe.length > 10 && (
        <button type="button" className="ui-kbd" style={{ margin: '8px 0' }} onClick={() => setTutti(!tutti)}>
          {tutti ? t('home.ev.meno') : t('home.ev.tutti', { n: righe.length })}
        </button>
      )}
    </div>
  )
}

// Il nome leggibile di un ambiente lo sa già chi ha letto i conti: lo storico porta solo la chiave.
const etichettaAmbiente = (blocco, build) => build.find((b) => (blocco?.conti ?? []).includes(b.accountKey))?.accountLabel

// Pura: normalizza le due fonti in righe, filtra per conto e ordina dalla più recente.
export function righeCambiamenti({ build = [], storico = null, accountFilter = null }) {
  const blocchi = storico?.ambienti ?? {}
  const ambientiVisti = Object.entries(blocchi)
    .filter(([, b]) => !accountFilter?.length || (b?.conti ?? []).some((c) => accountFilter.includes(c)))
    .map(([k]) => k)
  const daStorico = (storico?.cronologia ?? [])
    .filter((e) => !accountFilter?.length || ambientiVisti.includes(e.ambiente))
    .map((e) => {
      const etichetta = e.tipo === 'guasto' ? 'guasto' : e.tipo === 'riavvio' ? 'riavvio' : e.esito === 'ok' ? 'rilascio' : 'fallito'
      const livello = e.tipo === 'guasto' ? (e.finito ? 'warn' : 'crit') : e.esito === 'ok' ? (e.tipo === 'riavvio' ? 'warn' : 'ok') : 'crit'
      return { key: `s:${e.tipo}:${e.ambiente}:${e.servizio}:${e.ts}`, ts: e.ts, etichetta, livello, servizio: e.servizio ?? e.allarme, env: etichettaAmbiente(blocchi[e.ambiente], build) ?? e.ambiente, chi: e.chi, commit: e.commit, dopoDeploy: e.dopoDeploy }
    })
  // Senza storico (permesso mancante, demo vecchia) si ripiega sulle build lette per i deploy.
  const sorgenteBuild = daStorico.length ? build.filter((b) => b.esito === 'info') : build
  const daBuild = sorgenteBuild.map((b) => ({
    key: `b:${b.id ?? `${b.accountKey}:${b.service}:${b.at}`}`,
    ts: b.at,
    etichetta: b.esito === 'info' ? 'inCorso' : b.aMano ? 'riavvio' : b.esito === 'ok' ? 'rilascio' : 'fallito',
    livello: b.esito === 'info' ? 'info' : b.aMano && b.esito === 'ok' ? 'warn' : b.esito,
    servizio: b.service,
    env: b.accountLabel ?? b.accountKey,
    chi: b.author,
    commit: b.commit,
  }))
  return [...daStorico, ...daBuild].filter((r) => Number.isFinite(r.ts)).sort((a, b) => b.ts - a.ts)
}
