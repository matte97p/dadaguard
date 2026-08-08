import { Tabs, Typography } from 'antd'
import { useNavigate, useSearchParams } from 'react-router-dom'
import CostsPage from './CostsPage.jsx'
import WastePage from './WastePage.jsx'

const { Title, Text } = Typography

// "Spesa" = Costi + Sprechi in una pagina a schede.
//
// Perché fondere: rispondono alla stessa domanda ("quanto ci costa questa infrastruttura") con due
// misure diverse — Costi è la spesa VERA di Cost Explorer, Sprechi è la stima a listino di risorse
// che nessuno usa. Come due voci di menu separate sembravano due argomenti, e chi cercava «quanto
// buttiamo» apriva Costi; qui la seconda misura è a un clic, con il titolo che dice la differenza.
//
// Le due schede tengono i loro fetch: sono chiamate care (Cost Explorer si paga a richiesta) e non
// devono partire entrambe perché sei entrato nella sezione.
export default function SpendPage({ accountLabels, tabs = ['costs', 'waste'], t = (k) => k, lang }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const wanted = params.get('tab') === 'sprechi' ? 'waste' : 'costs'
  const active = tabs.includes(wanted) ? wanted : tabs[0]

  const items = [
    { key: 'costs', label: t('spend.tab.costs'), children: <CostsPage accountLabels={accountLabels} t={t} lang={lang} embedded /> },
    { key: 'waste', label: t('spend.tab.waste'), children: <WastePage accountLabels={accountLabels} t={t} lang={lang} embedded /> },
  ].filter((i) => tabs.includes(i.key))

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
        // tasto indietro deve tornare alla scheda da cui vieni.
        onChange={(k) => navigate(k === 'waste' ? '/spesa?tab=sprechi' : '/spesa')}
        destroyOnHidden
      />
    </>
  )
}
