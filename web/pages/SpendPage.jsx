import { Tabs, Typography } from 'antd'
import { useNavigate, useSearchParams } from 'react-router-dom'
import CostsPage from './CostsPage.jsx'
import WastePage from './WastePage.jsx'

const { Title, Text } = Typography

// "Spesa" = Costi + Sprechi, in schede.
//
// Perché fondere: rispondono alla stessa domanda ("quanto ci costa questa infrastruttura") con due
// misure diverse — Costi è la spesa VERA di Cost Explorer, Sprechi è la stima a listino di risorse
// che nessuno usa. Come due voci di menu separate sembravano due argomenti, e chi cercava «quanto
// buttiamo» apriva Costi.
//
// Perché i Costi sono TRE schede e non una: impilati erano ~2900px di scroll, e sette sezioni in fila
// non si leggono — si scorrono cercando quella che serviva. Ogni scheda ora è una domanda sola:
//   Riepilogo    → siamo dentro al budget, e quanto stiamo spendendo questo mese
//   Andamento    → sta crescendo (13 mesi, indipendenti dal mese scelto)
//   Ripartizioni → di CHI è la spesa (per livello, per componente)
// E si paga solo quello che si guarda: ogni scheda chiede i suoi dati, e Cost Explorer si paga a
// richiesta — prima aprire la pagina ne faceva quattro gruppi anche per guardarne uno.
const COST_TABS = [
  { key: 'riepilogo', section: 'summary' },
  { key: 'andamento', section: 'trend' },
  { key: 'ripartizioni', section: 'breakdown' },
]

export default function SpendPage({ accountLabels, tabs = ['costs', 'waste'], t = (k) => k, lang }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const showCosts = tabs.includes('costs')
  const showWaste = tabs.includes('waste')

  const items = [
    ...(showCosts
      ? COST_TABS.map(({ key, section }) => ({
          key,
          label: t(`spend.tab.${key}`),
          children: <CostsPage accountLabels={accountLabels} t={t} lang={lang} embedded section={section} />,
        }))
      : []),
    ...(showWaste ? [{ key: 'sprechi', label: t('spend.tab.sprechi'), children: <WastePage accountLabels={accountLabels} t={t} lang={lang} embedded /> }] : []),
  ]

  const wanted = params.get('tab') ?? items[0]?.key
  const active = items.some((i) => i.key === wanted) ? wanted : items[0]?.key

  return (
    <>
      <div style={{ marginBottom: 4 }}>
        <Title level={4} style={{ margin: 0 }}>
          {t('spend.title')}
        </Title>
        <Text type="secondary">{t('spend.desc')}</Text>
      </div>
      <Tabs
        activeKey={active}
        items={items}
        // La scheda sta nell'URL: un link a «Sprechi» deve continuare a portare sugli sprechi, e il
        // tasto indietro deve tornare alla scheda da cui vieni. La prima non mette il parametro, così
        // `/spesa` resta l'indirizzo pulito della vista che si apre per prima.
        onChange={(k) => navigate(k === items[0]?.key ? '/spesa' : `/spesa?tab=${k}`)}
        destroyOnHidden
      />
    </>
  )
}
