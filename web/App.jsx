import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ConfigProvider,
  theme,
  Layout,
  Row,
  Col,
  Typography,
  Button,
  Spin,
  Alert,
  Empty,
  Space,
  Divider,
  Badge,
  Select,
  Segmented,
  Input,
  Switch,
  message,
} from 'antd'
import { makeT, resolveLang } from './i18n.jsx'
import {
  ReloadOutlined,
  RadarChartOutlined,
  MoonOutlined,
  SunOutlined,
  SafetyCertificateOutlined,
  DollarOutlined,
  DiffOutlined,
  PieChartOutlined,
  PartitionOutlined,
  DashboardOutlined,
  ApiOutlined,
} from '@ant-design/icons'
import ServiceCard from './components/ServiceCard.jsx'
import DiscoverDrawer from './components/DiscoverDrawer.jsx'
import StatusSummary from './components/StatusSummary.jsx'
import WasteDrawer from './components/WasteDrawer.jsx'
import DriftDrawer from './components/DriftDrawer.jsx'
import CostsDrawer from './components/CostsDrawer.jsx'
import TopologyDrawer from './components/TopologyDrawer.jsx'
import LogsDrawer from './components/LogsDrawer.jsx'
import EventsDrawer from './components/EventsDrawer.jsx'
import QuotasDrawer from './components/QuotasDrawer.jsx'
import MetaHealthDrawer from './components/MetaHealthDrawer.jsx'

const { Header, Content } = Layout
const { Title, Text } = Typography

export default function App() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [wasteOpen, setWasteOpen] = useState(false)
  const [driftOpen, setDriftOpen] = useState(false)
  const [costsOpen, setCostsOpen] = useState(false)
  const [topoOpen, setTopoOpen] = useState(false)
  const [quotasOpen, setQuotasOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [health, setHealth] = useState(null) // #6 meta-salute (raggiungibilità account)
  const [logsService, setLogsService] = useState(null) // nome del servizio di cui mostrare i log
  const [eventsService, setEventsService] = useState(null) // ... e gli eventi recenti
  const [dark, setDark] = useState(() => localStorage.getItem('opsdash-dark') === '1')
  // preferenza lingua salvata (it|en|null); se null → default per modalità (vedi resolveLang)
  const [langPref, setLangPref] = useState(() => localStorage.getItem('dadaguard-lang'))

  // Filtri: account singolo (switch) + region multi-select.
  const [accountFilter, setAccountFilter] = useState('all')
  const [regionFilter, setRegionFilter] = useState([])
  const [typeFilter, setTypeFilter] = useState([])
  const [statusFilter, setStatusFilter] = useState([]) // multi: up/degraded/down/idle/disabled…
  const [scheduleFilter, setScheduleFilter] = useState('all') // all | cron | ondemand
  const [managedFilter, setManagedFilter] = useState('all') // all | managed | unmanaged (Terraform)
  const [nameQuery, setNameQuery] = useState('')
  const [problemsOnly, setProblemsOnly] = useState(false) // scorciatoia: solo degraded/down

  useEffect(() => {
    localStorage.setItem('opsdash-dark', dark ? '1' : '0')
  }, [dark])

  // Lingua effettiva: preferenza salvata, altrimenti IT in locale / lingua browser in cloud.
  // Il server traduce i summary nella stessa lingua via ?lang=.
  const lang = resolveLang(langPref, data?.mode)
  const t = useMemo(() => makeT(lang), [lang])
  const setLang = useCallback((l) => {
    localStorage.setItem('dadaguard-lang', l)
    setLangPref(l)
  }, [])

  const load = useCallback(
    async (signal) => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/status?lang=${lang}`, { signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setData(await res.json())
      } catch (err) {
        if (err.name === 'AbortError') return // risposta stale (lingua cambiata): scartala, non toccare lo stato
        setError(err.message)
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [lang],
  )

  // #6 meta-salute: una sonda STS per account (raggiungibilità). On-mount + a ogni refresh.
  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/selfcheck')
      if (r.ok) setHealth(await r.json())
    } catch {
      /* il pallino resta neutro: non è un errore della dashboard */
    }
  }, [])

  useEffect(() => {
    loadHealth()
  }, [loadHealth])

  const removeService = useCallback(
    async (name) => {
      try {
        const res = await fetch('/api/watchlist/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `HTTP ${res.status}`)
        }
        load()
      } catch (err) {
        // Senza feedback l'utente non sa che il remove è fallito (permessi file, 409 cloud).
        message.error(err.message)
      }
    },
    [load],
  )

  useEffect(() => {
    // un fetch per lingua: al cambio di `lang` (o unmount) annulla il precedente → niente race
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const services = data?.services ?? []
  // capabilities = cosa permette la modalità corrente (vedi server/mode.js). Data-driven:
  // niente controllo dell'env duplicato lato client. Fallback se un server vecchio non le manda.
  const isCloud = data?.mode === 'cloud'
  const caps = data?.capabilities ?? { watchlist: !isCloud, discover: !isCloud, fullDrift: !isCloud }

  const accountOptions = useMemo(() => {
    const seen = new Map()
    for (const s of services) {
      const key = s.account?.key ?? '__none__'
      if (!seen.has(key)) seen.set(key, s.account?.label ?? t('filter.noAccount'))
    }
    return [
      { value: 'all', label: t('filter.allAccounts') },
      ...[...seen].map(([value, label]) => ({ value, label })),
    ]
  }, [services, t])

  const regionOptions = useMemo(
    () =>
      [...new Set(services.map((s) => s.region).filter(Boolean))]
        .sort()
        .map((r) => ({ value: r, label: r })),
    [services],
  )

  const typeOptions = useMemo(
    () =>
      [...new Set(services.map((s) => s.type).filter(Boolean))].sort().map((ty) => {
        const k = `type.${ty}`
        const label = t(k)
        return { value: ty, label: label === k ? ty : label }
      }),
    [services, t],
  )

  const statusOptions = useMemo(
    () =>
      [...new Set(services.map((s) => s.overall).filter(Boolean))]
        .sort()
        .map((v) => ({ value: v, label: t(`card.status.${v}`) })),
    [services, t],
  )

  const groups = useMemo(() => {
    const q = nameQuery.trim().toLowerCase()
    const filtered = services.filter((s) => {
      const cron = Boolean(s.checks?.runtime?.schedule)
      return (
        (accountFilter === 'all' || (s.account?.key ?? '__none__') === accountFilter) &&
        (regionFilter.length === 0 || regionFilter.includes(s.region)) &&
        (typeFilter.length === 0 || typeFilter.includes(s.type)) &&
        (statusFilter.length === 0 || statusFilter.includes(s.overall)) &&
        (scheduleFilter === 'all' || (scheduleFilter === 'cron') === cron) &&
        (managedFilter === 'all' ||
          (managedFilter === 'managed' ? s.managed === true : s.managed === false)) &&
        (!q || s.name.toLowerCase().includes(q)) &&
        (!problemsOnly || s.overall === 'degraded' || s.overall === 'down')
      )
    })
    const m = new Map()
    for (const s of filtered) {
      const key = s.account?.key ?? '__none__'
      if (!m.has(key)) {
        m.set(key, {
          key,
          label: s.account?.label ?? 'Senza account',
          color: s.account?.color,
          services: [],
        })
      }
      m.get(key).services.push(s)
    }
    return [...m.values()]
  }, [services, accountFilter, regionFilter, typeFilter, statusFilter, scheduleFilter, managedFilter, nameQuery, problemsOnly])

  // Account (per label) attualmente visibili → filtro applicato ai drawer aggregati e alla vista Rete.
  const visibleLabels = useMemo(() => new Set(groups.map((g) => g.label)), [groups])

  const filtersActive =
    accountFilter !== 'all' ||
    regionFilter.length > 0 ||
    typeFilter.length > 0 ||
    statusFilter.length > 0 ||
    scheduleFilter !== 'all' ||
    managedFilter !== 'all' ||
    nameQuery.trim() !== '' ||
    problemsOnly
  const resetFilters = useCallback(() => {
    setAccountFilter('all')
    setRegionFilter([])
    setTypeFilter([])
    setStatusFilter([])
    setScheduleFilter('all')
    setManagedFilter('all')
    setNameQuery('')
    setProblemsOnly(false)
  }, [])

  const themeConfig = {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { colorPrimary: '#7c3aed', borderRadius: 8 },
  }

  return (
    <ConfigProvider theme={themeConfig}>
      <Layout style={{ minHeight: '100vh' }}>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: 24,
            height: 'auto',
            lineHeight: 'normal',
            paddingBlock: 10,
            background: dark ? '#1f1f1f' : '#fff',
            borderBottom: `1px solid ${dark ? '#303030' : '#f0f0f0'}`,
          }}
        >
          <Space>
            <SafetyCertificateOutlined style={{ fontSize: 24, color: '#7c3aed' }} />
            <div>
              <Title level={5} style={{ margin: 0, lineHeight: 1.2 }}>
                Dadaguard 🐶
              </Title>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('app.subtitle')}
              </Text>
            </div>
          </Space>
          <Space wrap>
            <Badge
              dot
              status={health?.status === 'up' ? 'success' : health?.status === 'down' ? 'error' : 'default'}
              offset={[-2, 4]}
            >
              <Button
                type="text"
                icon={<ApiOutlined />}
                onClick={() => setHealthOpen(true)}
                title={t('health.title')}
              />
            </Badge>
            <Segmented
              size="small"
              value={lang}
              onChange={setLang}
              options={[
                { label: 'IT', value: 'it' },
                { label: 'EN', value: 'en' },
              ]}
            />
            <Button
              type="text"
              icon={dark ? <SunOutlined /> : <MoonOutlined />}
              onClick={() => setDark((d) => !d)}
              title={dark ? t('btn.themeLight') : t('btn.themeDark')}
            />
            <Button icon={<DollarOutlined />} onClick={() => setWasteOpen(true)}>
              {t('btn.waste')}
            </Button>
            <Button icon={<PieChartOutlined />} onClick={() => setCostsOpen(true)}>
              {t('btn.costs')}
            </Button>
            <Button icon={<PartitionOutlined />} onClick={() => setTopoOpen(true)}>
              {t('btn.topology')}
            </Button>
            <Button icon={<DashboardOutlined />} onClick={() => setQuotasOpen(true)}>
              {t('btn.quotas')}
            </Button>
            {caps.fullDrift && (
              <Button icon={<DiffOutlined />} onClick={() => setDriftOpen(true)}>
                {t('btn.drift')}
              </Button>
            )}
            {caps.discover && (
              <Button icon={<RadarChartOutlined />} onClick={() => setDiscoverOpen(true)}>
                {t('btn.discover')}
              </Button>
            )}
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => {
                load()
                loadHealth()
              }}
            >
              {t('btn.refresh')}
            </Button>
          </Space>
        </Header>

        <Content style={{ padding: 24 }}>
          <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} wrap>
            {data ? <StatusSummary services={groups.flatMap((g) => g.services)} t={t} /> : <span />}
            {data?.generatedAt && (
              <Text type="secondary">
                {t('content.lastFetch')} {new Date(data.generatedAt).toLocaleTimeString()}
              </Text>
            )}
          </Space>

          {data?.mode === 'demo' && (
            <Alert
              type="warning"
              showIcon
              banner
              style={{ marginBottom: 16 }}
              message={t('demo.title')}
              description={t('demo.desc')}
            />
          )}

          {data?.discovered && (
            <Alert
              type="info"
              showIcon
              closable
              style={{ marginBottom: 16 }}
              message={t('discover.autoTitle')}
              description={t('discover.autoDesc', { n: data.discovered.count })}
            />
          )}

          {data && (
            <Space style={{ marginBottom: 16 }} wrap>
              <Input.Search
                allowClear
                placeholder={t('filter.searchName')}
                value={nameQuery}
                onChange={(e) => setNameQuery(e.target.value)}
                style={{ width: 200 }}
              />
              <Select
                value={accountFilter}
                onChange={setAccountFilter}
                options={accountOptions}
                style={{ minWidth: 160 }}
              />
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                placeholder={t('filter.allTypes')}
                value={typeFilter}
                onChange={setTypeFilter}
                options={typeOptions}
                style={{ minWidth: 150 }}
              />
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                placeholder={t('filter.allStatuses')}
                value={statusFilter}
                onChange={setStatusFilter}
                options={statusOptions}
                style={{ minWidth: 150 }}
              />
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                placeholder={t('filter.allRegions')}
                value={regionFilter}
                onChange={setRegionFilter}
                options={regionOptions}
                style={{ minWidth: 160 }}
              />
              <Select
                value={scheduleFilter}
                onChange={setScheduleFilter}
                style={{ minWidth: 150 }}
                options={[
                  { value: 'all', label: t('filter.schedule.all') },
                  { value: 'cron', label: t('filter.schedule.cron') },
                  { value: 'ondemand', label: t('filter.schedule.ondemand') },
                ]}
              />
              <Select
                value={managedFilter}
                onChange={setManagedFilter}
                style={{ minWidth: 150 }}
                options={[
                  { value: 'all', label: t('filter.tf.all') },
                  { value: 'managed', label: t('filter.tf.managed') },
                  { value: 'unmanaged', label: t('filter.tf.unmanaged') },
                ]}
              />
              <Space size={6}>
                <Switch size="small" checked={problemsOnly} onChange={setProblemsOnly} />
                <Text>{t('filter.problemsOnly')}</Text>
              </Space>
              {filtersActive && (
                <Button type="link" size="small" onClick={resetFilters}>
                  {t('filter.reset')}
                </Button>
              )}
            </Space>
          )}

          {error && (
            <Alert type="error" message={`${t('content.errorPrefix')} ${error}`} style={{ marginBottom: 16 }} showIcon />
          )}
          {loading && !data && (
            <div style={{ textAlign: 'center', padding: 48 }}>
              <Spin size="large" />
            </div>
          )}
          {data && groups.length === 0 && (
            <Empty description={t('content.noServices')} style={{ marginTop: 48 }} />
          )}

          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 8 }}>
              <Divider orientation="left" orientationMargin={0}>
                <Space size={6}>
                  {g.color && <Badge color={g.color} />}
                  <Text strong>{g.label}</Text>
                  <Text type="secondary">({g.services.length})</Text>
                </Space>
              </Divider>
              <Row gutter={[16, 16]}>
                {g.services.map((svc) => (
                  <Col key={svc.name} xs={24} sm={12} md={8} lg={6}>
                    <ServiceCard
                      service={svc}
                      onRemove={caps.watchlist ? removeService : undefined}
                      onLogs={setLogsService}
                      onEvents={setEventsService}
                      t={t}
                    />
                  </Col>
                ))}
              </Row>
            </div>
          ))}
        </Content>

        <DiscoverDrawer
          open={discoverOpen}
          onClose={() => setDiscoverOpen(false)}
          existingNames={services.map((s) => s.name)}
          onAdded={load}
          t={t}
        />
        <WasteDrawer open={wasteOpen} onClose={() => setWasteOpen(false)} accountLabels={visibleLabels} t={t} />
        <CostsDrawer open={costsOpen} onClose={() => setCostsOpen(false)} accountLabels={visibleLabels} t={t} />
        <TopologyDrawer
          open={topoOpen}
          onClose={() => setTopoOpen(false)}
          services={groups.flatMap((g) => g.services)}
          accountLabels={visibleLabels}
          dark={dark}
          t={t}
        />
        <DriftDrawer open={driftOpen} onClose={() => setDriftOpen(false)} t={t} />
        <LogsDrawer service={logsService} onClose={() => setLogsService(null)} t={t} />
        <EventsDrawer service={eventsService} onClose={() => setEventsService(null)} t={t} />
        <QuotasDrawer open={quotasOpen} onClose={() => setQuotasOpen(false)} accountLabels={visibleLabels} t={t} />
        <MetaHealthDrawer open={healthOpen} onClose={() => setHealthOpen(false)} health={health} accountLabels={visibleLabels} t={t} />
      </Layout>
    </ConfigProvider>
  )
}
