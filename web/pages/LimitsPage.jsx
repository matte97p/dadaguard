import { Tabs, Typography } from 'antd'
import { useNavigate, useSearchParams } from 'react-router-dom'
import QuotasPage from './QuotasPage.jsx'
import FreeTierPage from './FreeTierPage.jsx'

const { Title, Text } = Typography

// "Limiti" = Quote di servizio + Free Tier.
//
// Perché fondere: sono due muri diversi con lo stesso significato operativo — «quanto manca prima
// che qualcosa smetta di funzionare o inizi a costare». Le quote AWS bloccano (non puoi creare la
// risorsa), il free tier no (paghi), ma la domanda che porta qui è la stessa, e come due voci di menu
// separate nessuna delle due si guardava mai.
export default function LimitsPage({ accountLabels, tabs = ['quotas', 'freetier'], t = (k) => k, lang }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const wanted = params.get('tab') === 'freetier' ? 'freetier' : 'quotas'
  const active = tabs.includes(wanted) ? wanted : tabs[0]

  const items = [
    { key: 'quotas', label: t('limits.tab.quotas'), children: <QuotasPage accountLabels={accountLabels} t={t} lang={lang} embedded /> },
    { key: 'freetier', label: t('limits.tab.freetier'), children: <FreeTierPage t={t} lang={lang} embedded /> },
  ].filter((i) => tabs.includes(i.key))

  return (
    <>
      <div style={{ marginBottom: 4 }}>
        <Title level={4} style={{ margin: 0 }}>
          {t('limits.title')}
        </Title>
        <Text type="secondary">{t('limits.desc')}</Text>
      </div>
      <Tabs
        activeKey={active}
        items={items}
        onChange={(k) => navigate(k === 'freetier' ? '/limiti?tab=freetier' : '/limiti')}
        destroyOnHidden
      />
    </>
  )
}
