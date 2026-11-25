import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Verdetto, Tabs } from '../ui/index.js'
import { usePoll } from '../usePoll.js'
import PollStatus from '../components/PollStatus.jsx'
import Loading from '../components/Loading.jsx'
import { soldi, leggi } from './spesaKit.js'
import {
  COME,
  LENTI,
  PREDEFINITO,
  RISCHI,
  SENZA_SQUADRA,
  VISTE_PRONTE,
  fattoreNetto,
  ultimoMeseChiuso,
  filtra,
  filtriAttivi,
  importo,
  queryDaStato,
  salvaViste,
  partenza,
  semaforo,
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
    <span className={`eff-uso ${pct < 30 ? 'basso' : pct >= 80 ? 'alto' : ''}`}>
      <span className="eff-uso-traccia">
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      {Math.round(pct)}%
    </span>
  )
}

const vcpu = (cpu) => (cpu == null ? '-' : `${(cpu / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} vCPU`)
const gb = (mem) => (mem == null ? '-' : `${(mem / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`)

// Un grafico solo per riga, ora per ora sulle ultime due settimane: CPU e memoria (il massimo di ogni
// ora) con la zona «al limite» oltre l'80%, e sotto le copie accese a gradini. Passando il mouse si legge
// giorno, ora e valori di quel momento. Con più copie la CPU è la media delle copie: 99% = tutte piene.
const LARG = 340
const ALT = 64
const ALT_COPIE = 26
const MARGINE = 3
const xDi = (i, n) => (n > 1 ? MARGINE + (i * (LARG - 2 * MARGINE)) / (n - 1) : LARG / 2)
const yPct = (v) => ALT - MARGINE - (Math.min(100, Math.max(0, v)) / 100) * (ALT - 2 * MARGINE)

function percorso(serie) {
  const n = serie.length
  let d = ''
  let prima = true
  serie.forEach((v, i) => {
    if (v == null) {
      prima = true
      return
    }
    d += `${prima ? 'M' : 'L'}${xDi(i, n).toFixed(1)},${yPct(v).toFixed(1)}`
    prima = false
  })
  return d
}

// Le copie a gradini: ogni ora un tratto orizzontale alla quota delle copie accese.
function gradini(serie, massimo) {
  const n = serie.length
  const y = (v) => ALT_COPIE - 2 - (v / massimo) * (ALT_COPIE - 4)
  let linea = ''
  let area = ''
  let aperto = false
  serie.forEach((v, i) => {
    if (v == null) {
      if (aperto) area += `L${xDi(i - 1, n).toFixed(1)},${ALT_COPIE}Z`
      aperto = false
      return
    }
    const x0 = xDi(i, n).toFixed(1)
    const x1 = xDi(i + 1 < n ? i + 1 : i, n).toFixed(1)
    if (!aperto) {
      area += `M${x0},${ALT_COPIE}L${x0},${y(v).toFixed(1)}`
      linea += `M${x0},${y(v).toFixed(1)}`
      aperto = true
    } else {
      linea += `L${x0},${y(v).toFixed(1)}`
      area += `L${x0},${y(v).toFixed(1)}`
    }
    linea += `L${x1},${y(v).toFixed(1)}`
    area += `L${x1},${y(v).toFixed(1)}`
  })
  if (aperto) area += `L${xDi(n - 1, n).toFixed(1)},${ALT_COPIE}Z`
  return { linea, area }
}

function GraficoUso({ r, t, lang }) {
  const [sopra, setSopra] = useState(null)
  const o = r.oraria
  const n = o?.cpu?.length ?? 0
  const ha = (serie) => serie && serie.filter((v) => v != null).length > 1
  const conCpu = ha(o?.cpu)
  const conMem = ha(o?.mem)
  const conCopie = ha(o?.copie)
  const loc = lang === 'en' ? 'en-GB' : 'it-IT'
  const pct = (v) => (v == null ? '-' : `${Math.round(v)}%`)
  if (!o || (!conCpu && !conMem)) {
    return (
      <span className="eff-gr">
        <span className="eff-gr-vuoto">{t('eff.gr.nodati')}</span>
      </span>
    )
  }
  const copie = o.copie.filter((v) => v != null)
  const maxCopie = Math.max(1, ...copie)
  const minCopie = copie.length ? Math.min(...copie) : 0
  const quando = (i) => new Date(o.inizio + i * o.passoMs)
  // Un filo verticale a ogni cambio di giorno, con il giorno scritto ogni due.
  const giorni = []
  let precedente = null
  for (let i = 0; i < n; i++) {
    const d = quando(i)
    const giorno = d.toDateString()
    if (giorno !== precedente) giorni.push({ i, d })
    precedente = giorno
  }
  const ore = o.passoMs / 3600000
  const passo = ore < 24 ? t('eff.gr.ore', { n: ore }) : t('eff.gr.giorni', { n: ore / 24 })
  const sul = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - box.left) / box.width) * LARG
    setSopra(Math.max(0, Math.min(n - 1, Math.round(((x - MARGINE) / (LARG - 2 * MARGINE)) * (n - 1)))))
  }
  const i = sopra
  const valCpu = i == null ? r.cpu : o.cpu[i]
  const valMem = i == null ? r.mem : o.mem[i]
  const valCopie = i == null ? null : o.copie[i]
  const gr = conCopie ? gradini(o.copie, maxCopie) : null
  const alt = ALT + (conCopie ? ALT_COPIE + 4 : 0) + 12
  return (
    <span className="eff-gr">
      <span className="eff-gr-leg">
        <span className="eff-gr-cpu">{t('eff.sem.cpu')} <b>{pct(valCpu)}</b></span>
        <span className="eff-gr-mem">{t('eff.sem.mem')} <b>{pct(valMem)}</b></span>
      </span>
      <svg width={LARG} height={alt} viewBox={`0 0 ${LARG} ${alt}`} role="img" aria-label={t('eff.gr.aria', { nome: r.nome })} onMouseMove={sul} onMouseLeave={() => setSopra(null)}>
        <rect x="0" y="0" width={LARG} height={ALT} rx="6" className="eff-gr-fondo" />
        <rect x="0" y="0" width={LARG} height={MARGINE + (ALT - 2 * MARGINE) * 0.2} className="eff-gr-zona" />
        {giorni.map(({ i: gi }) => (
          <line key={gi} x1={xDi(gi, n)} x2={xDi(gi, n)} y1="0" y2={ALT + (conCopie ? ALT_COPIE + 4 : 0)} className="eff-gr-giorno" />
        ))}
        <line x1="0" x2={LARG} y1={yPct(80)} y2={yPct(80)} className="eff-gr-soglia" />
        {conMem && <path d={percorso(o.mem)} className="eff-gr-linea-mem" />}
        {conCpu && <path d={percorso(o.cpu)} className="eff-gr-linea-cpu" />}
        {gr && (
          <g transform={`translate(0 ${ALT + 4})`}>
            <rect x="0" y="0" width={LARG} height={ALT_COPIE} rx="4" className="eff-gr-fondo" />
            <path d={gr.area} className="eff-gr-area-copie" />
            <path d={gr.linea} className="eff-gr-linea-copie" />
            <text x="4" y="9" className="eff-gr-asse">{maxCopie}</text>
            <text x="4" y={ALT_COPIE - 3} className="eff-gr-asse">0</text>
          </g>
        )}
        {giorni.filter((_, k) => k % 2 === 0).map(({ i: gi, d }) => (
          <text key={gi} x={Math.min(LARG - 18, xDi(gi, n) + 2)} y={alt - 2} className="eff-gr-asse">
            {d.toLocaleDateString(loc, { weekday: 'short', day: 'numeric' })}
          </text>
        ))}
        {i != null && (
          <g>
            <line x1={xDi(i, n)} x2={xDi(i, n)} y1="0" y2={ALT + (conCopie ? ALT_COPIE + 4 : 0)} className="eff-gr-cursore" />
            {o.cpu[i] != null && <circle cx={xDi(i, n)} cy={yPct(o.cpu[i])} r="3" className="eff-gr-punto-cpu" />}
            {o.mem[i] != null && <circle cx={xDi(i, n)} cy={yPct(o.mem[i])} r="3" className="eff-gr-punto-mem" />}
          </g>
        )}
      </svg>
      <span className="eff-gr-piede">
        {i == null ? (
          <>
            <span>{t('eff.gr.passo', { p: passo })}</span>
            {conCopie && <span>{minCopie === maxCopie ? t('eff.gr.copie', { n: maxCopie }) : t('eff.gr.copieDa', { a: minCopie, b: maxCopie })}</span>}
          </>
        ) : (
          <>
            <span>{quando(i).toLocaleString(loc, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            {valCopie != null && <b>{t('eff.gr.copie', { n: valCopie })}</b>}
          </>
        )}
      </span>
    </span>
  )
}

// Elenco corto: le prime voci, e un pulsante per le altre. Chi legge parte dall'alto e non si perde.
function Elenco({ voci, quante = 5, t, vuoto }) {
  const [tutte, setTutte] = useState(false)
  if (!voci.length) return vuoto ? <p className="eff-vuoto">{vuoto}</p> : null
  return (
    <>
      <ul className="eff-schede">{tutte ? voci : voci.slice(0, quante)}</ul>
      {voci.length > quante && (
        <button type="button" className="eff-link" onClick={() => setTutte(!tutte)}>
          {tutte ? t('eff.card.meno') : t('eff.card.altre', { n: voci.length - quante })}
        </button>
      )}
    </>
  )
}

export default function EfficienzaPage({ t = (k) => k, lang, accountFilter = [] }) {
  const [params, setParams] = useSearchParams()
  const stato = useMemo(() => statoDaQuery(params.toString()), [params])
  const cambia = (diff) => setParams(new URLSearchParams(queryDaStato({ ...stato, ...diff })), { replace: true })

  const { data, loading, error, lastUpdated, refreshing, refresh } = usePoll(`/api/efficienza?giorni=${stato.giorni}&lang=${lang}`, {
    intervalMs: 15 * 60 * 1000,
  })
  const [trend, setTrend] = useState(null)
  useEffect(() => {
    if ((stato.prezzo !== 'netto' && stato.importi !== 'ultimo') || trend) return
    leggi('/api/costs/trend?months=3').then((r) => setTrend(r.dati ?? {}))
  }, [stato.prezzo, stato.importi, trend])
  const netto = useMemo(() => fattoreNetto(trend), [trend])
  const ultimo = useMemo(() => ultimoMeseChiuso(trend), [trend])

  const [soloDaGuardare, setSoloDaGuardare] = useState(true)
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
  const nomeMese = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { month: 'long', year: 'numeric', timeZone: 'UTC' })

  if (loading && !data) return <Loading />
  if (error && !data) return <div className="eff-errore">{t('eff.errore', { e: error })}</div>

  const avvisi = Object.entries(data?.accounts ?? {}).flatMap(([k, a]) => (a.avvisi ?? []).map((x) => ({ ...x, account: a.label ?? k })))
  const sem = semaforo(f)
  const par = partenza(f, sem)

  const nomeCompleto = (r) => `${r.nome} (${data?.accounts?.[r.account]?.label ?? r.account})`
  const voce = (key, { tag, titolo, ora, fare, cifra, cifraEt }) => (
    <li key={key} className="eff-voce">
      <span className={`eff-tag eff-tag-${tag}`}>{t(`eff.par.${tag}`)}</span>
      <span className="eff-par-testo">
        <b>{titolo}</b>
        <span>{ora}</span>
        <span className="eff-fare">
          <b>{t('eff.card.fare')}</b> {fare}
        </span>
      </span>
      <span className="eff-par-cifra">
        {cifra}
        <small>{cifraEt}</small>
      </span>
    </li>
  )
  const schedaRischio = (r) =>
    voce(`r:${r.account}:${r.tipo}:${r.nome}`, {
      tag: 'rischio',
      titolo: t(`eff.card.titolo.${r.tipo}.tappo`, { s: nomeCompleto(r) }),
      ora: t(`eff.card.ora.${r.motivo}`, { v: Math.round(r.valore ?? 0) }),
      fare: r.tipo === 'db' ? t('eff.card.fare.dbGrande') : t('eff.card.fare.piuGrande'),
      cifra: usd(r.usdMese),
      cifraEt: t('eff.card.costaOggi', { per }),
    })
  const schedaSpreco = (r) =>
    voce(`s:${r.account}:${r.tipo}:${r.nome}`, {
      tag: 'risparmio',
      titolo: t(`eff.card.titolo.${r.tipo}.spreco`, { s: nomeCompleto(r) }),
      ora: t('eff.card.ora.spreco', { cpu: Math.round(r.cpu ?? 0) }),
      fare: t('eff.card.fare.riduci'),
      cifra: usd(r.risparmio ?? r.usdMese),
      cifraEt: t(r.risparmio != null ? 'eff.card.recuperi' : 'eff.card.costaOggi', { per }),
    })
  const schedaLeva = (l) => {
    const d = l.dati ?? {}
    const s = `${l.oggetto} (${data?.accounts?.[l.account]?.label ?? l.account})`
    const comune = { tag: 'risparmio', cifra: usd(l.usdMese), cifraEt: t('eff.card.recuperi', { per }) }
    const dimensioni = d.da && d.a && typeof d.da === 'object' ? { da: `${vcpu(d.da.cpu)} · ${gb(d.da.memMb)}`, a: `${vcpu(d.a.cpu)} · ${gb(d.a.memMb)}` } : { da: d.da, a: d.a }
    const x = { s, n: d.minimo ?? d.n ?? d.servizi ?? d.repliche ?? 2, ore: d.oreFerme, gb: (d.gb ?? 0).toFixed(1), cpu: Math.round(d.cpuP95 ?? 0), mem: Math.round(d.memP95 ?? 0), memLibera: Math.round(d.memLiberaMin ?? 0), a: data?.accounts?.[l.account]?.label ?? l.account, ...dimensioni }
    const tipo = ['taglia', 'minimo', 'spot', 'orari', 'indici', 'morte', 'rds-taglia'].includes(l.tipo) ? l.tipo : 'altro'
    return voce(`l:${l.account}:${l.tipo}:${l.oggetto}`, {
      ...comune,
      titolo: t(`eff.card.leva.${tipo}.titolo`, x),
      ora: t(`eff.card.leva.${tipo}.ora`, x),
      fare: t(`eff.card.leva.${tipo}.fare`, x),
    })
  }
  const leveOrdinate = [...f.leve].sort((a, b) => b.usdMese - a.usdMese)
  const vociPartenza = [...sem.tappo.slice(0, 3).map(schedaRischio), ...leveOrdinate.map(schedaLeva)]
  const avvisiN = avvisi.reduce((a, x) => a + (x.n ?? 0), 0)
  const rigaStato = (r) => (
    <li key={`${r.stato}:${r.account}:${r.tipo}:${r.nome}`} className="eff-riga-uso">
      <span className="eff-par-testo">
        <b>{r.nome}</b>
        <small>
          {data?.accounts?.[r.account]?.label ?? r.account} · {t(`eff.sem.tipo.${r.tipo}`)}
          {r.taglia ? ` · ${r.taglia}` : ''}
        </small>
      </span>
      <span className={`eff-stato eff-stato-${r.stato}`}>{t(`eff.stato.${r.stato}`)}</span>
      <GraficoUso r={r} t={t} lang={lang} />
      <span className="eff-costo">
        <b>{usd(r.usdMese)}</b>
        {r.stato === 'spreco' && r.risparmio != null && <small className="eff-recupero">{`-${usd(r.risparmio)}`}</small>}
      </span>
    </li>
  )
  const riga = (key, nome, usdMese, colore, max) => (
    <li key={key} className="eff-riga-sq">
      <span>{nome}</span>
      <Barra parti={[{ v: usdMese, colore }]} max={max} />
      <b>{usd(usdMese)}</b>
    </li>
  )

  return (
    <div className="eff">
      <div className="eff-testa">
        {stato.lente === 'squadra' ? (
          <Verdetto forte={t('eff.verdetto.spesa', { usd: usd(f.base), per })} dettaglio={t(stato.prezzo === 'netto' ? 'eff.verdetto.netto' : 'eff.verdetto.listino')} />
        ) : (
          <Verdetto
            livello={par.rischi.length ? 'crit' : par.risparmi.length ? 'ok' : undefined}
            forte={par.rischi.length + par.risparmi.length ? t('eff.par.forte', { n: par.rischi.length + par.risparmi.length }) : t('eff.verdetto.niente')}
            resto={par.rischi.length + par.risparmi.length ? ` ${t('eff.par.resto', { r: par.rischi.length, usd: usd(par.usd), per })}` : ''}
            dettaglio={t(stato.prezzo === 'netto' ? 'eff.verdetto.netto' : 'eff.verdetto.listino')}
          />
        )}
        <PollStatus lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refresh} t={t} />
      </div>

      <div className="eff-opzioni">
        <Segmenti id="eff-risorsa" etichetta={t('eff.f.risorsa')} valore={stato.risorsa} onCambia={(v) => cambia({ risorsa: v })} opzioni={[{ v: '', l: t('eff.f.risorsa.tutto') }, { v: 'ecs', l: t('eff.f.risorsa.ecs') }, { v: 'rds', l: t('eff.f.risorsa.rds') }]} />
        <Segmenti id="eff-prezzo" etichetta={t('eff.f.prezzo')} valore={stato.prezzo} onCambia={(v) => cambia({ prezzo: v })} opzioni={[{ v: 'listino', l: t('eff.f.prezzo.listino') }, { v: 'netto', l: t('eff.f.prezzo.netto') }]} />
        <Segmenti id="eff-importi" etichetta={t('eff.f.importi')} valore={stato.importi} onCambia={(v) => cambia({ importi: v })} opzioni={[{ v: 'mese', l: t('eff.f.importi.mese') }, { v: 'anno', l: t('eff.f.importi.anno') }, { v: 'ultimo', l: t('eff.f.importi.ultimo') }]} />
        {avvisiN > 0 && <span className="eff-stime">{t('eff.avvisi.sintesi', { n: avvisiN })}</span>}
      </div>

      {stato.importi === 'ultimo' && (
        <p className="eff-ultimo">
          {ultimo ? t('eff.ultimo.riga', { mese: nomeMese(ultimo.mese), usd: soldi(ultimo.invoiced, lang), listino: soldi(ultimo.usage, lang) }) : t('eff.ultimo.nessuno')}
        </p>
      )}

      <div className="eff-lenti">
        <Tabs voci={LENTI.map((k) => ({ key: k, label: t(`eff.lente.${k}`) }))} attiva={stato.lente} onCambia={(k) => cambia({ lente: k })} />
      </div>
      <p className="eff-domanda">{t(`eff.lente.sub.${stato.lente}`, { per })}</p>

      {stato.lente === 'risparmio' && <Elenco voci={vociPartenza} t={t} vuoto={t('eff.verdetto.niente')} />}

      {stato.lente === 'capacita' && (
        <>
          <div className="eff-filtro-sani">
            <label>
              <input type="checkbox" checked={soloDaGuardare} onChange={(e) => setSoloDaGuardare(e.target.checked)} /> {t('eff.sem.solo')}
            </label>
            <span className="eff-tenue">{t('eff.sem.conta', { t: sem.tappo.length, s: sem.spreco.length, k: sem.sani.length + sem.nodati.length })}</span>
            <span className="eff-legenda" aria-label={t('eff.leg.titolo')}>
              <span><i className="eff-leg-linea eff-leg-cpu" /> {t('eff.sem.cpu')}</span>
              <span><i className="eff-leg-linea eff-leg-mem" /> {t('eff.sem.mem')}</span>
              <span><i className="eff-leg-limite" /> {t('eff.leg.limite')}</span>
              <span><i className="eff-leg-barre" /> {t('eff.leg.copie')}</span>
            </span>
          </div>
          <Elenco voci={(soloDaGuardare ? sem.tutti.filter((r) => r.stato === 'tappo' || r.stato === 'spreco') : sem.tutti).map(rigaStato)} quante={10} t={t} vuoto={t('eff.sem.niente')} />
        </>
      )}

      {stato.lente === 'squadra' && (
        <div className="eff-due">
          <div>
            <h3>{t('eff.chi.costa')}</h3>
            <Elenco voci={f.squadre.map((x) => riga(`q:${x.k}`, nomeSquadra(x.k), x.usd, x.k === SENZA_SQUADRA ? 'var(--warn)' : 'var(--chart-1)', f.squadre[0]?.usd ?? 0))} quante={6} t={t} vuoto="" />
          </div>
          <div>
            <h3>{t('eff.chi.ambiente')}</h3>
            <Elenco voci={f.ambienti.map((x) => riga(`a:${x.k}`, data?.accounts?.[x.k]?.label ?? x.k, x.usd, data?.accounts?.[x.k]?.nonProd ? 'var(--chart-4)' : 'var(--chart-1)', f.ambienti[0]?.usd ?? 0))} quante={6} t={t} vuoto="" />
          </div>
        </div>
      )}
    </div>
  )
}
