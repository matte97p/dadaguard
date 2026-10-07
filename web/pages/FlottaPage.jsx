import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Verdetto, Sezione, Dot, Drawer, Modale, useSchermoLargo, ListaLink, ComandoInline, Tessere, Tessera, GraficoMemoria, PiccoliMultipli, Legenda } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import PollStatus from '../components/PollStatus.jsx'
import Loading from '../components/Loading.jsx'
import { fmtAgo, fmtMs } from '../format.js'
import { digestCorto } from '../../shared/devEnv.js'
import { linkAudit } from '../accessi.js'
import { fraseProblema, fraseAzione, storiaImmagini, celleMac, azioniFlotta, COLONNE } from '../flotta.js'
import { numero } from '../grafici.js'
import './ops.css'
import './accessi.css'

// Superficie "Flotta": come stanno i Mac del dev-env, e quale sistemare.
//
// ── Perche' e' un cruscotto (rifatta il 07/10/2026, la sera) ──────────────────────────────────────
// La prima stesura del giorno era una card per Mac con un problema: bordo colorato, pillola, frase,
// barra, elenco, e dentro un riquadro «Cosa fare» con dentro un riquadro col comando. Si leggeva come
// una pagina di testo e come un muro di scatole, e la flotta intera non si vedeva: i Mac in ordine
// stavano in una riga di nomi. Ora la pagina risponde in tre righe d'occhio:
//   · cinque NUMERI in cima (Mac attivi, da sistemare, OOM, immagine in pari, memoria minima), ognuno
//     col suo andamento di sette giorni, e il colore solo sul numero cattivo;
//   · la MATRICE: una riga per Mac, una colonna per cosa si guarda, grigio quando va bene e un pallino
//     col valore quando no. Prima i Mac da sistemare, ma tutti visibili: e' la flotta, non l'elenco dei
//     guasti. Il clic apre il pannello del Mac (`?mac=`), dove stanno le azioni coi comandi;
//   · un GRAFICO di sette giorni: la memoria libera della VM peggiore e di quella tipica, e le ore con
//     un OOM, che e' la domanda che ha fatto nascere la pagina.
// Le azioni sotto la matrice sono una riga sola; il «cosa fare» per intero e' nel pannello.
//
// Il dettaglio di un Mac (dal 07/10/2026, sera): sullo schermo largo e' una FINESTRA CENTRATA
// (`Modale`), con i problemi e le azioni a sinistra, i grafici a destra e i dettagli sotto; sul
// telefono resta il pannello di prima, che li' va bene. Un Mac e' una riga anche quando il suo nome e'
// cambiato (gli altri nomi stanno nel dettaglio, «anche: …»), e i Mac che non si vedono da piu' di
// tre giorni stanno in un gruppo chiuso in fondo, fuori dai numeri.
//
// Le regole (cosa e' un problema, quanto e' grave, quale azione, i conti sulla flotta) le compone il
// server (`server/flotta.js`): qui si disegnano e basta. Ogni campo e' facoltativo: una cella che non
// si sa e' un trattino tenue, mai uno zero.
//
// ⚠️ Read-only come tutto il resto: le azioni sono frasi e comandi da copiare, mai eseguiti da qui.

const dataCorta = (ts, lang) => new Date(ts).toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-GB')
const gb = (x, lang) => numero(x, lang)

export default function FlottaPage({ t, lang }) {
  const { data, loading, refreshing, error, lastUpdated } = usePoll('/api/flotta', { intervalMs: 60000 })
  const [params, setParams] = useSearchParams()

  // Il Mac aperto nel pannello sta nell'URL (`?mac=`): cosi' «guarda il Mac di kim» si manda come link,
  // ed e' dove portano i messaggi del canale.
  const aperto = params.get('mac')
  const apri = useCallback(
    (nome) => {
      const p = new URLSearchParams(params)
      if (nome) p.set('mac', nome)
      else p.delete('mac')
      setParams(p, { replace: true })
    },
    [params, setParams],
  )
  const azioni = useMemo(() => azioniFlotta(data?.macchine ?? []), [data])
  const largo = useSchermoLargo()

  if (error && !data) return <div className="ui-readwarn">{String(error)}</div>
  if (loading || !data) return <Loading text={t('flotta.caricamento')} />
  if (!data.configurato) {
    return (
      <div className="ui-pagina">
        <Verdetto resto={t('flotta.title')} dettaglio={t('flotta.desc')} />
        <div className="acc-vuoto">{t('accessi.nonConfigurato')}</div>
      </div>
    )
  }

  const macchine = data.macchine ?? []
  const daSistemare = macchine.filter((m) => m.livello === 'crit' || m.livello === 'warn')
  const peggiore = daSistemare[0]?.livello ?? 'ok'
  const nonViste = data.nonViste ?? []
  // `?mac=` porta il nome che aveva il Mac quando il canale ne ha parlato: puo' essere un nome vecchio,
  // o l'id. Si trova lo stesso, anche fra i non visti.
  const selezionata = aperto ? ([...macchine, ...nonViste].find((m) => m.macchina === aperto || m.chiave === aperto || (m.alias ?? []).includes(aperto)) ?? null) : null
  const Dettaglio = largo ? Modale : Drawer
  const rif = data.riferimento ?? {}

  return (
    <div className="ui-pagina fl-pagina">
      <Verdetto
        resto={
          <>
            {t('flotta.v.mac', { n: data.totale ?? macchine.length })}
            {' · '}
            <b className={`ui-t-${peggiore}`}>{daSistemare.length ? t('flotta.v.daSistemare', { n: daSistemare.length }) : t('flotta.v.tuttiInOrdine')}</b>
          </>
        }
        dettaglio={[rif.data ? t('flotta.v.golden', { data: dataCorta(rif.data, lang), quando: fmtAgo(rif.data, t) }) : null, t('flotta.v.fonti')].filter(Boolean).join(' · ')}
        extra={<PollStatus lastUpdated={lastUpdated} refreshing={refreshing} t={t} />}
      />

      {(data.errori ?? []).map((e) => (
        <div key={e} className="ui-readwarn">
          {e}
        </div>
      ))}
      {data.tuttiIndietro && <div className="ui-readwarn">{t('flotta.tuttiIndietro')}</div>}
      {!data.saluteConfigurata && <div className="ui-readwarn">{t('flotta.senzaSalute')}</div>}
      {data.troncato && <div className="ui-readwarn">{t('flotta.troncato')}</div>}

      {macchine.length > 0 && <NumeriFlotta dati={data} t={t} lang={lang} />}

      {macchine.length === 0 ? (
        <div className="acc-vuoto">{t('accessi.nessunAvvio')}</div>
      ) : (
        <Sezione titolo={t('flotta.matrice')} sotto={t('flotta.matriceSotto')}>
          <Matrice macchine={macchine} onApri={apri} t={t} lang={lang} />
          {azioni.length > 0 && (
            <p className="fl-azioni">
              <b>{t('flotta.azioni', { n: azioni.reduce((n, a) => n + a.macchine.length, 0) })}</b>
              {azioni.map((a) => (
                <span key={a.k}>
                  <Dot livello={a.livello} />
                  {t(`flotta.az.${a.k}`)}:{' '}
                  {a.macchine.map((nome, i) => (
                    <span key={nome}>
                      {i > 0 && ', '}
                      <button type="button" className="fl-nome-link" onClick={() => apri(nome)}>
                        {nome}
                      </button>
                    </span>
                  ))}
                </span>
              ))}
            </p>
          )}
        </Sezione>
      )}

      {nonViste.length > 0 && (
        <details className="fl-nonviste">
          <summary>
            <span>{t('flotta.nonViste', { n: nonViste.length, g: data.nonVistiDopoGiorni ?? 3 })}</span>
            <small>{t('flotta.nonVisteSotto')}</small>
          </summary>
          <Matrice macchine={nonViste} onApri={apri} t={t} lang={lang} spenta />
        </details>
      )}

      {data.andamento && <GraficoFlotta andamento={data.andamento} t={t} lang={lang} />}

      <Dettaglio
        aperto={Boolean(selezionata)}
        onChiudi={() => apri(null)}
        titolo={selezionata?.macchina}
        sopra={
          selezionata && (
            <span className={`fl-liv ui-t-${selezionata.livello === 'ok' ? 'ok' : selezionata.livello}`}>
              <Dot livello={selezionata.livello} />
              {t(`flotta.liv.${selezionata.livello}`)}
            </span>
          )
        }
        sotto={selezionata && <SottoTitolo m={selezionata} t={t} lang={lang} />}
        etichettaChiudi={t('ui.chiudi')}
        className="fl-modale"
      >
        {selezionata && <DettaglioMac m={selezionata} dati={data} t={t} lang={lang} />}
      </Dettaglio>
    </div>
  )
}

// ── I cinque numeri ────────────────────────────────────────────────────────────────────────────────
// I conti li fa il server (`riepilogo`, `andamento.giorni`): qui si sceglie solo cosa colorare. Il
// colore va sul numero cattivo e basta; l'andamento resta grigio.
function NumeriFlotta({ dati, t, lang }) {
  const r = dati.riepilogo ?? {}
  const g = dati.andamento?.giorni ?? null
  const totale = dati.totale ?? dati.macchine?.length ?? 0
  const elenco = (xs, f = (x) => x) => (xs ?? []).map((x) => (x == null ? '-' : f(x))).join(', ')
  const pct = r.conImmagine ? Math.round((r.inPari / r.conImmagine) * 100) : null
  const pctGiorni = g ? g.inPari.map((v, i) => (v == null || !g.conImmagine[i] ? null : Math.round((v / g.conImmagine[i]) * 100))) : null
  return (
    <Tessere etichetta={t('flotta.kpi.aria')}>
      <Tessera
        etichetta={t('flotta.kpi.attivi')}
        valore={r.attivi24h}
        sotto={t('flotta.kpi.attiviSotto', { n: totale })}
        trend={g && { valori: g.attivi, forma: 'linea', dominio: [0, totale], descrizione: t('flotta.kpi.attiviTrend', { valori: elenco(g.attivi) }) }}
      />
      <Tessera
        etichetta={t('flotta.kpi.daSistemare')}
        valore={dati.daSistemare ?? null}
        sotto={
          r.urgenti > 0 ? (
            <>
              <Dot livello="crit" /> {t('flotta.kpi.urgenti', { n: r.urgenti })}
            </>
          ) : (
            t('flotta.kpi.nessunoUrgente')
          )
        }
      />
      <Tessera
        etichetta={t('flotta.kpi.oom')}
        valore={r.oom24h}
        livello={r.oom24h > 0 ? 'crit' : null}
        sotto={r.oom24h > 0 ? t('flotta.kpi.oomSotto', { n: r.conOom24h }) : r.oom24h === 0 ? t('flotta.kpi.oomNessuno') : null}
        trend={g && { valori: g.oom, forma: 'barre', dominio: [0, 1], descrizione: t('flotta.kpi.oomTrend', { valori: elenco(g.oom) }) }}
      />
      <Tessera
        etichetta={t('flotta.kpi.immagine')}
        valore={pct}
        unita="%"
        livello={pct != null && pct < 100 ? 'warn' : null}
        sotto={r.conImmagine ? t('flotta.kpi.immagineSotto', { n: r.inPari, tot: r.conImmagine }) : null}
        title={t('flotta.kpi.immagineTitolo', { g: dati.soglie?.giorniIndietro ?? 7 })}
        trend={pctGiorni && { valori: pctGiorni, forma: 'linea', dominio: [0, 100], descrizione: t('flotta.kpi.immagineTrend', { valori: elenco(pctGiorni, (v) => `${v}%`) }) }}
      />
      <Tessera
        etichetta={t('flotta.kpi.mem')}
        valore={r.memMinima ? gb(r.memMinima.gb, lang) : null}
        unita="GB"
        livello={r.memMinima?.bassa ? 'warn' : null}
        title={t('flotta.kpi.memTitolo')}
        sotto={r.memMinima?.macchina ? t('flotta.kpi.memSotto', { mac: r.memMinima.macchina }) : null}
        trend={g && { valori: g.memMin, forma: 'linea', dominio: [0, null], descrizione: t('flotta.kpi.memTrend', { valori: elenco(g.memMin, (v) => gb(v, lang)) }) }}
      />
    </Tessere>
  )
}

// ── La matrice ─────────────────────────────────────────────────────────────────────────────────────
// Una riga per Mac, nell'ordine del server (prima i piu' gravi). Ogni riga e' un bottone che apre il
// pannello; il suo nome per lo screen reader e' la frase intera dei problemi, non la fila di celle.
function Matrice({ macchine, onApri, t, lang, spenta = false }) {
  return (
    <div className={`fm${spenta ? ' fm-spenta' : ''}`}>
      <div className="fm-riga fm-testa" aria-hidden="true">
        <span>{t('flotta.col.mac')}</span>
        {COLONNE.map((k) => (
          <span key={k} title={t(`flotta.colT.${k}`)} className={`fm-c-${k}`}>
            {t(`flotta.col.${k}`)}
          </span>
        ))}
      </div>
      {macchine.map((m) => (
        <RigaMac key={m.chiave ?? m.macchina} m={m} onApri={() => onApri(m.macchina)} t={t} lang={lang} />
      ))}
    </div>
  )
}

function RigaMac({ m, onApri, t, lang }) {
  const celle = celleMac(m, t, lang)
  const male = m.livello === 'crit' || m.livello === 'warn'
  const nome = [m.macchina, m.utente, t(`flotta.liv.${m.livello}`), ...m.problemi.map((p) => fraseProblema(p, t, lang))].filter(Boolean).join(', ')
  return (
    <button type="button" className={`fm-riga fm-mac ${male ? 'fm-male' : 'fm-bene'}`} onClick={onApri} aria-label={nome}>
      <span className="fm-nome">
        <Dot livello={m.livello === 'ok' ? 'off' : m.livello} />
        <span>
          <b>{m.macchina}</b>
          {m.utente && <small>{m.utente}</small>}
        </span>
      </span>
      {celle.map((c) => (
        <Cella key={c.k} c={c} t={t} />
      ))}
      {!celle.some((c) => c.livello && c.livello !== 'ok') && <span className="fm-tutto-ok">{t('flotta.liv.ok')}</span>}
    </button>
  )
}

function Cella({ c, t }) {
  const stato = c.livello == null ? 'ignoto' : c.livello
  const allarme = stato !== 'ok' && stato !== 'ignoto'
  return (
    <span className={`fm-c fm-c-${c.k} fm-${stato}`} title={c.titolo ?? (stato === 'ignoto' ? t('flotta.c.ignoto') : undefined)}>
      <span className="fm-et">{t(`flotta.col.${c.k}`)}</span>
      {allarme && <Dot livello={stato} />}
      {c.barra != null && (
        <span className="fm-barra" aria-hidden="true">
          <i style={{ width: `${c.barra}%` }} />
        </span>
      )}
      <span className="fm-v">{c.valore ?? '-'}</span>
    </span>
  )
}

// ── Il grafico di sette giorni ─────────────────────────────────────────────────────────────────────
function GraficoFlotta({ andamento, t, lang }) {
  const g = andamento.giorni
  return (
    <Sezione titolo={t('flotta.grafico')} sotto={t('flotta.graficoSotto')}>
      <div className="fl-grafico">
        <Legenda
          voci={[
            { etichetta: t('flotta.grafico.legMinimo'), colore: 'var(--chart-1)', forma: 'linea' },
            { etichetta: t('flotta.grafico.legMediana'), colore: 'var(--chart-neutro)', forma: 'linea' },
            { etichetta: t('flotta.grafico.legOom'), colore: 'var(--crit)', forma: 'quadro' },
          ]}
        />
        <GraficoMemoria andamento={andamento} t={t} lang={lang} formatoGb={(v) => gb(v, lang)} />
        {g?.punti > 0 && (
          <details className="ui-tabella-grafico">
            <summary>{t('grafico.tabella')}</summary>
            <table>
              <thead>
                <tr>
                  <th>{t('flotta.tab.giorno')}</th>
                  <th>{t('flotta.tab.accesi')}</th>
                  <th>{t('flotta.tab.minimo')}</th>
                  <th>{t('flotta.tab.oom')}</th>
                  <th>{t('flotta.tab.inPari')}</th>
                </tr>
              </thead>
              <tbody>
                {g.attivi.map((_, i) => (
                  <tr key={i}>
                    <td>{new Date(g.inizio + i * g.passoMs).toLocaleDateString(lang === 'it' ? 'it-IT' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                    <td>{g.attivi[i]}</td>
                    <td>{g.memMin[i] == null ? '-' : `${gb(g.memMin[i], lang)} GB`}</td>
                    <td>{g.oom[i] ?? '-'}</td>
                    <td>{g.inPari[i] == null ? '-' : `${g.inPari[i]}/${g.conImmagine[i]}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </Sezione>
  )
}

// ── Il pannello di un Mac ──────────────────────────────────────────────────────────────────────────

// Sotto il nome: chi, il motore e la RAM; poi, in piccolo, gli altri nomi con cui lo stesso Mac si e'
// presentato («anche: …»), col perche' nel titolo. Un Mac fra i non visti dice da quando.
function SottoTitolo({ m, t, lang }) {
  const riga = [m.utente, m.motore, m.vm?.ramMacGb != null ? t('flotta.ramMac', { gb: gb(m.vm.ramMacGb, lang) }) : null].filter(Boolean).join(' · ')
  return (
    <>
      {riga}
      {m.nonVisto && m.visto && <span className="fl-anche">{t('flotta.vistoUltima', { quando: fmtAgo(m.visto, t) })}</span>}
      {(m.alias ?? []).length > 0 && (
        <span className="fl-anche" title={t(m.unitoPer === 'id' ? 'flotta.ancheId' : 'flotta.ancheEuristica')}>
          {t('flotta.anche', { nomi: m.alias.join(', ') })}
        </span>
      )}
    </>
  )
}

// Le quattro serie del pannello, e la SCALA di ciascuna: fissa sulla grandezza vera (la memoria della
// VM, la RAM del Mac, i core della VM), cosi' una curva piatta resta piatta invece di essere stirata
// da bordo a bordo.
const SERIE = [
  { k: 'mem', unita: 'GB', colore: 'var(--chart-1)', forma: 'linea', dominio: (m) => [0, m.vm?.gb ?? null] },
  { k: 'oom', unita: '', colore: 'var(--crit)', forma: 'barre', dominio: () => [0, 1] },
  { k: 'swap', unita: 'GB', colore: 'var(--chart-1)', forma: 'linea', dominio: (m) => [0, m.vm?.ramMacGb ?? null] },
  { k: 'cpu', unita: '%', colore: 'var(--chart-1)', forma: 'linea', dominio: (m) => [0, m.vm?.cpu ? m.vm.cpu * 100 : null] },
]

function DettaglioMac({ m, dati, t, lang }) {
  const ssh = dati.sshCommand && m.host ? dati.sshCommand.replace('{macchina}', m.macchina) : null
  const audit = linkAudit(dati.auditNodeUrl, 'macchina', m.macchina)
  const immagini = storiaImmagini(m.storia ?? [])
  const vmMb = (m.vm?.gb ?? 0) * 1024
  const uso = m.uso ?? {}
  const righeUso = [
    uso.ultimoUp && [t('flotta.uso.ultimoUp'), fmtAgo(Date.parse(uso.ultimoUp), t)],
    uso.ultimoUpdate && [t('flotta.uso.ultimoUpdate'), fmtAgo(Date.parse(uso.ultimoUpdate), t)],
    uso.doctor && [
      t('flotta.uso.doctor'),
      [
        t('flotta.uso.doctorEsito', { ok: uso.doctor.ok ?? '?', warn: uso.doctor.warn ?? 0, ko: uso.doctor.ko ?? 0 }),
        uso.doctor.quando ? fmtAgo(Date.parse(uso.doctor.quando), t) : null,
        uso.doctor.falliti?.length ? uso.doctor.falliti.join(', ') : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    uso.optOut?.length > 0 && [t('flotta.uso.optOut'), uso.optOut.join(', ')],
    uso.sulMac > 0 && [t('flotta.uso.sulMac'), t('flotta.uso.sulMacN', { b: uso.bloccati, f: uso.forzati })],
    m.host?.toolMancantiNomi?.length > 0 && [t('flotta.uso.tool'), m.host.toolMancantiNomi.join(', ')],
    (m.motore || m.motoreIncerto) && [t('flotta.uso.motore'), m.motore ?? t('flotta.motoreIncerto')],
    m.vm?.cpu != null && [t('flotta.uso.cpu'), String(m.vm.cpu)],
    // Lo swap ha la sua curva qui sopra: in tabella solo quando la curva non c'e'.
    !m.serie && m.swapGb != null && [t('flotta.uso.swap'), `${gb(m.swapGb, lang)} GB`],
  ].filter(Boolean)
  const tempo = dati.serie
  return (
    <>
      {/* Sullo schermo largo: problemi e azioni a sinistra, grafici a destra, i dettagli sotto. Nel
          pannello del telefono i contenitori spariscono (`display: contents`) e l'ordine e' quello di prima. */}
      <div className={`fl-det-alto${m.serie && tempo ? '' : ' fl-det-solo'}`}>
        <div className="fl-det-sx">
          {m.problemi.length ? (
            <Sezione titolo={t('flotta.problemi')}>
              <ul className="fl-plist">
                {m.problemi.map((p, i) => {
                  // Due problemi con la stessa azione (la VM piccola e l'OOM che causa) la dicono una volta.
                  const ripetuta = m.problemi.slice(0, i).some((q) => q.azione?.k === p.azione?.k && q.azione?.comando === p.azione?.comando)
                  return (
                    <li key={p.tipo}>
                      <Dot livello={p.livello} />
                      <div>
                        <b>{fraseProblema(p, t, lang)}</b>
                        {ripetuta ? (
                          <span className="ui-faint">{t('flotta.stessaAzione')}</span>
                        ) : (
                          <span className="fl-plist-az">
                            {fraseAzione(p.azione, t, lang)} <ComandoInline comando={p.azione?.comando} t={t} />
                          </span>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Sezione>
          ) : (
            <p className="ui-mute">{t('flotta.nienteDaSistemare')}</p>
          )}
          {m.saluteAssente && <p className="ui-faint">{t('flotta.saluteAssente')}</p>}
          {!m.saluteAssente && !m.vm?.gb && m.saluteUltima && <p className="ui-faint">{t('flotta.saluteVecchia', { quando: fmtAgo(m.saluteUltima, t) })}</p>}
        </div>
        <div className="fl-det-dx">
          {m.serie && tempo && (
            <Sezione titolo={t('flotta.andamento')} sotto={t('flotta.andamentoSotto')}>
              <PiccoliMultipli
                serie={tempo}
                lang={lang}
                t={t}
                righe={SERIE.map((s) => ({
                  k: s.k,
                  etichetta: t(`flotta.serie.${s.k}`),
                  valori: m.serie[s.k] ?? [],
                  forma: s.forma,
                  colore: s.colore,
                  dominio: s.dominio(m),
                  formato: (v) => (s.k === 'oom' ? String(v) : `${s.k === 'cpu' ? Math.round(v) : gb(v, lang)}${s.unita ? ` ${s.unita}` : ''}`),
                }))}
              />
            </Sezione>
          )}
        </div>
        <div className="fl-det-cont">
          {(m.contenitori ?? []).length > 0 && (
            <Sezione titolo={t('flotta.contenitori')} sotto={m.vm?.gb ? t('flotta.contenitoriSotto', { gb: gb(m.vm.gb, lang) }) : null}>
              <div className="fl-cont">
                {m.contenitori.map((c) => {
                  const quota = vmMb > 0 && c.memMb != null ? c.memMb / vmMb : null
                  return (
                    <div key={c.nome} className="fl-cont-riga">
                      <span className="ui-mono">{c.nome}</span>
                      <span className="fl-cont-barra" aria-hidden="true">
                        {quota != null && <i className={quota > 0.35 ? 'fl-pesante' : ''} style={{ width: `${Math.min(100, quota * 100)}%` }} />}
                      </span>
                      <span className="fl-cont-v">
                        {c.memMb != null ? `${gb(c.memMb / 1024, lang)} GB` : '-'}
                        {c.cpuPct != null && <small>CPU {Math.round(c.cpuPct)}%</small>}
                      </span>
                    </div>
                  )
                })}
              </div>
            </Sezione>
          )}
        </div>
      </div>
      <div className="fl-det-basso">
        {(m.storia ?? []).length > 0 && (
          <Sezione titolo={t('flotta.avvii')}>
            <ul className="fl-avvii">
              {m.storia.slice(0, 6).map((a, i) => (
                <li key={`${a.quando}-${i}`}>
                  <Dot livello={a.esito === 'ok' ? 'off' : a.esito === 'ko' ? 'crit' : a.esito ? 'warn' : 'off'} />
                  <span className={a.esito && a.esito !== 'ok' ? '' : 'ui-mute'}>
                    {a.esito && a.esito !== 'ok' ? <b>{a.esito} </b> : null}
                    {fmtAgo(a.quando, t)}
                    {a.lato ? ` · ${a.lato}` : ''}
                    {a.durata != null ? ` · ${fmtMs(a.durata * 1000)}` : ''}
                    {(a.passo || a.classe || a.primaRiga) && (
                      <span className="ui-hint">{[a.passo && t('flotta.passo', { passo: a.passo }), a.classe, a.primaRiga].filter(Boolean).join(' · ')}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Sezione>
        )}

        {immagini.length > 0 && (
          <Sezione titolo={t('flotta.immagini')}>
            <dl className="fl-uso">
              {immagini.map((im) => (
                <div key={`${im.immagine}-${im.dal}`}>
                  <dt className="ui-mono">{digestCorto(im.immagine) || t('flotta.nonDichiarata')}</dt>
                  <dd className="ui-mute">
                    {[im.creata ? t('flotta.costruita', { data: dataCorta(Date.parse(im.creata), lang) }) : null, t('flotta.inUsoDa', { quando: fmtAgo(im.dal, t) })]
                      .filter(Boolean)
                      .join(' · ')}
                  </dd>
                </div>
              ))}
            </dl>
          </Sezione>
        )}

        {righeUso.length > 0 && (
          <Sezione titolo={t('flotta.uso')}>
            <dl className="fl-uso">
              {righeUso.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Sezione>
        )}
      </div>
      {(ssh || audit) && (
        <Sezione titolo={t('flotta.entrare')} sotto={t('flotta.entrareSotto')}>
          {ssh && (
            <p className="fl-entra">
              <ComandoInline comando={ssh} t={t} />
            </p>
          )}
          <ListaLink link={[{ label: t('flotta.audit'), href: audit, nota: t('accessi.vaiTeleportNota') }]} />
        </Sezione>
      )}
      <p className="ui-note">{t('home.soloLettura')}</p>
    </>
  )
}
