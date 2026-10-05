import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Verdetto, Tabs } from '../ui/index.js'
import QuotasPage, { quoteVisibili } from './QuotasPage.jsx'
import FreeTierPage from './FreeTierPage.jsx'
import { leggi, livelloTetto } from './spesaKit.js'
import { peggiore } from '../adattatori.js'
import './spesa.css'

// "Limiti" = Quote di servizio + Free Tier.
//
// Perché fondere: sono due muri diversi con lo stesso significato operativo, «quanto manca prima
// che qualcosa smetta di funzionare o inizi a costare». Le quote AWS bloccano (non puoi creare la
// risorsa), il free tier no (paghi), ma la domanda che porta qui è la stessa, e come due voci di menu
// separate nessuna delle due si guardava mai.
//
// Le due letture stanno qui e non nelle schede: servono al verdetto e ai numeri sulle schede, e
// restano montate cambiando scheda, quindi nessuna si rifà.
export default function LimitsPage({ accountLabels, tabs = ['quotas', 'freetier'], t = (k) => k, lang }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const wanted = params.get('tab') === 'freetier' ? 'freetier' : 'quotas'
  const active = tabs.includes(wanted) ? wanted : tabs[0]
  const [quote, setQuote] = useState(null)
  const [free, setFree] = useState(null)

  useEffect(() => {
    let vivo = true
    if (tabs.includes('quotas')) leggi(`/api/quotas?lang=${lang}`).then((r) => vivo && setQuote(r))
    if (tabs.includes('freetier')) leggi(`/api/freetier?lang=${lang}`).then((r) => vivo && setFree(r))
    return () => {
      vivo = false
    }
  }, [lang, tabs.join(',')])

  // Una quota oltre il 90% blocca a breve, un'offerta gratuita oltre il 100% sta gia' costando: sono
  // i due rossi. Il verdetto conta quelli, poi gli arancio.
  const q = quoteVisibili(quote?.dati, accountLabels)
  const f = free?.dati?.items ?? []
  const livelliQ = q.map((x) => livelloTetto(x.pct, 90, 80))
  const livelliF = f.map((x) => livelloTetto(x.pct, 100, 85))
  const livello = peggiore([...livelliQ, ...livelliF])
  const rossi = [...livelliQ, ...livelliF].filter((l) => l === 'crit').length
  const arancio = [...livelliQ, ...livelliF].filter((l) => l === 'warn').length
  const pronti = (!tabs.includes('quotas') || quote) && (!tabs.includes('freetier') || free)

  const conta = (livelli) => livelli.filter((l) => l !== 'ok').length || undefined
  const voci = [
    { key: 'quotas', label: t('limits.tab.quotas'), n: conta(livelliQ) },
    { key: 'freetier', label: t('limits.tab.freetier'), n: conta(livelliF) },
  ].filter((v) => tabs.includes(v.key))

  return (
    <div className="sp-col">
      {!pronti ? (
        <Verdetto resto={t('limits.title')} dettaglio={t('spend.carico')} />
      ) : rossi ? (
        <Verdetto livello="crit" forte={t('lim.v.rossi', { n: rossi })} resto={` ${t('lim.v.alTetto')}`} dettaglio={t('lim.v.dettaglio')} />
      ) : arancio ? (
        <Verdetto livello="warn" forte={t('lim.v.vicini', { n: arancio })} resto={` ${t('lim.v.alTetto')}`} dettaglio={t('lim.v.dettaglio')} />
      ) : (
        <Verdetto livello={livello === 'ok' ? 'ok' : undefined} forte={t('lim.v.ok')} dettaglio={t('lim.v.dettaglio')} />
      )}
      <Tabs voci={voci} attiva={active} onCambia={(k) => navigate(k === 'freetier' ? '/limiti?tab=freetier' : '/limiti')} />
      {active === 'quotas' && <QuotasPage accountLabels={accountLabels} t={t} risposta={quote} />}
      {active === 'freetier' && <FreeTierPage t={t} risposta={free} />}
    </div>
  )
}
