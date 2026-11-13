import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Verdetto, Tessere, Tessera, Tabs, Pill, GraficoBanda, Legenda } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import PollStatus from '../components/PollStatus.jsx'
import Loading from '../components/Loading.jsx'
import { soldi, leggi } from './spesaKit.js'
import {
  BLOCCHI,
  COME,
  LENTI,
  PREDEFINITO,
  RISCHI,
  SENZA_SQUADRA,
  VISTE_PRONTE,
  fattoreNetto,
  filtra,
  filtriAttivi,
  importo,
  queryDaStato,
  ruotaSettimana,
  salvaViste,
  settimanaNonProd,
  squadreDisponibili,
  statoDaQuery,
  statoVista,
  vistaAttiva,
  vistePersonali,
} from '../efficienza.js'
import './efficienza.css'

// Superficie «Efficienza»: Spesa dice quanto si paga, questa pagina quanto di quello che si paga si
// usa davvero, quanto costa un'unità di lavoro e quali leve recuperano soldi, in ordine di risparmio.
//
// Tutto lo stato (lente, filtri, scheda) vive nell'indirizzo: una vista si manda con un link, e le
// viste salvate sono solo indirizzi con un nome. L'ambiente lo sceglie il selettore in alto, come in
// tutte le altre pagine. I conti stanno in `web/efficienza.js`; qui si disegna.

const GIORNI_SETTIMANA = 7

function Segmenti({ id, valore, opzioni, onCambia, etichetta }) {
  return (
    <div className="eff-campo">
      <span className="eff-et" id={`${id}-et`}>{etichetta}</span>
      <div className="eff-seg" role="group" aria-labelledby={`${id}-et`}>
        {opzioni.map((o) => (
          <button key={o.v} type="button" aria-pressed={valore === o.v} onClick={() => onCambia(o.v)}>
            {o.l}
          </button>
        ))}
      </div>
    </div>
  )
}

function Chips({ id, valori, scelti, onCambia, etichetta, testo }) {
  return (
    <div className="eff-campo">
      <span className="eff-et" id={`${id}-et`}>{etichetta}</span>
      <div className="eff-chips" role="group" aria-labelledby={`${id}-et`}>
        {valori.map((v) => (
          <button
            key={v}
            type="button"
            className="eff-chip"
            aria-pressed={scelti.includes(v)}
            onClick={() => onCambia(scelti.includes(v) ? scelti.filter((x) => x !== v) : [...scelti, v])}
          >
            {testo(v)}
          </button>
        ))}
      </div>
    </div>
  )
}

function Barra({ parti, max }) {
  return (
    <span className="eff-barra" aria-hidden>
      {parti.map((p, i) => (
        <i key={i} style={{ width: max > 0 ? `${(p.v / max) * 100}%` : 0, background: p.colore }} />
      ))}
    </span>
  )
}

function Uso({ pct }) {
  if (pct == null) return <span className="eff-ignoto">-</span>
  return (
    <span className={`eff-uso ${pct < 30 ? 'basso' : ''}`}>
      <span className="eff-uso-traccia">
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      {Math.round(pct)}%
    </span>
  )
}

const vcpu = (cpu) => (cpu == null ? '-' : `${(cpu / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} vCPU`)
const gb = (mem) => (mem == null ? '-' : `${(mem / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`)

export default function EfficienzaPage({ t = (k) => k, lang, accountFilter = [] }) {
  const [params, setParams] = useSearchParams()
  const stato = useMemo(() => statoDaQuery(params.toString()), [params])
  const cambia = (diff) => setParams(new URLSearchParams(queryDaStato({ ...stato, ...diff })), { replace: true })

  const { data, loading, error, lastUpdated, refreshing, refresh } = usePoll(`/api/efficienza?giorni=${stato.giorni}&lang=${lang}`, {
    intervalMs: 15 * 60 * 1000,
  })
  const [trend, setTrend] = useState(null)
  useEffect(() => {
    if (stato.prezzo !== 'netto' || trend) return
    leggi('/api/costs/trend?months=3').then((r) => setTrend(r.dati ?? {}))
  }, [stato.prezzo, trend])
  const netto = useMemo(() => fattoreNetto(trend), [trend])

  const [personali, setPersonali] = useState(() => vistePersonali())
  const viste = useMemo(() => [...VISTE_PRONTE.map((v) => ({ ...v, nome: t(`eff.vista.${v.key}`) })), ...personali.map((v) => ({ ...v, stato: statoDaQuery(v.query) }))], [personali, t])
  const attiva = vistaAttiva(stato, viste)
  const salva = () => {
    const nome = t('eff.vista.nuova', { n: personali.length + 1 })
    const nuove = [...personali, { key: `p${Date.now()}`, nome, query: queryDaStato(stato) }]
    setPersonali(nuove)
    salvaViste(nuove)
  }
  const togliVista = (key) => {
    const nuove = personali.filter((v) => v.key !== key)
    setPersonali(nuove)
    salvaViste(nuove)
  }

  const f = useMemo(() => filtra(data, stato, accountFilter), [data, stato, accountFilter])
  const squadre = useMemo(() => squadreDisponibili(data), [data])
  const nomeSquadra = (s) => (s === SENZA_SQUADRA ? t('eff.squadra.senza') : s)
  const usd = (v) => (v == null ? '-' : soldi(importo(v, stato, netto), lang))
  const per = t(stato.importi === 'anno' ? 'eff.per.anno' : 'eff.per.mese')

  if (loading && !data) return <Loading />
  if (error && !data) return <div className="eff-errore">{t('eff.errore', { e: error })}</div>

  // Il grafico è di vCPU: con il solo database non ha niente da disegnare.
  const blocchi = BLOCCHI[stato.lente].filter((b) => !(b === 'grafico' && stato.risorsa === 'rds'))
  const ordine = (b) => ({ order: blocchi.indexOf(b), display: blocchi.includes(b) ? undefined : 'none' })
  const avvisi = Object.entries(data?.accounts ?? {}).flatMap(([k, a]) => (a.avvisi ?? []).map((x) => ({ ...x, account: a.label ?? k })))
  const fermo = f.usata == null ? null : Math.max(f.recuperabile, f.base * (1 - f.usata))
  const quotaSpot = (() => {
    const tot = f.servizi.reduce((a, s) => a + s.taskMedi, 0)
    return tot ? f.servizi.reduce((a, s) => a + s.taskMedi * s.quotaSpot, 0) / tot : null
  })()
  const impegni = (() => {
    const v = Object.entries(data?.impegni ?? {}).filter(([k, x]) => x && (!accountFilter.length || accountFilter.includes(k)))
    const tot = v.reduce((a, [, x]) => a + x.totale, 0)
    return tot ? v.reduce((a, [, x]) => a + x.coperta, 0) / tot : null
  })()
  const settimana = settimanaNonProd(data, accountFilter)
  const maxLeva = Math.max(0, ...f.leve.map((l) => l.usdMese))

  const testoLeva = (l) => {
    const d = l.dati ?? {}
    switch (l.tipo) {
      case 'taglia':
        return { titolo: t('eff.leva.taglia', { s: l.oggetto }), sotto: t('eff.leva.taglia.sotto', { da: `${vcpu(d.da.cpu)} · ${gb(d.da.memMb)}`, a: `${vcpu(d.a.cpu)} · ${gb(d.a.memMb)}`, cpu: Math.round(d.cpuP95 ?? 0), mem: Math.round(d.memP95 ?? 0) }) }
      case 'minimo':
        return { titolo: t('eff.leva.minimo', { s: l.oggetto }), sotto: t('eff.leva.minimo.sotto', { n: d.minimo }) }
      case 'spot':
        return { titolo: t('eff.leva.spot', { s: l.oggetto }), sotto: t('eff.leva.spot.sotto') }
      case 'orari':
        return { titolo: t('eff.leva.orari', { a: data?.accounts?.[l.account]?.label ?? l.account }), sotto: t('eff.leva.orari.sotto', { ore: d.oreFerme, n: d.servizi }) }
      case 'indici':
        return { titolo: t('eff.leva.indici', { s: l.oggetto }), sotto: t('eff.leva.indici.sotto', { n: d.n, gb: (d.gb ?? 0).toFixed(1) }) }
      case 'morte':
        return { titolo: t('eff.leva.morte', { s: l.oggetto }), sotto: t('eff.leva.morte.sotto', { n: d.n, gb: (d.gb ?? 0).toFixed(1) }) }
      case 'rds-taglia':
        return { titolo: t('eff.leva.rds', { s: l.oggetto }), sotto: t('eff.leva.rds.sotto', { da: d.da, a: d.a, cpu: Math.round(d.cpuP95 ?? 0), mem: Math.round(d.memLiberaMin ?? 0) }) }
      default:
        return { titolo: l.oggetto, sotto: '' }
    }
  }

  const andamento = f.giornaliero.length ? { punti: f.giornaliero.length, inizio: Date.parse(`${f.giornaliero[0].giorno}T00:00:00Z`), passoMs: 86400000 } : null

  return (
    <div className="eff">
      <div className="eff-testa">
        <Verdetto
          livello={f.recuperabile > 0 ? 'ok' : undefined}
          forte={f.recuperabile > 0 ? t('eff.verdetto.forte', { usd: usd(f.recuperabile), per }) : t('eff.verdetto.niente')}
          resto={f.base > 0 ? t('eff.verdetto.resto', { usd: usd(f.base), per, pct: Math.round((f.recuperabile / f.base) * 100) }) : ''}
          dettaglio={t(stato.prezzo === 'netto' ? 'eff.verdetto.netto' : 'eff.verdetto.listino')}
        />
        <PollStatus lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refresh} t={t} />
      </div>

      <div className="eff-lenti">
        <Tabs voci={LENTI.map((k) => ({ key: k, label: t(`eff.lente.${k}`) }))} attiva={stato.lente} onCambia={(k) => cambia({ lente: k })} />
      </div>

      <section className="eff-filtri" aria-label={t('eff.filtri')}>
        <div className="eff-riga">
          <span className="eff-et">{t('eff.viste')}</span>
          <div className="eff-chips">
            {viste.map((v) => (
              <span key={v.key} className={`eff-vista ${attiva === v.key ? 'on' : ''}`}>
                <button type="button" onClick={() => setParams(new URLSearchParams(queryDaStato(statoVista(v))), { replace: true })}>
                  {v.nome}
                </button>
                {v.query != null && (
                  <button type="button" className="eff-x" aria-label={t('eff.vista.togli', { n: v.nome })} onClick={() => togliVista(v.key)}>
                    ✕
                  </button>
                )}
              </span>
            ))}
            {!attiva && (
              <button type="button" className="eff-vista eff-salva" onClick={salva}>
                {t('eff.vista.salva')}
              </button>
            )}
          </div>
        </div>
        <div className="eff-riga">
          <Chips id="eff-squadra" etichetta={t('eff.f.squadra', { tag: data?.tagSquadra ?? '' })} valori={squadre} scelti={stato.squadra} onCambia={(v) => cambia({ squadra: v })} testo={nomeSquadra} />
          <Segmenti id="eff-risorsa" etichetta={t('eff.f.risorsa')} valore={stato.risorsa} onCambia={(v) => cambia({ risorsa: v })} opzioni={[{ v: '', l: t('eff.f.risorsa.tutto') }, { v: 'ecs', l: t('eff.f.risorsa.ecs') }, { v: 'rds', l: t('eff.f.risorsa.rds') }]} />
          <Segmenti id="eff-giorni" etichetta={t('eff.f.giorni')} valore={stato.giorni} onCambia={(v) => cambia({ giorni: v })} opzioni={['7', '30', '90'].map((g) => ({ v: g, l: t('eff.f.giorni.n', { n: g }) }))} />
          <Segmenti id="eff-prezzo" etichetta={t('eff.f.prezzo')} valore={stato.prezzo} onCambia={(v) => cambia({ prezzo: v })} opzioni={[{ v: 'listino', l: t('eff.f.prezzo.listino') }, { v: 'netto', l: t('eff.f.prezzo.netto') }]} />
          <Segmenti id="eff-importi" etichetta={t('eff.f.importi')} valore={stato.importi} onCambia={(v) => cambia({ importi: v })} opzioni={[{ v: 'mese', l: t('eff.f.importi.mese') }, { v: 'anno', l: t('eff.f.importi.anno') }]} />
        </div>
        <div className="eff-riga">
          <Chips id="eff-rischio" etichetta={t('eff.f.rischio')} valori={RISCHI} scelti={stato.rischio} onCambia={(v) => cambia({ rischio: v })} testo={(r) => t(`eff.rischio.${r}`)} />
          <Chips id="eff-come" etichetta={t('eff.f.come')} valori={COME} scelti={stato.come} onCambia={(v) => cambia({ come: v })} testo={(c) => t(`eff.come.${c}`)} />
          <Segmenti id="eff-minimo" etichetta={t('eff.f.minimo')} valore={stato.minimo} onCambia={(v) => cambia({ minimo: v })} opzioni={['0', '20', '100'].map((m) => ({ v: m, l: m === '0' ? t('eff.f.minimo.tutti') : t('eff.f.minimo.n', { n: m }) }))} />
        </div>
        <div className="eff-riga">
          <span className="eff-et">{t('eff.attivi')}</span>
          <div className="eff-chips">
            {filtriAttivi(stato).map((x) => (
              <button key={`${x.k}:${x.valore}`} type="button" className="eff-attivo" onClick={() => cambia(x.togli)}>
                {t(`eff.attivo.${x.k}`, { v: Array.isArray(x.valore) ? x.valore.map(nomeSquadra).join(', ') : x.k === 'risorsa' ? t(`eff.f.risorsa.${x.valore}`) : x.k.startsWith('senzaRischio') ? t(`eff.rischio.${x.valore}`) : x.k.startsWith('senzaCome') ? t(`eff.come.${x.valore}`) : x.valore })} ✕
              </button>
            ))}
            {filtriAttivi(stato).length === 0 && <span className="eff-tenue">{t('eff.attivi.nessuno')}</span>}
          </div>
          {filtriAttivi(stato).length > 0 && (
            <button type="button" className="eff-link" onClick={() => setParams(new URLSearchParams(queryDaStato({ ...PREDEFINITO, lente: stato.lente, scheda: stato.scheda })), { replace: true })}>
              {t('eff.azzera')}
            </button>
          )}
        </div>
      </section>

      {avvisi.length > 0 && (
        <ul className="eff-avvisi">
          {avvisi.map((a, i) => (
            <li key={i}>{t(`eff.avviso.${a.cosa}`, { a: a.account, perche: a.perche ?? '', n: a.n ?? 0 })}</li>
          ))}
        </ul>
      )}

      <div className="eff-blocchi">
        <div className="eff-risposta" style={ordine('risposta')}>
          <div className="eff-grande">
            <span className="eff-et">{t('eff.recuperabili', { per })}</span>
            <b className="eff-cifra">{usd(f.recuperabile)}</b>
            <span className="eff-tenue">{t('eff.su', { usd: usd(f.base), per })}</span>
            <span className="eff-metro" aria-hidden>
              <i style={{ width: f.base ? `${100 - (f.recuperabile / f.base) * 100}%` : 0, background: 'var(--chart-1)' }} />
              <i style={{ width: f.base ? `${(f.recuperabile / f.base) * 100}%` : 0, background: 'var(--ok)' }} />
            </span>
            <dl className="eff-kv">
              <dt>{t('eff.usato')}</dt>
              <dd>{fermo == null ? '-' : usd(f.base - fermo)}</dd>
              <dt>{t('eff.fermo')}</dt>
              <dd>{fermo == null ? '-' : usd(fermo)}</dd>
            </dl>
          </div>
          <div className="eff-leve">
            <div className="eff-leve-testa">
              <h3>{t('eff.leve.titolo')}</h3>
              <span className="eff-tenue">{t('eff.leve.quante', { n: f.leve.length, tot: data?.leve?.length ?? 0 })}</span>
            </div>
            {f.leve.length === 0 && <p className="eff-vuoto">{t('eff.leve.nessuna')}</p>}
            {f.leve.map((l) => {
              const tx = testoLeva(l)
              return (
                <div key={`${l.account}:${l.tipo}:${l.oggetto}`} className="eff-leva">
                  <span className="eff-leva-testo">
                    <b>{tx.titolo}</b>
                    <small>
                      {data?.accounts?.[l.account]?.label ?? l.account}
                      {l.squadra ? ` · ${l.squadra}` : ''} · {tx.sotto}
                    </small>
                  </span>
                  <span className="eff-leva-barra" aria-hidden>
                    <i style={{ width: maxLeva ? `${(l.usdMese / maxLeva) * 100}%` : 0 }} />
                  </span>
                  <Pill livello={l.rischio === 'basso' ? 'ok' : 'warn'}>{t(`eff.come.${l.come}`)}</Pill>
                  <span className="eff-leva-usd">{usd(l.usdMese)}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div style={ordine('tessere')}>
          <Tessere etichetta={t('eff.tessere')}>
            <Tessera etichetta={t('eff.t.usata')} valore={f.usata == null ? null : `${Math.round(f.usata * 100)}%`} livello={f.usata != null && f.usata < 0.4 ? 'warn' : undefined} sotto={t('eff.t.usata.sotto')} trend={{ valori: f.giornaliero.map((g) => (g.pagate ? g.usate / g.pagate : null)), descrizione: t('eff.t.usata.sotto') }} />
            <Tessera etichetta={t('eff.t.spot')} valore={quotaSpot == null ? null : `${Math.round(quotaSpot * 100)}%`} sotto={t('eff.t.spot.sotto')} />
            <Tessera etichetta={t('eff.t.impegni')} valore={impegni == null ? null : `${Math.round(impegni * 100)}%`} sotto={t('eff.t.impegni.sotto')} />
            <Tessera etichetta={t('eff.t.richieste')} valore={f.unita.length ? soldi(importo(f.unita.reduce((a, u) => a + u.usd, 0), { ...stato, importi: 'mese' }, netto) / (f.unita.reduce((a, u) => a + u.richieste, 0) / 1000), lang) : null} sotto={t('eff.t.richieste.sotto', { n: stato.giorni })} />
          </Tessere>
        </div>

        <div className="eff-blocco" style={ordine('unita')}>
          <div className="eff-blocco-testa">
            <h3>{t('eff.unita.titolo')}</h3>
            <span className="eff-tenue">{t('eff.unita.sotto', { n: stato.giorni })}</span>
          </div>
          <div className="eff-tabella">
            <table>
              <thead>
                <tr>
                  <th>{t('eff.col.servizio')}</th>
                  <th className="num">{t('eff.col.richieste')}</th>
                  <th className="num">{t('eff.col.costo')}</th>
                  <th className="num">{t('eff.col.per1000')}</th>
                </tr>
              </thead>
              <tbody>
                {f.unita.map((u) => (
                  <tr key={`${u.account}:${u.nome}`}>
                    <td>
                      <b className="eff-mono">{u.nome}</b>
                      <small>{data?.accounts?.[u.account]?.label ?? u.account}</small>
                    </td>
                    <td className="num">{Math.round(u.richieste).toLocaleString(lang === 'en' ? 'en-US' : 'it-IT')}</td>
                    <td className="num">{soldi(importo(u.usd, { ...stato, importi: 'mese' }, netto), lang)}</td>
                    <td className="num">{soldi(importo(u.per1000, { ...stato, importi: 'mese' }, netto), lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {f.unita.length === 0 && <p className="eff-vuoto">{t('eff.unita.nessuna')}</p>}
          </div>
        </div>

        <div className="eff-blocco" style={ordine('grafico')}>
          <div className="eff-blocco-testa">
            <h3>{t('eff.grafico.titolo')}</h3>
            <Legenda voci={[{ colore: 'var(--chart-1)', etichetta: t('eff.grafico.usate') }, { colore: 'color-mix(in srgb, var(--chart-1) 30%, transparent)', etichetta: t('eff.grafico.pagate') }]} />
          </div>
          {andamento ? (
            <GraficoBanda
              andamento={andamento}
              linea={f.giornaliero.map((g) => g.usate)}
              alto={f.giornaliero.map((g) => g.pagate)}
              lang={lang}
              t={t}
              aria={t('eff.grafico.aria')}
              formato={(v) => Math.round(v).toLocaleString(lang === 'en' ? 'en-US' : 'it-IT')}
              etichette={{ linea: t('eff.grafico.usate'), alto: t('eff.grafico.pagate') }}
            />
          ) : (
            <p className="eff-vuoto">{t('eff.grafico.vuoto')}</p>
          )}
        </div>

        <div className="eff-blocco" style={ordine('dettaglio')}>
          <Tabs
            voci={[
              { key: 'calcolo', label: t('eff.scheda.calcolo'), n: f.servizi.length },
              { key: 'database', label: t('eff.scheda.database'), n: f.database.length },
              { key: 'chi', label: t('eff.scheda.chi') },
            ]}
            attiva={stato.scheda}
            onCambia={(k) => cambia({ scheda: k })}
          />
          {stato.scheda === 'calcolo' && (
            <div className="eff-scheda">
              <div className="eff-tabella">
                <table>
                  <thead>
                    <tr>
                      <th>{t('eff.col.servizio')}</th>
                      <th>{t('eff.col.chiede')}</th>
                      <th>{t('eff.col.cpu')}</th>
                      <th>{t('eff.col.mem')}</th>
                      <th>{t('eff.col.task')}</th>
                      <th>{t('eff.col.proposta')}</th>
                      <th className="num">{t('eff.col.costo')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...f.servizi].sort((a, b) => (b.usdMese ?? 0) - (a.usdMese ?? 0)).map((s) => (
                      <tr key={`${s.account}:${s.cluster}:${s.nome}`}>
                        <td>
                          <b className="eff-mono">{s.nome}</b>
                          <small>
                            {data?.accounts?.[s.account]?.label ?? s.account} · {s.cluster}
                            {s.squadra ? ` · ${s.squadra}` : ''}
                          </small>
                        </td>
                        <td>{`${vcpu(s.cpu)} · ${gb(s.memMb)}`}</td>
                        <td><Uso pct={s.cpuP95} /></td>
                        <td><Uso pct={s.memP95} /></td>
                        <td>
                          {s.min != null ? t('eff.task.scala', { n: Math.round(s.taskMedi * 10) / 10, min: s.min, max: s.max }) : t('eff.task.fissi', { n: s.attivi })}
                          {s.quotaSpot > 0 && <small>{t('eff.task.spot', { pct: Math.round(s.quotaSpot * 100) })}</small>}
                        </td>
                        <td>{s.proposta ? `${vcpu(s.proposta.cpu)} · ${gb(s.proposta.memMb)}` : <span className="eff-tenue">{t('eff.proposta.giusta')}</span>}</td>
                        <td className="num">{usd(s.usdMese)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {f.servizi.length === 0 && <p className="eff-vuoto">{t('eff.calcolo.nessuno')}</p>}
              </div>
              <p className="eff-nota">{t('eff.calcolo.nota')}</p>
              {settimana && (
                <div className="eff-settimana">
                  <h3>{t('eff.settimana.titolo', { a: settimana.chiavi.map((k) => data.accounts[k]?.label ?? k).join(', ') })}</h3>
                  <Settimana celle={ruotaSettimana(settimana.celle, new Date().getTimezoneOffset())} t={t} />
                </div>
              )}
            </div>
          )}
          {stato.scheda === 'database' && (
            <div className="eff-scheda">
              <div className="eff-tabella">
                <table>
                  <thead>
                    <tr>
                      <th>{t('eff.col.database')}</th>
                      <th>{t('eff.col.classe')}</th>
                      <th>{t('eff.col.cpu')}</th>
                      <th>{t('eff.col.memLibera')}</th>
                      <th className="num">{t('eff.col.connessioni')}</th>
                      <th>{t('eff.col.proposta')}</th>
                      <th className="num">{t('eff.col.costo')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.database.map((d) => (
                      <tr key={`${d.account}:${d.id}`}>
                        <td>
                          <b className="eff-mono">{d.id}</b>
                          <small>
                            {data?.accounts?.[d.account]?.label ?? d.account} · {d.motore} {d.versione ?? ''}
                            {d.multiAz ? ' · Multi-AZ' : ''}
                            {d.replica ? ` · ${t('eff.db.replica')}` : ''}
                          </small>
                        </td>
                        <td>
                          {d.classe}
                          {d.vcpu ? <small>{`${d.vcpu} vCPU · ${Math.round(d.memGb)} GB`}</small> : null}
                        </td>
                        <td><Uso pct={d.cpuP95} /></td>
                        <td>{d.memLiberaMin == null ? '-' : `${Math.round(d.memLiberaMin)}%`}</td>
                        <td className="num">{d.connessioniMax == null ? '-' : Math.round(d.connessioniMax)}</td>
                        <td>{d.proposta ? d.proposta.classe : <span className="eff-tenue">{t('eff.proposta.giusta')}</span>}</td>
                        <td className="num">{usd(d.usdMese)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {f.database.length === 0 && <p className="eff-vuoto">{t('eff.database.nessuno')}</p>}
              </div>
              <p className="eff-nota">{t('eff.database.nota')}</p>
              {f.database.filter((d) => d.interno).map((d) => (
                <Interno key={`${d.account}:${d.id}`} d={d} t={t} lang={lang} />
              ))}
              {!data?.postgres?.configurati?.length && <p className="eff-nota">{t('eff.pg.spento')}</p>}
            </div>
          )}
          {stato.scheda === 'chi' && (
            <div className="eff-scheda eff-due">
              <div>
                <h3>{t('eff.chi.squadra', { tag: data?.tagSquadra ?? '' })}</h3>
                <ul className="eff-righe">
                  {f.squadre.map((s) => (
                    <li key={s.k}>
                      <button type="button" className={stato.squadra.includes(s.k) ? 'on' : ''} onClick={() => cambia({ squadra: stato.squadra.includes(s.k) ? stato.squadra.filter((x) => x !== s.k) : [...stato.squadra, s.k] })}>
                        <span>{nomeSquadra(s.k)}</span>
                        <Barra parti={[{ v: s.usd, colore: s.k === SENZA_SQUADRA ? 'var(--warn)' : 'var(--chart-1)' }]} max={f.squadre[0]?.usd ?? 0} />
                        <b>{usd(s.usd)}</b>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="eff-nota">{t('eff.chi.senza')}</p>
              </div>
              <div>
                <h3>{t('eff.chi.ambiente')}</h3>
                <ul className="eff-righe">
                  {f.ambienti.map((a) => (
                    <li key={a.k}>
                      <span className="eff-riga-statica">
                        <span>{data?.accounts?.[a.k]?.label ?? a.k}</span>
                        <Barra parti={[{ v: a.usd, colore: data?.accounts?.[a.k]?.nonProd ? 'var(--chart-4)' : 'var(--chart-1)' }]} max={f.ambienti[0]?.usd ?? 0} />
                        <b>{usd(a.usd)}</b>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// La settimana tipo di un ambiente: sette righe da ventiquattro ore, il colore dice quanto lavora.
function Settimana({ celle, t }) {
  const picco = Math.max(0, ...celle.filter((v) => v != null))
  const giorni = Array.from({ length: GIORNI_SETTIMANA }, (_, g) => g)
  return (
    <div className="eff-mappa" role="img" aria-label={t('eff.settimana.aria')}>
      {giorni.map((g) => (
        <div key={g} className="eff-mappa-riga">
          <span>{t(`eff.giorno.${g}`)}</span>
          {Array.from({ length: 24 }, (_, h) => {
            const v = celle[g * 24 + h]
            const pct = v == null || !picco ? 0 : Math.round((v / picco) * 100)
            return <i key={h} title={`${t(`eff.giorno.${g}`)} ${h}:00`} style={{ background: v == null ? 'var(--off-soft)' : `color-mix(in srgb, var(--chart-1) ${Math.max(4, pct)}%, var(--off-soft))` }} />
          })}
        </div>
      ))}
      <div className="eff-mappa-riga eff-mappa-ore">
        <span />
        {[0, 6, 12, 18].map((h) => (
          <em key={h} style={{ gridColumn: `${h + 2} / span 6` }}>
            {h}
          </em>
        ))}
      </div>
    </div>
  )
}

const byte = (b, lang) => {
  const gb = (b ?? 0) / 1024 ** 3
  const fmt = (v, c) => v.toLocaleString(lang === 'en' ? 'en-US' : 'it-IT', { maximumFractionDigits: c })
  return gb >= 1 ? `${fmt(gb, 1)} GB` : `${fmt((b ?? 0) / 1024 ** 2, 0)} MB`
}
const quanti = (n, lang) => {
  const v = Number(n ?? 0)
  const fmt = (x, c) => x.toLocaleString(lang === 'en' ? 'en-US' : 'it-IT', { maximumFractionDigits: c })
  return v >= 1e6 ? `${fmt(v / 1e6, 1)} M` : v >= 1e3 ? `${fmt(v / 1e3, 0)}k` : fmt(v, 0)
}

// Dentro un database: le statistiche di Postgres, quando sono configurate. Dice dove va lo spazio e
// quali tabelle chiedono attenzione; un errore di connessione si mostra com'è, senza nascondere il resto.
function Interno({ d, t, lang }) {
  const pg = d.interno
  if (pg.errore) return <p className="eff-avvisi">{t('eff.pg.errore', { id: d.id, e: pg.errore })}</p>
  const max = Math.max(0, ...(pg.schemi ?? []).map((x) => x.heap + x.indici + x.toast))
  const db = pg.db ?? {}
  const attenzione = (pg.tabelle ?? []).filter((x) => x.segnali?.length)
  return (
    <div className="eff-interno">
      <h3>{t('eff.pg.titolo', { id: d.id })}</h3>
      <Tessere etichetta={t('eff.pg.titolo', { id: d.id })}>
        <Tessera etichetta={t('eff.pg.dimensione')} valore={byte(db.dimensione, lang)} />
        <Tessera etichetta={t('eff.pg.memoria')} valore={db.memoria == null ? null : `${(db.memoria * 100).toLocaleString(lang === 'en' ? 'en-US' : 'it-IT', { maximumFractionDigits: 1 })}%`} livello={db.memoria != null && db.memoria < 0.99 ? 'warn' : undefined} sotto={t('eff.pg.memoria.sotto')} />
        <Tessera etichetta={t('eff.pg.connessioni')} valore={db.connessioni == null ? null : `${db.connessioni} / ${db.limite}`} sotto={db.in_attesa ? t('eff.pg.lock', { n: db.in_attesa }) : t('eff.pg.lock.nessuno')} livello={db.in_attesa ? 'warn' : undefined} />
        <Tessera etichetta={t('eff.pg.indici')} valore={byte((pg.indiciInutili ?? []).reduce((a, i) => a + i.byte, 0), lang)} sotto={t('eff.pg.indici.sotto', { n: (pg.indiciInutili ?? []).length })} />
      </Tessere>
      <div className="eff-due">
        <div>
          <div className="eff-blocco-testa">
            <h3>{t('eff.pg.schemi')}</h3>
            <Legenda voci={[{ colore: 'var(--chart-1)', etichetta: t('eff.pg.righe') }, { colore: 'var(--chart-2)', etichetta: t('eff.pg.indiciS') }, { colore: 'var(--chart-3)', etichetta: 'TOAST' }]} />
          </div>
          <ul className="eff-righe">
            {(pg.schemi ?? []).map((x) => (
              <li key={x.schema}>
                <span className="eff-riga-statica">
                  <span>
                    <b className="eff-mono">{x.schema}</b>
                    <small className="eff-tenue"> {t('eff.pg.schema.sotto', { n: x.tabelle, righe: quanti(x.righe, lang) })}</small>
                  </span>
                  <Barra parti={[{ v: x.heap, colore: 'var(--chart-1)' }, { v: x.indici, colore: 'var(--chart-2)' }, { v: x.toast, colore: 'var(--chart-3)' }]} max={max} />
                  <b>{byte(x.heap + x.indici + x.toast, lang)}</b>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>{t('eff.pg.attenzione')}</h3>
          {attenzione.length === 0 && (pg.indiciInutili ?? []).length === 0 && <p className="eff-vuoto">{t('eff.pg.attenzione.niente')}</p>}
          <ul className="eff-segnali">
            {attenzione.flatMap((x) =>
              x.segnali.map((sg) => (
                <li key={`${x.schema}.${x.tabella}:${sg}`}>
                  <b>{t(`eff.pg.segnale.${sg}`)}</b> <span className="eff-mono">{`${x.schema}.${x.tabella}`}</span>
                  <small>
                    {sg === 'morte'
                      ? t('eff.pg.segnale.morte.sotto', { pct: Math.round((x.morte / Math.max(1, x.vive + x.morte)) * 100), gb: byte(x.totale, lang) })
                      : t('eff.pg.segnale.intere.sotto', { n: quanti(x.letture_intere, lang), gb: byte(x.heap, lang) })}
                  </small>
                </li>
              )),
            )}
            {(pg.indiciInutili ?? []).slice(0, 5).map((i) => (
              <li key={`${i.schema}.${i.indice}`}>
                <b>{t('eff.pg.segnale.indice')}</b> <span className="eff-mono">{`${i.schema}.${i.indice}`}</span>
                <small>{t('eff.pg.segnale.indice.sotto', { gb: byte(i.byte, lang), tabella: i.tabella })}</small>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {db.dal && <p className="eff-nota">{t('eff.pg.dal', { d: new Date(db.dal).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT') })}</p>}
    </div>
  )
}
