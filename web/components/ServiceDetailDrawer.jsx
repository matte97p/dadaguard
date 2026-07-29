import { Drawer, Badge, Typography, Space, Button, Descriptions, Tag, Tabs } from 'antd'
import { RocketOutlined } from '@ant-design/icons'
import { detailTabs } from '../format.js'
import LogsPanel from './LogsPanel.jsx'
import EventsPanel from './EventsPanel.jsx'

const { Text, Link } = Typography

const STATUS = { down: 'error', degraded: 'warning', up: 'success', idle: 'default', disabled: 'default', unknown: 'default' }

// Tutti i segnali del servizio, in ordine, con la loro etichetta i18n.
const CHECKS = [
  ['liveness', 'card.label.reachable'],
  ['version', 'card.label.build'],
  ['runtime', 'card.label.runtime'],
  ['secrets', 'card.label.secret'],
  ['security', 'card.label.security'],
  ['alarms', 'card.label.alarms'],
  ['backups', 'card.label.backups'],
]

// Pannello unico per-servizio: stato + tutti i segnali, e in SCHEDE i log e gli eventi.
//
// Prima log ed eventi erano due drawer separati che si aprivano SOPRA questo: il servizio che stavi
// guardando finiva coperto, e chiudendone uno riappariva l'altro. Ora c'è una superficie sola per
// servizio, larga come serve ai log (760px). Le schede si montano solo quando le apri, quindi la
// chiamata resta on-demand: aprire un servizio non scarica i suoi log.
//
// Il bottone "Costi" è stato TOLTO: la pagina Costi ragiona per servizio AWS (EC2, S3, Bedrock), non
// per servizio monitorato — da qui portava a numeri che non parlano di questo servizio, e per un
// worker Cloudflare nemmeno del suo provider. Un bottone che promette e non mantiene è peggio di un
// bottone che non c'è.
export default function ServiceDetailDrawer({
  service,
  tab = 'overview',
  onTab,
  logsDefaultMinutes = 60,
  logsDefaultErrorsOnly = false,
  onClose,
  onNavigate,
  t = (k) => k,
  lang,
}) {
  const checks = service?.checks ?? {}
  const links = service?.links ?? {}
  const has = detailTabs(service)

  const items = [
    {
      key: 'overview',
      label: t('detail.tab.overview'),
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions column={1} size="small" bordered labelStyle={{ width: 120 }}>
            {CHECKS.filter(([k]) => checks[k]).map(([k, labelKey]) => {
              const c = checks[k]
              return (
                <Descriptions.Item key={k} label={t(labelKey)}>
                  <Space size={6} align="start">
                    <Badge status={STATUS[c.status] ?? 'default'} />
                    <span>{c.summary ?? c.reason ?? '—'}</span>
                  </Space>
                </Descriptions.Item>
              )
            })}
          </Descriptions>

          {Object.keys(links).length > 0 && (
            <Space wrap>
              {Object.entries(links).map(([label, url]) => (
                <Link key={label} href={url} target="_blank" rel="noreferrer">
                  {label} ↗
                </Link>
              ))}
            </Space>
          )}
        </Space>
      ),
    },
    has.logs && {
      key: 'logs',
      label: t('logs.button'),
      // antd monta il pannello alla PRIMA apertura della scheda e poi lo tiene: la chiamata parte
      // quando i log li chiedi, non quando apri il servizio.
      children: (
        <LogsPanel
          service={service?.name}
          account={service?.account?.key}
          defaultMinutes={logsDefaultMinutes}
          defaultErrorsOnly={logsDefaultErrorsOnly}
          t={t}
          lang={lang}
        />
      ),
    },
    has.events && {
      key: 'events',
      label: t('events.button'),
      children: <EventsPanel service={service?.name} account={service?.account?.key} t={t} lang={lang} />,
    },
  ].filter(Boolean)

  // Se il servizio aperto non ha la scheda richiesta (es. "log" su un bucket S3) si torna alla
  // panoramica, invece di mostrare una scheda vuota o nessuna scheda selezionata.
  const active = items.some((i) => i.key === tab) ? tab : 'overview'

  return (
    <Drawer
      open={!!service}
      onClose={onClose}
      width={760}
      title={
        service && (
          <Space size={8} wrap>
            <Badge status={STATUS[service.overall] ?? 'default'} />
            <Text strong>{service.name}</Text>
            {service.type && <Tag>{service.type}</Tag>}
          </Space>
        )
      }
      extra={
        service &&
        has.deploy && (
          <Button
            size="small"
            icon={<RocketOutlined />}
            // Con il servizio in query: la pagina Deploy si apre GIÀ filtrata su questo servizio,
            // invece di scaricarti addosso i deploy di tutta la flotta da cercare a mano.
            onClick={() => onNavigate?.(`/deploy?service=${encodeURIComponent(service.name)}`)}
          >
            {t('btn.deploys')}
          </Button>
        )
      }
    >
      {service && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {[service.account?.label, service.region].filter(Boolean).join(' · ')}
          </Text>
          {/* Una scheda sola non è una scelta: la barra sarebbe decorazione (è il caso dei tipi senza
              log né eventi, es. un worker Cloudflare). Si mostra il contenuto e basta. */}
          {items.length === 1 ? (
            items[0].children
          ) : (
            <Tabs size="small" activeKey={active} onChange={onTab} items={items} style={{ marginTop: -8 }} />
          )}
        </Space>
      )}
    </Drawer>
  )
}
