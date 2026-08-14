import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Typography, Space, Tag, Tooltip, Alert, Skeleton, Segmented } from 'antd'
import {
  ClockCircleOutlined,
  SyncOutlined,
  CloudServerOutlined,
  RocketOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  DollarOutlined,
  LineChartOutlined,
} from '@ant-design/icons'
import { PageIntro, HeroRow, HeroStat, Section, EmptyState } from './pageKit.jsx'
import { buildSignals, countByLevel } from '../nowSignals.js'
import { displayName } from '../serviceName.js'
import { fmtAgo } from '../format.js'
import { levelColor, FONT, SPACE } from '../theme.js'
import { matchesAny } from '../filters.js'

const { Text } = Typography

// Un'icona per tipo di segnale: a colpo d'occhio dice DA DOVE arriva la riga, che è metà del lavoro
// quando in una lista sola convivono servizi, rilasci, firewall e budget.
const KIND_ICON = {
  service: <CloudServerOutlined />,
  deploy: <RocketOutlined />,
  restart: <ReloadOutlined />,
  waf: <SafetyCertificateOutlined />,
  budget: <DollarOutlined />,
  anomaly: <LineChartOutlined />,
}

// Finestre: 1h e 6h ci sono perché è dentro un incidente che si apre questa pagina, e lì la domanda è
// «cos'è cambiato nell'ultima ora», non «cos'è successo oggi». Partono da 24h — la finestra di chi
// arriva la mattina — e le due corte si scelgono quando servono. Il WAF le sopporta tutte (l'endpoint
// prende `hours` e la sua cache è per finestra), gli altri due dati non hanno finestra: si filtra qui.
const WINDOWS = [1, 6, 24, 72, 168]

function SignalRow({ s, t, onOpen }) {
  const color = levelColor(s.level)
  return (
    <div
      role="button"
      tabIndex={0}
      title={s.full ?? t('now.open')}
      // data-signal: ancora per il video demo, vedi pageKit.jsx.
      data-signal={s.kind}
      onClick={() => onOpen(s)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(s))}
      className="dg-signal"
      style={{ borderInlineStart: `3px solid ${color}` }}
    >
      <span style={{ color, flex: 'none', opacity: 0.85 }}>{KIND_ICON[s.kind] ?? null}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Space size={8} wrap style={{ rowGap: 2 }}>
          <Text strong>{s.title}</Text>
          <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '17px', padding: '0 6px', opacity: 0.85 }}>
            {t(`now.kind.${s.kind}`)}
          </Tag>
          {s.accountLabel && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {s.accountLabel}
            </Text>
          )}
        </Space>
        {s.detail && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {s.detail}
            </Text>
          </div>
        )}
      </div>
      {/* Un servizio senza data è uno STATO in corso, e vale dirlo. Un budget o un aggregato del WAF
          no: "in corso" su un budget sforato non significa niente, e una parola che non significa
          niente occupa lo spazio dove chi legge cerca un orario. */}
      <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap', flex: 'none' }}>
        {s.when ? (
          <>
            <ClockCircleOutlined style={{ marginInlineEnd: 3 }} />
            {fmtAgo(s.when, t)}
          </>
        ) : s.kind === 'service' ? (
          t('now.ongoing')
        ) : null}
      </Text>
    </div>
  )
}

// Pagina "Adesso": la prima che si apre. Raccoglie da tutte le fonti solo ciò che è cambiato nella
// finestra o che morde in questo momento, e manda alla pagina che ne sa di più. Nessuna fonte nuova:
// gli stessi endpoint delle altre viste.
// `statusReady` = lo stato della flotta è ARRIVATO (non "non sto caricando"). Sono due cose diverse e
// confonderle era il difetto: il flag di caricamento dell'app parte da `false`, quindi c'era una
// finestra in cui la flotta era vuota e nessuno stava ancora caricando — e questa pagina scriveva
// «niente da segnalare · controllati 0 servizi», che è un ESITO, mentre i servizi non li aveva
// nemmeno guardati. Cinque secondi dopo comparivano, giù e degradati, in cima all'elenco.
export default function NowPage({ services = [], statusReady = false, statusLoading, statusError, refreshKey, accountFilter = [], t = (k) => k, lang }) {
  const navigate = useNavigate()
  const [hours, setHours] = useState(24)
  const [deploys, setDeploys] = useState(null)
  const [waf, setWaf] = useState(null)
  const [budgets, setBudgets] = useState(null)
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState([])

  useEffect(() => {
    let alive = true
    setLoading(true)
    // Tre fonti indipendenti: una che non risponde non deve spegnere le altre — questa pagina è
    // l'unica che le vede insieme, e mostrarne due su tre è meglio che mostrare un errore solo.
    const grab = (url, set) =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: HTTP ${r.status}`))))
        .then((j) => alive && set(j))
        .catch((e) => alive && setErrors((prev) => [...prev, e.message]))
    setErrors([])
    Promise.all([
      grab(`/api/deploys?lang=${lang ?? ''}`, setDeploys),
      grab(`/api/waf?hours=${hours}`, setWaf),
      grab(`/api/budgets?lang=${lang ?? ''}`, setBudgets),
    ]).finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [hours, lang, refreshKey])

  const signals = useMemo(() => {
    const all = buildSignals({
      services,
      deploys: deploys ?? {},
      waf,
      budgets,
      hours,
      t,
      nameOf: displayName,
    })
    // Il filtro Account della barra in alto vale anche qui. Le righe senza account (un'anomalia porta
    // il NOME dell'account, non la sua chiave) restano visibili: nasconderle per un filtro che non le
    // riguarda toglierebbe fatti veri senza dirlo.
    return all.filter((s) => s.accountKey == null || matchesAny(s.accountKey, accountFilter))
  }, [services, deploys, waf, budgets, hours, accountFilter, t])

  const counts = useMemo(() => countByLevel(signals), [signals])
  // Si aspetta finché le proprie fonti sono in volo O finché la flotta non è arrivata.
  const waiting = loading || statusLoading || !statusReady

  return (
    <>
      <PageIntro
        title={t('now.title')}
        desc={t('now.desc')}
        extra={
          <Segmented
            size="small"
            value={hours}
            onChange={setHours}
            options={WINDOWS.map((h) => ({ value: h, label: t(`now.window.${h}`) }))}
          />
        }
      />

      {statusError && <Alert type="error" showIcon message={statusError} style={{ marginBottom: 12 }} />}
      {errors.length > 0 && (
        <Alert type="warning" showIcon message={t('now.partial')} description={errors.join(' · ')} style={{ marginBottom: 12 }} />
      )}

      {signals.length > 0 && (
        <HeroRow>
          {counts.crit > 0 && <HeroStat label={t('now.level.crit')} value={counts.crit} color={levelColor('crit')} size={18} />}
          {counts.bad > 0 && <HeroStat label={t('now.level.bad')} value={counts.bad} color={levelColor('bad')} size={18} />}
          {counts.warn > 0 && <HeroStat label={t('now.level.warn')} value={counts.warn} color={levelColor('warn')} size={18} />}
          {counts.info > 0 && <HeroStat label={t('now.level.info')} value={counts.info} color={levelColor('info')} size={18} />}
        </HeroRow>
      )}

      {waiting && signals.length === 0 && <Skeleton active paragraph={{ rows: 4 }} />}

      {/* Le fonti non arrivano insieme: deploy, WAF e budget rispondono in meno di un secondo, lo
          stato della flotta fa ~8 controlli su decine di servizi e ne prende 4-5. Mostrare l'elenco
          senza dire che manca un pezzo lo fa leggere come completo — e il pezzo che manca sono i
          servizi giù, cioè le righe che stanno in cima. */}
      {!statusReady && signals.length > 0 && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          <SyncOutlined spin style={{ marginInlineEnd: 6 }} />
          {t('now.checkingFleet')}
        </Text>
      )}

      {/* Niente da segnalare è un ESITO, non un vuoto: si dice cosa è stato guardato, altrimenti una
          pagina vuota si legge come "non funziona". */}
      {!waiting && signals.length === 0 && (
        <EmptyState
          description={
            <Space direction="vertical" size={2}>
              <Text>{t('now.allQuiet', { h: hours })}</Text>
              <Text type="secondary" style={{ fontSize: FONT.small }}>
                {t('now.checked', { n: services.length })}
              </Text>
            </Space>
          }
        />
      )}

      {signals.length > 0 && (
        <Section title={t('now.listTitle', { n: signals.length })}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.xs }}>
            {signals.map((s) => (
              <SignalRow key={s.id} s={s} t={t} onOpen={(x) => navigate(x.to)} />
            ))}
          </div>
        </Section>
      )}

      {signals.length > 0 && (
        <Tooltip title={t('now.footerTip')}>
          <Text type="secondary" style={{ display: 'block', marginTop: 14, fontSize: 12 }}>
            {t('now.footer')}
          </Text>
        </Tooltip>
      )}
    </>
  )
}
