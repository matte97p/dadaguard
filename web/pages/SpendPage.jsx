import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Verdetto, Tabs } from '../ui/index.js'
import CostsPage from './CostsPage.jsx'
import WastePage, { contaSprechi } from './WastePage.jsx'
import BudgetsPanel, { budgetDaGuardare } from '../components/BudgetsPanel.jsx'
import { soldi, leggi, meseCorrente, LIVELLO_BUDGET } from './spesaKit.js'
import { peggiore } from '../adattatori.js'
import './spesa.css'

// "Spesa" = Costi + Sprechi + Budget, in schede.
//
// Perché fondere: rispondono alla stessa domanda ("quanto ci costa questa infrastruttura") con misure
// diverse: Costi è la spesa VERA di Cost Explorer, Sprechi è la stima a listino di risorse che nessuno
// usa, i Budget dicono se siamo dentro a quello che avevamo deciso. Come voci di menu separate
// sembravano argomenti diversi, e chi cercava «quanto buttiamo» apriva Costi.
//
// Ogni scheda è una domanda sola:
//   Riepilogo          → quanto stiamo spendendo questo mese, giorno per giorno, e dove va
//   Andamento          → sta crescendo (13 mesi, indipendenti dal mese scelto)
//   Ripartizioni       → di CHI è la spesa (per servizio, per livello, per componente)
//   Sprechi            → cosa paghiamo senza usarlo
//   Budget e anomalie  → siamo dentro al deciso, e AWS ha visto qualcosa di strano
// E si paga solo quello che si guarda: ogni scheda chiede i suoi dati, e Cost Explorer si paga a
// richiesta. Le uniche letture fatte qui, per tutte, sono quelle che danno il verdetto e i numeri
// sulle schede: il mese corrente, i budget e gli sprechi.
const SCHEDE = [
  { key: 'riepilogo', section: 'summary', superficie: 'costs' },
  { key: 'andamento', section: 'trend', superficie: 'costs' },
  { key: 'ripartizioni', section: 'breakdown', superficie: 'costs' },
  { key: 'sprechi', superficie: 'waste' },
  { key: 'budget', superficie: 'costs' },
]

export default function SpendPage({ accountLabels, tabs = ['costs', 'waste'], t = (k) => k, lang }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const visibili = SCHEDE.filter((s) => tabs.includes(s.superficie))
  const voluta = params.get('tab') ?? visibili[0]?.key
  const attiva = visibili.some((s) => s.key === voluta) ? voluta : visibili[0]?.key
  const conCosti = tabs.includes('costs')
  const conSprechi = tabs.includes('waste')

  const [mese, setMese] = useState(null)
  const [budgets, setBudgets] = useState(null)
  const [sprechi, setSprechi] = useState(null)

  // Le tre letture del verdetto, indipendenti: una che non risponde lascia le altre al loro posto.
  // Restano montate cambiando scheda, cosi' le schede Budget e Sprechi non le rifanno.
  useEffect(() => {
    let vivo = true
    if (conCosti) {
      leggi(`/api/costs?month=${meseCorrente()}&type=all&lang=${lang}`).then((r) => vivo && setMese(r))
      leggi(`/api/budgets?lang=${lang ?? ''}`).then((r) => vivo && setBudgets(r))
    }
    if (conSprechi) leggi(`/api/waste?lang=${lang}`).then((r) => vivo && setSprechi(r))
    return () => {
      vivo = false
    }
  }, [lang, conCosti, conSprechi])

  const visibile = (acc) => !accountLabels || accountLabels.has(acc?.label)
  const conti = Object.values(mese?.dati ?? {}).filter((a) => !a.error && visibile(a))
  const somma = (f) => conti.reduce((s, a) => s + (f(a) || 0), 0)
  const netto = somma((a) => (a.total != null ? a.total : a.gross))
  const previsione = somma((a) => (a.projection ? a.projection.gross : a.gross))

  const daGuardare = budgetDaGuardare(budgets?.dati, accountLabels)
  const livelloBudget = peggiore(daGuardare.budget.map((b) => LIVELLO_BUDGET[b.level] ?? 'ok'))
  const nSprechi = sprechi?.dati && !sprechi.dati.error ? contaSprechi(sprechi.dati, accountLabels) : null

  const voci = visibili.map((s) => ({
    key: s.key,
    label: t(`spend.tab.${s.key}`),
    n:
      s.key === 'sprechi' && nSprechi
        ? nSprechi
        : s.key === 'budget' && daGuardare.budget.length + daGuardare.anomalie.length
          ? daGuardare.budget.length + daGuardare.anomalie.length
          : undefined,
  }))

  // Il verdetto: quanto abbiamo speso finora, colorato dal budget peggiore (il numero da solo non dice
  // se e' tanto: lo dice il confronto con quello che avevamo deciso).
  const verdetto = !conCosti ? (
    <Verdetto resto={t('spend.title')} dettaglio={t('spend.v.soloSprechi')} />
  ) : conti.length ? (
    <Verdetto
      livello={livelloBudget === 'crit' || livelloBudget === 'warn' ? livelloBudget : undefined}
      forte={soldi(netto, lang)}
      resto={` ${t('spend.v.finora')}`}
      dettaglio={
        daGuardare.budget.length
          ? t('spend.v.dettaglioBudget', { prev: soldi(previsione, lang), n: daGuardare.budget.length })
          : t('spend.v.dettaglio', { prev: soldi(previsione, lang) })
      }
    />
  ) : (
    <Verdetto resto={t('spend.title')} dettaglio={mese?.errore ?? (mese ? t('costs.noAccounts') : t('spend.v.carico'))} />
  )

  return (
    <div className="sp-col">
      {verdetto}
      <Tabs
        voci={voci}
        attiva={attiva}
        // La scheda sta nell'URL: un link a «Sprechi» deve continuare a portare sugli sprechi, e il
        // tasto indietro deve tornare alla scheda da cui vieni. La prima non mette il parametro, cosi'
        // `/spesa` resta l'indirizzo pulito della vista che si apre per prima.
        onCambia={(k) => navigate(k === visibili[0]?.key ? '/spesa' : `/spesa?tab=${k}`)}
      />
      {SCHEDE.find((s) => s.key === attiva)?.section && (
        <CostsPage
          key={attiva}
          accountLabels={accountLabels}
          t={t}
          lang={lang}
          section={SCHEDE.find((s) => s.key === attiva).section}
          budgets={budgets}
        />
      )}
      {attiva === 'sprechi' && <WastePage accountLabels={accountLabels} t={t} lang={lang} risposta={sprechi} />}
      {attiva === 'budget' && <BudgetsPanel accountLabels={accountLabels} t={t} lang={lang} risposta={budgets} />}
    </div>
  )
}
