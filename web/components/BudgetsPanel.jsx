import { useState } from 'react'
import { Lista, Sezione, Pill, Meter, Drawer, Rimedio, ListaLink } from '../ui/index.js'
import { soldi, LIVELLO_BUDGET } from '../pages/spesaKit.js'

// "2026-08-06" → "06/08". Nel formato di chi legge, e senza l'anno: in una finestra di 30 giorni
// l'anno è la stessa cifra su ogni riga. Puro.
const shortDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''))
  return m ? `${m[3]}/${m[2]}` : ''
}

// Importo nell'unità del budget: quasi sempre dollari, ma un budget d'uso (ore, GB) ha la sua.
const importo = (v, unit, lang) => (v == null ? '-' : unit && unit !== 'USD' ? `${Math.round(v).toLocaleString()} ${unit}` : soldi(v, lang))

// Le pagine della console da cui si decide: i budget, le anomalie. Sono link generici, senza account:
// la console apre quello in cui sei entrato, e la nota lo dice.
const LINK_BUDGET = 'https://console.aws.amazon.com/costmanagement/home#/budgets'
const LINK_ANOMALIE = 'https://console.aws.amazon.com/costmanagement/home#/anomaly-detection/overview'
const LINK_EXPLORER = 'https://console.aws.amazon.com/costmanagement/home#/cost-explorer'

// Cosa c'è da guardare nella risposta di /api/budgets: i budget non verdi (dal peggiore) e le anomalie
// non già marcate come attese. Serve anche a SpendPage per il verdetto e il numero sulla scheda, quindi
// è una funzione e non un pezzo di render. Pura.
export function budgetDaGuardare(dati, accountLabels) {
  const visibile = (a) => !accountLabels || accountLabels.has(a.label)
  const rango = { over: 0, willOver: 1, warn: 2, ok: 3 }
  const budget = Object.values(dati?.accounts ?? {})
    .filter(visibile)
    .flatMap((a) => (a.budgets ?? []).map((b) => ({ ...b, account: a.label })))
    .filter((b) => b.level && b.level !== 'ok')
    .sort((x, y) => (rango[x.level] ?? 9) - (rango[y.level] ?? 9))
  const anomalie = (dati?.anomalies ?? []).filter((a) => a.feedback !== 'YES')
  return { budget, anomalie }
}

const GRIGLIA = 'minmax(0,1fr) minmax(0,2fr) 120px'
// La prima colonna tiene la pillola, che non va a capo: deve contenere la più lunga delle due,
// «già marcata come attesa» (156px) e «already marked as expected» (176px). Con i 110px di prima
// la seconda usciva dalla colonna e finiva sopra al nome del servizio. Una colonna `auto` non va:
// ogni riga è una griglia a sé, e i testi non starebbero più in colonna fra una riga e l'altra.
const GRIGLIA_ANOMALIE = '188px minmax(0,1fr) 140px 90px'
// Sul telefono: nome e stato sulla prima riga, il consumo sotto a tutta larghezza; per le anomalie
// pillola, importo e data in testa, e il servizio sotto.
const GRIGLIA_M = 'minmax(0,1fr) auto'
const GRIGLIA_ANOMALIE_M = 'auto minmax(0,1fr) auto'

// Scheda «Budget e anomalie»: quanto della spesa DECISA è già andata, e gli scostamenti che AWS ha
// rilevato. Prima stava in cima al Riepilogo come griglia di card; qui è una lista sola, dal più
// grave, perché la domanda è una («siamo dentro?») e la risposta si legge dall'alto.
//
// I dati arrivano da SpendPage (`risposta`), che li legge comunque per il verdetto: rileggerli qui
// sarebbe una seconda chiamata per lo stesso numero.
export default function BudgetsPanel({ accountLabels, t = (k) => k, lang, risposta }) {
  const [aperto, setAperto] = useState(null)
  if (!risposta) return <p className="ui-mute">{t('spend.carico')}</p>
  if (risposta.errore) return <Rimedio livello="warn" titolo={t('spend.budget.errore')} testo={risposta.errore} t={t} />
  const dati = risposta.dati ?? {}

  const visibile = (a) => !accountLabels || accountLabels.has(a.label)
  const conti = Object.values(dati.accounts ?? {}).filter(visibile)
  const rango = { over: 0, willOver: 1, warn: 2, ok: 3 }
  const righe = conti
    .flatMap((a) => (a.budgets ?? []).map((b) => ({ ...b, account: a.label })))
    .sort((x, y) => (rango[x.level] ?? 9) - (rango[y.level] ?? 9) || (y.actualPct ?? 0) - (x.actualPct ?? 0))
  const errori = conti.filter((a) => a.error)
  const anomalie = dati.anomalies ?? []

  const b = aperto?.tipo === 'budget' ? aperto.b : null
  const an = aperto?.tipo === 'anomalia' ? aperto.a : null

  return (
    <>
      {dati.error && <Rimedio livello="warn" titolo={t('spend.budget.errore')} testo={dati.error} t={t} />}
      <Sezione titolo={t('spend.budget.titolo')} sotto={t('spend.budget.sotto')}>
        <Lista colonne={[t('spend.col.budget'), t('spend.col.consumo'), t('spend.col.stato')]} griglia={GRIGLIA} grigliaMobile={GRIGLIA_M} vuoto={t('spend.budget.vuoto')}>
          {righe.map((r) => {
            const livello = LIVELLO_BUDGET[r.level] ?? 'ok'
            // L'unità di tempo si mostra solo se NON è mensile: una parola identica su ogni riga non
            // informa, occupa il posto di quelle che distinguono.
            const periodo = r.timeUnit && r.timeUnit !== 'MONTHLY' ? ` · ${t(`budget.timeUnit.${r.timeUnit}`)}` : ''
            return (
              <button
                key={`${r.account}/${r.name}`}
                type="button"
                className="ui-row ui-row-btn"
                onClick={() => setAperto({ tipo: 'budget', b: r })}
              >
                <span className="ui-name">
                  {r.name}
                  <small>
                    {r.account}
                    {periodo}
                  </small>
                </span>
                <span className="ui-what">
                  <Meter valore={r.actualPct ?? 0} livello={livello} title={`${r.actualPct ?? 0}%`} />
                  <span className="ui-hint">
                    {t('spend.budget.consumo', {
                      speso: importo(r.actual, r.unit, lang),
                      limite: importo(r.limit, r.unit, lang),
                      pct: r.actualPct ?? 0,
                    })}
                    {r.forecastPct != null ? ` · ${t('spend.budget.previsione', { pct: r.forecastPct })}` : ''}
                  </span>
                </span>
                <Pill livello={livello}>{t(`budget.level.${r.level}`)}</Pill>
              </button>
            )
          })}
        </Lista>
        {errori.map((a) => (
          <p key={a.label} className="ui-note">
            {a.label}: {a.error}
          </p>
        ))}
      </Sezione>

      <Sezione titolo={t('budget.anomalies')} sotto={t('spend.anom.sotto')}>
        {dati.anomaliesError ? (
          <Rimedio livello="warn" titolo={t('spend.anom.errore')} testo={dati.anomaliesError} t={t} />
        ) : (
          <Lista griglia={GRIGLIA_ANOMALIE} grigliaMobile={GRIGLIA_ANOMALIE_M} vuoto={t('spend.anom.vuoto')}>
            {anomalie.map((a) => (
              <button
                key={a.id}
                type="button"
                className="ui-row ui-row-btn"
                onClick={() => setAperto({ tipo: 'anomalia', a })}
              >
                <Pill livello={a.feedback === 'YES' ? 'off' : 'warn'}>{a.feedback === 'YES' ? t('budget.expected') : t('spend.anom.pill')}</Pill>
                <span className="ui-what">
                  {[a.service ?? '-', a.account].filter(Boolean).join(' · ')}
                  <span className="ui-hint">
                    {a.impactPct != null ? t('budget.vsExpected', { pct: a.impactPct }) : t('spend.anom.senzaPct')}
                  </span>
                </span>
                <b className="sp-num ui-t-warn">+{soldi(a.impact, lang)}</b>
                <span className="ui-when">{t('spend.anom.dal', { d: shortDate(a.start) })}</span>
              </button>
            ))}
          </Lista>
        )}
      </Sezione>

      <Drawer
        aperto={Boolean(b)}
        onChiudi={() => setAperto(null)}
        titolo={b?.name}
        sotto={b?.account}
        etichettaChiudi={t('ui.chiudi')}
      >
        {b && (
          <>
            <div className="ui-stats">
              <div className="ui-stat">
                <b className={`ui-t-${LIVELLO_BUDGET[b.level] ?? 'ok'}`}>{b.actualPct ?? 0}%</b>
                <span>{t('spend.budget.consumato')}</span>
              </div>
              <div className="ui-stat">
                <b>{b.forecastPct != null ? `${b.forecastPct}%` : '-'}</b>
                <span>{t('spend.budget.previsto')}</span>
              </div>
              <div className="ui-stat">
                <b className="ui-mono">{importo(b.actual, b.unit, lang)}</b>
                <span>{t('spend.budget.speso')}</span>
              </div>
              <div className="ui-stat">
                <b className="ui-mono">{importo(b.limit, b.unit, lang)}</b>
                <span>{t('spend.budget.limite')}</span>
              </div>
            </div>
            {b.forecast != null && <p className="ui-mute">{t('budget.forecast', { amount: importo(b.forecast, b.unit, lang), pct: b.forecastPct })}</p>}
            {b.level !== 'ok' && (
              <Rimedio
                livello={LIVELLO_BUDGET[b.level]}
                titolo={t('spend.cosaFare')}
                testo={t(`spend.budget.fare.${b.level}`)}
                // Il comando legge, non cambia niente: chi decide di alzare il budget lo fa in console.
                comando={`aws budgets describe-budget --account-id "$(aws sts get-caller-identity --query Account --output text)" --budget-name "${b.name}"`}
                t={t}
              />
            )}
            <ListaLink
              link={[
                { label: t('spend.link.budget'), href: LINK_BUDGET, nota: t('spend.link.nota', { conto: b.account }) },
                { label: t('spend.link.explorer'), href: LINK_EXPLORER },
              ]}
            />
          </>
        )}
      </Drawer>

      <Drawer
        aperto={Boolean(an)}
        onChiudi={() => setAperto(null)}
        titolo={an?.service ?? '-'}
        sotto={[an?.account, an?.region].filter(Boolean).join(' · ')}
        etichettaChiudi={t('ui.chiudi')}
      >
        {an && (
          <>
            <div className="ui-stats">
              <div className="ui-stat">
                <b className="ui-t-warn">+{soldi(an.impact, lang)}</b>
                <span>{t('spend.anom.impatto')}</span>
              </div>
              <div className="ui-stat">
                <b>{an.impactPct != null ? `${an.impactPct}%` : '-'}</b>
                <span>{t('spend.anom.sopra')}</span>
              </div>
              <div className="ui-stat">
                <b className="ui-mono">{an.expected != null ? soldi(an.expected, lang) : '-'}</b>
                <span>{t('spend.anom.atteso')}</span>
              </div>
              <div className="ui-stat">
                <b className="ui-mono">{an.actual != null ? soldi(an.actual, lang) : '-'}</b>
                <span>{t('spend.anom.reale')}</span>
              </div>
            </div>
            {/* Il tipo d'uso è la stringa più tecnica, ma è quella che dice COSA è cresciuto (token in
                ingresso, ore di calcolo): nel pannello c'è posto. */}
            {an.usageType && <p className="ui-mono ui-mute">{an.usageType}</p>}
            <p className="ui-mute">{t('spend.anom.periodo', { da: shortDate(an.start), a: an.end ? shortDate(an.end) : t('spend.anom.inCorso') })}</p>
            <Rimedio
              livello="warn"
              titolo={t('spend.cosaFare')}
              testo={t('spend.anom.fare')}
              comando={`aws ce get-anomalies --date-interval StartDate=${String(an.start ?? '').slice(0, 10)} --query "Anomalies[?AnomalyId=='${an.id}']"`}
              t={t}
            />
            <ListaLink
              link={[
                { label: t('spend.link.anomalie'), href: LINK_ANOMALIE, nota: t('spend.link.nota', { conto: an.account ?? '-' }) },
                { label: t('spend.link.explorer'), href: LINK_EXPLORER },
              ]}
            />
          </>
        )}
      </Drawer>
    </>
  )
}
