import { Fragment, useEffect, useState } from 'react'
import { Card, Lista, Sezione, Meter, Rimedio } from '../ui/index.js'
import CostTrend from '../components/CostTrend.jsx'
import { mergeTrend } from '../format.js'
import { soldi, leggi, meseCorrente } from './spesaKit.js'

// Quante voci mostra «Dove va» prima di raccogliere il resto in «Altro»: cinque si leggono a colpo
// d'occhio, la sesta si scorre. La lista intera sta in Ripartizioni.
const VOCI_DOVE = 5

// Lista ordinabile con barra, usata da entrambe le ripartizioni (per livello e per componente).
//
// La barra è la resa grafica della colonna «spesa», non un dato in più: per questo la sua colonna non
// ha intestazione. L'ordinamento resta (per nome o per importo) perché «dal più grande» non è l'unica
// domanda: chi cerca un componente per nome lo trova in ordine alfabetico.
//
// `rows`: { key, label, amount, services?, muted? }. Una riga con `services` si apre sui servizi.
function ListaRipartizione({ rows, headLabel, t, empty, lang }) {
  const [by, setBy] = useState('amount')
  const [dir, setDir] = useState('desc')
  const [open, setOpen] = useState(() => new Set())
  const griglia = 'minmax(0,1.2fr) minmax(0,1fr) 100px 64px'

  const max = Math.max(1, ...rows.map((r) => Math.abs(r.amount)))
  const total = rows.reduce((s, r) => s + Math.abs(r.amount), 0) || 1
  const sorted = [...rows].sort((a, b) => {
    const d = by === 'label' ? String(a.label).localeCompare(String(b.label)) : Math.abs(a.amount) - Math.abs(b.amount)
    return dir === 'asc' ? d : -d
  })
  const sortOn = (key) => () => {
    if (by === key) setDir(dir === 'asc' ? 'desc' : 'asc')
    else {
      setBy(key)
      setDir(key === 'label' ? 'asc' : 'desc')
    }
  }
  const freccia = (col) => (by === col ? (dir === 'asc' ? ' ▲' : ' ▼') : '')
  const toggle = (key) =>
    setOpen((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  return (
    <Lista
      colonne={[
        <button key="l" type="button" className="sp-sort" onClick={sortOn('label')} aria-sort={by === 'label' ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
          {headLabel}
          {freccia('label')}
        </button>,
        '',
        <button key="a" type="button" className="sp-sort sp-num" onClick={sortOn('amount')} aria-sort={by === 'amount' ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
          {t('costs.th.spend')}
          {freccia('amount')}
        </button>,
        <span key="s" className="sp-num">
          {t('costs.th.share')}
        </span>,
      ]}
      griglia={griglia}
      vuoto={empty}
    >
      {sorted.map((r) => {
        const apribile = (r.services?.length ?? 0) > 0
        const aperta = open.has(r.key)
        const Riga = apribile ? 'button' : 'div'
        return (
          <Fragment key={r.key}>
            <Riga
              type={apribile ? 'button' : undefined}
              className={`ui-row ${apribile ? 'ui-row-btn' : ''}`}
              style={{ gridTemplateColumns: griglia }}
              onClick={apribile ? () => toggle(r.key) : undefined}
              aria-expanded={apribile ? aperta : undefined}
            >
              <span className={`ui-name ${r.muted ? 'ui-mute' : ''}`}>
                {apribile ? (aperta ? '▾ ' : '▸ ') : ''}
                {r.label}
              </span>
              <Meter valore={(Math.abs(r.amount) / max) * 100} />
              <span className="sp-num">{soldi(r.amount, lang)}</span>
              <span className="sp-num ui-mute">{`${((Math.abs(r.amount) / total) * 100).toFixed(1)}%`}</span>
            </Riga>
            {/* Il dettaglio usa le stesse colonne: gli importi dei servizi cadono sotto quello della
                riga padre, senza allineamenti a mano. */}
            {apribile &&
              aperta &&
              r.services.map((sv) => (
                <div key={sv.service} className="ui-row sp-figlio" style={{ gridTemplateColumns: griglia }}>
                  <span className="ui-name">{sv.service}</span>
                  <span />
                  <span className="sp-num">{soldi(sv.amount, lang)}</span>
                  <span />
                </div>
              ))}
          </Fragment>
        )
      })}
    </Lista>
  )
}

// Spesa giornaliera degli account visibili, sommata per giorno: le ultime 30 barre. Il server la
// manda per account; qui conta il conto intero. Pura.
export function giorniSommati(dati, accountLabels, n = 30) {
  const perGiorno = new Map()
  for (const acc of Object.values(dati ?? {})) {
    if (!acc || acc.error || (accountLabels && !accountLabels.has(acc.label))) continue
    for (const g of acc.giorni ?? []) {
      if (!g?.giorno) continue
      perGiorno.set(g.giorno, (perGiorno.get(g.giorno) ?? 0) + (Number(g.importo) || 0))
    }
  }
  return [...perGiorno.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-n)
    .map(([giorno, importo]) => ({ giorno, importo }))
}

// '2026-09-05' → '5/9': sull'asse servono il giorno e il mese, l'anno è lo stesso su tutte le barre.
const giornoCorto = (g) => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(g ?? ''))
  return m ? `${Number(m[2])}/${Number(m[1])}` : ''
}

// Le tre viste della spesa vera (Cost Explorer), una per scheda:
// 'summary' (totali, giorni, dove va) · 'trend' (13 mesi) · 'breakdown' (per servizio, livello, componente).
// Cost Explorer è a pagamento: ogni vista chiede SOLO i suoi dati, e al cambio di mese o livello.
export default function CostsPage({ accountLabels, t = (k) => k, lang, section = 'summary' }) {
  const [month, setMonth] = useState(() => meseCorrente())
  const [type, setType] = useState('all') // filtro Livello (Cost Category)
  const [data, setData] = useState(null)
  const [giorni, setGiorni] = useState(null)
  const [trend, setTrend] = useState(null)
  const [comps, setComps] = useState(null)
  const [cats, setCats] = useState(null)
  const [trendMetric, setTrendMetric] = useState('usage') // 'usage' = tutto · 'infra' = senza AI
  // Quale LENTE della ripartizione si guarda: la domanda è una («dove vanno i soldi»), la lente cambia.
  const [lens, setLens] = useState('service') // service | level | component

  // Le chiamate rispondono SEMPRE ({ dati } o { errore }), quindi `null` vuol dire solo «sta
  // arrivando»: senza questa distinzione «non c'è niente» e «aspetta» si leggono uguali.
  useEffect(() => {
    if (section !== 'summary' && !(section === 'breakdown' && lens === 'service')) return undefined
    let vivo = true
    leggi(`/api/costs?month=${month}&type=${type}&lang=${lang}`).then((r) => vivo && setData(r))
    return () => {
      vivo = false
    }
  }, [section, month, type, lang, lens])

  // La spesa giornaliera è un extra del riepilogo: se il server non la manda ancora, il resto resta.
  useEffect(() => {
    if (section !== 'summary') return undefined
    let vivo = true
    leggi(`/api/meta/spesa-giornaliera`).then((r) => vivo && setGiorni(r))
    return () => {
      vivo = false
    }
  }, [section])

  // Il trend NON dipende dal mese scelto (sono gli ultimi 13 mesi): cambiare mese non rifà una
  // chiamata a pagamento.
  useEffect(() => {
    if (section !== 'trend') return undefined
    let vivo = true
    setTrend(null)
    leggi(`/api/costs/trend?type=${type}&lang=${lang}`).then((r) => vivo && setTrend(r))
    return () => {
      vivo = false
    }
  }, [section, type, lang])

  useEffect(() => {
    if (!(section === 'breakdown' && lens === 'component')) return undefined
    let vivo = true
    leggi(`/api/costs/components?month=${month}&type=${type}&lang=${lang}`).then((r) => vivo && setComps(r))
    return () => {
      vivo = false
    }
  }, [section, month, type, lang, lens])

  // I livelli NON si filtrano per livello: questa è la vista che li mostra, e dà anche i valori al
  // menu, così sapere quali livelli esistono non costa una chiamata in più. Per questo si fa su ogni
  // scheda: il menu Livello c'è anche dove la ripartizione non si vede.
  useEffect(() => {
    let vivo = true
    leggi(`/api/costs/categories?month=${month}&lang=${lang}`).then((r) => vivo && setCats(r))
    return () => {
      vivo = false
    }
  }, [month, lang])

  const visibile = (acc) => !accountLabels || accountLabels.has(acc?.label)
  const accounts = Object.entries(data?.dati ?? {}).filter(([, acc]) => visibile(acc))

  // Opzioni del filtro: i livelli che ESISTONO in questo mese, sommati su tutti gli account. Un
  // elenco scritto a mano andrebbe stantio al primo livello nuovo.
  const typeOptions = (() => {
    const seen = new Map()
    for (const acc of Object.values(cats?.dati ?? {})) {
      if (acc.error) continue
      for (const c of acc.categories ?? []) {
        if (!c.category) continue // il non-categorizzato non è un filtro: si guarda dalla ripartizione
        seen.set(c.category, (seen.get(c.category) ?? 0) + c.amount)
      }
    }
    return [
      { value: 'all', label: t('costs.type.all') },
      ...[...seen.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => ({ value, label: value })),
    ]
  })()

  const now = new Date()
  const monthOptions = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = meseCorrente(d)
    const label = d.toLocaleDateString(lang === 'en' ? 'en-US' : 'it-IT', { month: 'long', year: 'numeric' })
    return { value, label: i === 0 ? `${label} · ${t('costs.current')}` : label }
  })

  const filtri = (
    <div className="sp-filtri">
      <span>{t(`costs.desc.${section}`)}</span>
      <label>
        {t('costs.type')}
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {typeOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {/* Il Mese non compare su Andamento: quel grafico sono SEMPRE gli ultimi 13 mesi, e un filtro
          inerte insegna a diffidare anche di quelli che funzionano. */}
      {section !== 'trend' && (
        <label>
          {t('costs.month')}
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {monthOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )

  // Due vuoti diversi: nessun account leggibile, oppure un filtro che li nasconde tutti. Dirli allo
  // stesso modo manda a cercare un problema di configurazione che non esiste.
  const statoCosti = !data ? (
    <p className="ui-mute">{t('spend.carico')}</p>
  ) : data.errore ? (
    <Rimedio livello="warn" titolo={t('spend.costi.errore')} testo={data.errore} t={t} />
  ) : accounts.length === 0 ? (
    <p className="ui-vuoto">{Object.keys(data.dati ?? {}).length > 0 ? t('costs.allFiltered') : t('costs.noAccounts')}</p>
  ) : null

  return (
    <>
      {filtri}
      {section === 'summary' && (statoCosti ?? <Riepilogo accounts={accounts} giorni={giorni} accountLabels={accountLabels} t={t} lang={lang} />)}
      {section === 'trend' && <Andamento trend={trend} visibile={visibile} metric={trendMetric} setMetric={setTrendMetric} t={t} lang={lang} />}
      {section === 'breakdown' && (
        <>
          <div className="ui-seg" style={{ alignSelf: 'flex-start' }} role="group">
            {[
              ['service', t('costs.svc.title')],
              ['level', t('costs.cat.title')],
              ['component', t('costs.comp.title')],
            ].map(([k, label]) => (
              <button key={k} type="button" aria-pressed={lens === k} onClick={() => setLens(k)}>
                {label}
              </button>
            ))}
          </div>
          <p className="ui-mute" style={{ margin: 0 }}>
            {lens === 'service' ? t('costs.svc.desc') : lens === 'level' ? t('costs.cat.lensDesc') : t('costs.comp.lensDesc')}
          </p>
          {lens === 'service' && (statoCosti ?? <PerServizio accounts={accounts} t={t} lang={lang} />)}
          {lens === 'level' && <PerLivello cats={cats} visibile={visibile} type={type} t={t} lang={lang} />}
          {lens === 'component' && <PerComponente comps={comps} visibile={visibile} t={t} lang={lang} />}
        </>
      )}
    </>
  )
}

// Riepilogo: i totali del mese con la loro composizione, i giorni, e dove vanno i soldi.
function Riepilogo({ accounts, giorni, accountLabels, t, lang }) {
  const conti = accounts.map(([, a]) => a).filter((a) => !a.error)
  const sum = (f) => conti.reduce((s, a) => s + (f(a) || 0), 0)
  const gross = sum((a) => a.gross)
  const credits = sum((a) => a.credits)
  const net = sum((a) => (a.total != null ? a.total : a.gross))
  const proj = sum((a) => (a.projection ? a.projection.gross : a.gross))
  const tax = sum((a) => a.tax)
  const ai = sum((a) => a.aiGross)
  const hasCred = Math.abs(credits) > 0.005
  const hasTax = Math.abs(tax) > 0.005
  const hasAi = Math.abs(ai) > 0.005

  // «Dove va»: i servizi di tutti gli account sommati per nome, i primi cinque e il resto insieme.
  const perServizio = new Map()
  for (const a of conti) for (const it of a.items ?? []) perServizio.set(it.service, (perServizio.get(it.service) ?? 0) + it.amount)
  const ordinati = [...perServizio.entries()].sort((x, y) => y[1] - x[1])
  const dove = ordinati.slice(0, VOCI_DOVE)
  const altro = ordinati.slice(VOCI_DOVE).reduce((s, [, v]) => s + v, 0)
  if (altro > 0.005) dove.push([t('spend.dove.altro'), altro])
  const totDove = dove.reduce((s, [, v]) => s + Math.max(0, v), 0) || 1

  const serie = giorni?.dati ? giorniSommati(giorni.dati, accountLabels) : []
  const maxG = Math.max(1, ...serie.map((g) => g.importo))
  const media = serie.length ? serie.reduce((s, g) => s + g.importo, 0) / serie.length : null

  return (
    <>
      <div className="ui-hero">
        <Card titolo={t('spend.giorni.titolo')} nota={media != null ? t('spend.giorni.media', { v: soldi(media, lang) }) : null}>
          {!giorni ? (
            <span className="ui-mute">{t('spend.carico')}</span>
          ) : serie.length < 2 ? (
            // Il server la manda da poco: se manca, si dice cosa manca invece di disegnare un vuoto.
            <span className="ui-mute">{t('spend.giorni.assente')}</span>
          ) : (
            <>
              <div className="sp-bars" role="img" aria-label={t('spend.giorni.titolo')}>
                {serie.map((g, i) => (
                  <i
                    key={g.giorno}
                    className={i === serie.length - 1 ? 'sp-oggi' : undefined}
                    style={{ height: `${(g.importo / maxG) * 100}%` }}
                    title={`${giornoCorto(g.giorno)} · ${soldi(g.importo, lang)}`}
                  />
                ))}
              </div>
              <div className="ui-axis">
                <span>{giornoCorto(serie[0].giorno)}</span>
                <span>{giornoCorto(serie[Math.floor(serie.length / 2)].giorno)}</span>
                <span>{t('spend.giorni.oggi')}</span>
              </div>
            </>
          )}
        </Card>
        <Card titolo={t('spend.dove.titolo')}>
          {dove.length === 0 ? (
            <span className="ui-mute">{t('costs.none')}</span>
          ) : (
            dove.map(([nome, v]) => (
              <div key={nome} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) 84px', gap: 10, alignItems: 'center' }}>
                <span className="ui-name" style={{ fontWeight: 500 }}>
                  {nome}
                </span>
                <Meter valore={(Math.max(0, v) / totDove) * 100} />
                <b className="sp-num">{soldi(v, lang)}</b>
              </div>
            ))
          )}
        </Card>
      </div>

      {/* Il numero grande del verdetto è il netto; qui la riga che lo spiega con i segni scritti
          (lordo − crediti + tasse) e, a parte, l'AI: con i modelli che valgono buona parte del conto,
          un totale unico nasconde l'andamento dell'infrastruttura. */}
      <Card titolo={t('costs.h.thisMonth')} nota={hasCred || hasTax ? `${t('costs.h.gross')} ${soldi(gross, lang)}${hasCred ? ` − ${t('costs.h.credits')} ${soldi(Math.abs(credits), lang)}` : ''}${hasTax ? ` + ${t('costs.h.tax')} ${soldi(tax, lang)}` : ''}` : null}>
        <div className="ui-stats" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
          <div className="ui-stat">
            <b>{soldi(hasCred || hasTax ? net : gross, lang)}</b>
            <span>{hasCred || hasTax ? t('costs.h.net') : t('costs.h.gross')}</span>
          </div>
          {hasAi && (
            <div className="ui-stat">
              <b>{soldi(ai, lang)}</b>
              <span>{t('costs.h.ai')}</span>
            </div>
          )}
          {hasAi && (
            <div className="ui-stat">
              <b>{soldi(gross - ai, lang)}</b>
              <span>{t('costs.h.infra')}</span>
            </div>
          )}
          <div className="ui-stat">
            <b className="ui-mute">{soldi(proj, lang)}</b>
            <span>{t('costs.h.proj')}</span>
          </div>
        </div>
      </Card>

      {/* Un riquadro per account: quanto pesa ognuno, e i suoi errori senza spegnere gli altri. */}
      <div className="ui-envgrid">
        {accounts.map(([key, a]) => (
          <Card key={key} titolo={a.label} nota={a.error ? null : soldi(a.gross, lang)}>
            {a.error ? (
              <span className="ui-t-warn">{a.error}</span>
            ) : (
              <span className="ui-mute">
                {a.projection ? t('spend.conto.previsione', { v: soldi(a.projection.gross, lang) }) : t('costs.gross')}
                {Math.abs(a.credits ?? 0) > 0.005 ? ` · ${t('costs.credits', { v: soldi(a.credits, lang) })}` : ''}
              </span>
            )}
          </Card>
        ))}
      </div>
    </>
  )
}

function Andamento({ trend, visibile, metric, setMetric, t, lang }) {
  if (!trend) return <p className="ui-mute">{t('spend.carico')}</p>
  // Il trend è un extra: se manca lo si dice, la pagina resta utile.
  if (trend.errore) return <Rimedio livello="warn" titolo={t('spend.costi.errore')} testo={trend.errore} t={t} />
  const rows = mergeTrend(Object.values(trend.dati ?? {}).filter((a) => !a.error && visibile(a)))
  if (rows.length < 2) return <p className="ui-vuoto">{t('spend.trend.pochi')}</p>
  return (
    <Card
      titolo={t('costs.trend.title')}
      nota={
        <span className="ui-seg" role="group" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {[
            ['usage', t('costs.trend.all')],
            ['infra', t('costs.trend.noAi')],
          ].map(([k, label]) => (
            <button key={k} type="button" aria-pressed={metric === k} onClick={() => setMetric(k)}>
              {label}
            </button>
          ))}
        </span>
      }
    >
      <span className="ui-mute">{t('costs.trend.desc')}</span>
      <CostTrend months={rows} metric={metric} t={t} lang={lang} />
    </Card>
  )
}

// Lente PER SERVIZIO: un riquadro per account, con la proiezione di fine mese accanto a ogni voce.
function PerServizio({ accounts, t, lang }) {
  return (
    <div className="sp-col">
      {accounts.map(([key, acc]) => {
        if (acc.error) return <Rimedio key={key} livello="warn" titolo={acc.label} testo={acc.error} t={t} />
        const items = [...(acc.items ?? [])].sort((a, b) => b.amount - a.amount)
        const hasCredits = Math.abs(acc.credits ?? 0) > 0.005
        // Stesso run-rate della proiezione aggregata, applicato per servizio (solo mese corrente).
        const factor = acc.projection ? acc.projection.daysInMonth / acc.projection.daysElapsed : null
        const max = Math.max(1, ...items.map((i) => Math.abs(i.amount)), Math.abs(acc.credits ?? 0))
        const griglia = 'minmax(0,1.3fr) minmax(0,1fr) 100px 110px'
        return (
          <Sezione
            key={key}
            titolo={acc.label}
            sotto={
              acc.projection
                ? `${soldi(acc.gross, lang)} ${t('costs.gross')} · ${t('costs.projectionBasis', { d: acc.projection.daysElapsed, tot: acc.projection.daysInMonth, pct: acc.projection.pct })}`
                : `${soldi(acc.gross, lang)} ${t('costs.gross')}`
            }
          >
            <Lista
              colonne={[t('costs.th.service'), '', <span key="s" className="sp-num">{t('costs.th.spend')}</span>, <span key="p" className="sp-num">{t('costs.projection')}</span>]}
              griglia={griglia}
              vuoto={t('costs.none')}
            >
              {items.map((it) => (
                <div key={it.service} className="ui-row" style={{ gridTemplateColumns: griglia }}>
                  <span className="ui-name">
                    {it.service}
                    {/* L'AI segnata riga per riga: è quello che rende il totale AI verificabile. */}
                    {it.ai && <small>{t('costs.aiMark')}</small>}
                  </span>
                  <Meter valore={(Math.abs(it.amount) / max) * 100} />
                  <span className="sp-num">{soldi(it.amount, lang)}</span>
                  <span className="sp-num ui-mute">{factor ? soldi(it.amount * factor, lang) : '-'}</span>
                </div>
              ))}
              {/* I crediti si scalano SEMPRE a parte: il lordo è quello che pagherai a crediti
                  esauriti, i crediti una riga di detrazione esplicita, il netto il residuo. */}
              {hasCredits && (
                <div className="ui-row" style={{ gridTemplateColumns: griglia }}>
                  <span className="ui-name ui-t-ok">
                    {t('costs.creditsRefunds')}
                    <small>{t('costs.netAfter', { v: soldi(acc.total, lang) })}</small>
                  </span>
                  <Meter valore={(Math.abs(acc.credits) / max) * 100} livello="ok" />
                  <span className="sp-num ui-t-ok">{soldi(acc.credits, lang)}</span>
                  <span />
                </div>
              )}
            </Lista>
          </Sezione>
        )
      })}
    </div>
  )
}

// Lente PER LIVELLO (Cost Category). Scelto un livello dal menu, la lente si APRE su di lui e le righe
// diventano i suoi servizi: `/api/costs/categories` raggruppa già per [livello, servizio], quindi il
// drill-down non costa una chiamata in più. La chiamata resta NON filtrata: è lei a dare i valori al
// menu, e filtrarla lo svuoterebbe.
function PerLivello({ cats, visibile, type, t, lang }) {
  if (!cats) return <p className="ui-mute">{t('spend.carico')}</p>
  if (cats.errore) return <Rimedio livello="warn" titolo={t('spend.costi.errore')} testo={cats.errore} t={t} />
  const list = Object.entries(cats.dati ?? {}).filter(([, a]) => !a.error && visibile(a))
  if (list.length === 0) return <p className="ui-vuoto">{t('costs.comp.none')}</p>
  const drill = type !== 'all'
  return (
    <div className="sp-col">
      {list.map(([key, acc]) => {
        const cs = acc.categories ?? []
        const rows = drill
          ? (cs.find((c) => c.category === type)?.services ?? []).map((sv) => ({ key: sv.service, label: sv.service, amount: sv.amount }))
          : cs.map((c) => ({
              key: c.category ?? '__none__',
              label: c.category ?? t('costs.cat.none'),
              amount: c.amount,
              services: c.services,
              muted: !c.category,
            }))
        return (
          <Sezione key={key} titolo={acc.label} sotto={drill ? t('costs.cat.inside', { level: type }) : null}>
            <ListaRipartizione
              rows={rows}
              headLabel={drill ? t('costs.th.service') : t('costs.th.level')}
              t={t}
              lang={lang}
              empty={drill ? t('costs.cat.emptyLevel', { level: type }) : t('costs.comp.none')}
            />
          </Sezione>
        )
      })}
    </div>
  )
}

// Lente PER COMPONENTE: il servizio AWS dice cosa costa, il tag dice di chi è, ed è il secondo a far
// decidere. Il non-taggato resta in lista: nasconderlo farebbe sembrare l'attribuzione completa.
function PerComponente({ comps, visibile, t, lang }) {
  if (!comps) return <p className="ui-mute">{t('spend.carico')}</p>
  if (comps.errore) return <Rimedio livello="warn" titolo={t('spend.costi.errore')} testo={comps.errore} t={t} />
  const list = Object.entries(comps.dati ?? {}).filter(([, a]) => !a.error && visibile(a))
  if (list.length === 0) return <p className="ui-vuoto">{t('costs.comp.none')}</p>
  return (
    <div className="sp-col">
      {list.map(([key, acc]) => {
        const rows = acc.components ?? []
        return (
          <Sezione key={key} titolo={acc.label}>
            {rows.length === 1 && rows[0].component === null ? (
              // Tutto in un'unica voce non taggata: quasi sempre il tag non è attivo come cost
              // allocation tag, o è scritto con un'altra maiuscola (Cost Explorer è case-sensitive e
              // non dà errore: dà "non taggato"). Meglio dire il sospetto che mostrare una riga sola.
              <Rimedio livello="info" titolo={t('spend.comp.sospetto')} testo={t('costs.comp.allUntagged', { tag: acc.tagKey ?? 'Component' })} t={t} />
            ) : (
              <ListaRipartizione
                rows={rows.map((c) => ({
                  key: c.component ?? '__untagged__',
                  label: c.component ?? t('costs.comp.untagged'),
                  amount: c.amount,
                  services: c.services,
                  muted: !c.component,
                }))}
                headLabel={t('costs.th.component')}
                t={t}
                lang={lang}
                empty={t('costs.comp.none')}
              />
            )}
          </Sezione>
        )
      })}
    </div>
  )
}
