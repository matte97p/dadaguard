import { useCallback, useEffect, useMemo, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import {
  ConfigProvider,
  theme,
  Layout,
  Typography,
  Button,
  Space,
  Badge,
  Segmented,
  Modal,
  Input,
  Alert,
  message,
} from 'antd'
import { makeT, resolveLang } from './i18n.jsx'
import {
  ReloadOutlined,
  RadarChartOutlined,
  MoonOutlined,
  SunOutlined,
  DollarOutlined,
  DiffOutlined,
  PieChartOutlined,
  PartitionOutlined,
  DashboardOutlined,
  AppstoreOutlined,
  ApiOutlined,
  SafetyOutlined,
  AlertOutlined,
  GiftOutlined,
  RocketOutlined,
} from '@ant-design/icons'
import FilterBar, { FILTER_FIELDS_FULL, FILTER_FIELDS_ACCOUNT } from './components/FilterBar.jsx'
import DiscoverDrawer from './components/DiscoverDrawer.jsx'
import DriftDrawer from './components/DriftDrawer.jsx'
import LogsDrawer from './components/LogsDrawer.jsx'
import EventsDrawer from './components/EventsDrawer.jsx'
import MetaHealthDrawer from './components/MetaHealthDrawer.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import CostsPage from './pages/CostsPage.jsx'
import DeploysPage from './pages/DeploysPage.jsx'
import WastePage from './pages/WastePage.jsx'
import QuotasPage from './pages/QuotasPage.jsx'
import FreeTierPage from './pages/FreeTierPage.jsx'
import TopologyPage from './pages/TopologyPage.jsx'
import IamPage from './pages/IamPage.jsx'
import SecurityPage from './pages/SecurityPage.jsx'
import logo from '../assets/logo.png'

const { Header, Content } = Layout
const { Title, Text } = Typography

// Preset rapidi predefiniti: combinazioni comuni applicabili con un clic (oltre a quelli salvati).
const QUICK_PRESETS = [
  { key: 'problems', labelKey: 'filter.problemsOnly', filters: { problemsOnly: true } },
  { key: 'cron', labelKey: 'filter.schedule.cron', filters: { scheduleFilter: 'cron' } },
  { key: 'ondemand', labelKey: 'filter.schedule.ondemand', filters: { scheduleFilter: 'ondemand' } },
  { key: 'idle', labelKey: 'preset.quick.idle', filters: { statusFilter: ['idle'] } },
  { key: 'untracked', labelKey: 'filter.tf.unmanaged', filters: { managedFilter: 'unmanaged' } },
]

// Pagine di navigazione: le viste "aggregate" (Costi/Sprechi/Quote) sono per-account → barra filtri
// ridotta ad Account + Regione; Dashboard e Topologia filtrano singoli servizi → barra piena.
const NAV = [
  { to: '/', key: 'dashboard', icon: <AppstoreOutlined />, fields: FILTER_FIELDS_FULL },
  { to: '/costi', key: 'costs', icon: <PieChartOutlined />, fields: FILTER_FIELDS_ACCOUNT },
  { to: '/deploy', key: 'deploys', icon: <RocketOutlined />, fields: FILTER_FIELDS_ACCOUNT },
  { to: '/sprechi', key: 'waste', icon: <DollarOutlined />, fields: FILTER_FIELDS_ACCOUNT },
  { to: '/topologia', key: 'topology', icon: <PartitionOutlined />, fields: FILTER_FIELDS_FULL },
  { to: '/quote', key: 'quotas', icon: <DashboardOutlined />, fields: FILTER_FIELDS_ACCOUNT },
  { to: '/freetier', key: 'freetier', icon: <GiftOutlined />, fields: [] },
  { to: '/iam', key: 'iam', icon: <SafetyOutlined />, fields: [] },
  { to: '/sicurezza', key: 'security', icon: <AlertOutlined />, fields: [] },
]

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [driftOpen, setDriftOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [health, setHealth] = useState(null) // #6 meta-salute (raggiungibilità account)
  const [logsService, setLogsService] = useState(null) // nome del servizio di cui mostrare i log
  const [eventsService, setEventsService] = useState(null) // ... e gli eventi recenti
  const [dark, setDark] = useState(() => localStorage.getItem('opsdash-dark') === '1')
  // preferenza lingua salvata (it|en|null); se null → default per modalità (vedi resolveLang)
  const [langPref, setLangPref] = useState(() => localStorage.getItem('dadaguard-lang'))

  // Filtri: account singolo (switch) + region/type/status multi. Lo stato vive qui e persiste
  // mentre si naviga tra le pagine; ogni pagina mostra solo il sottoinsieme di controlli sensato.
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
        if (err.name === 'AbortError') return // risposta stale (lingua cambiata): scartala
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
      const r = await fetch(`/api/selfcheck?lang=${lang}`)
      if (r.ok) setHealth(await r.json())
    } catch {
      /* il pallino resta neutro: non è un errore della dashboard */
    }
  }, [lang])

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
      [...new Set(services.map((s) => s.region).filter(Boolean))].sort().map((r) => ({ value: r, label: r })),
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

  // Default del drawer log per il servizio selezionato: un cron gira di rado → apri con finestra
  // ampia (48h) e, se è rosso, già filtrato sugli errori → risponde subito a "perché è fallito?".
  const logsSvc = useMemo(() => services.find((s) => s.name === logsService) ?? null, [services, logsService])
  const isCronSvc = Boolean(logsSvc && (logsSvc.checks?.runtime?.schedule || logsSvc.type === 'ecs-scheduled'))
  const logsDefaultMinutes = isCronSvc ? 2880 : 60
  const logsDefaultErrorsOnly = isCronSvc && logsSvc?.overall === 'down'

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
        m.set(key, { key, label: s.account?.label ?? t('filter.noAccount'), color: s.account?.color, services: [] })
      }
      m.get(key).services.push(s)
    }
    return [...m.values()]
  }, [services, accountFilter, regionFilter, typeFilter, statusFilter, scheduleFilter, managedFilter, nameQuery, problemsOnly, t])

  // Account (per label) dopo il filtro servizi completo → per la Topologia (che filtra i servizi).
  const visibleLabels = useMemo(() => new Set(groups.map((g) => g.label)), [groups])

  // Account visibili applicando SOLO Account + Regione → per i pannelli aggregati (Costi/Sprechi/Quote),
  // che sono per-account e non devono risentire dei filtri di tipo/stato/schedule.
  const aggregateLabels = useMemo(() => {
    const s = new Set()
    for (const svc of services) {
      if (accountFilter !== 'all' && (svc.account?.key ?? '__none__') !== accountFilter) continue
      if (regionFilter.length && !regionFilter.includes(svc.region)) continue
      s.add(svc.account?.label ?? t('filter.noAccount'))
    }
    return s
  }, [services, accountFilter, regionFilter, t])

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

  // Filtri preimpostati: combinazioni salvate in locale, richiamabili con un clic.
  const [presets, setPresets] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('dadaguard-presets') || '[]')
    } catch {
      return []
    }
  })
  const [savePresetOpen, setSavePresetOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const persistPresets = (next) => {
    setPresets(next)
    localStorage.setItem('dadaguard-presets', JSON.stringify(next))
  }
  const applyPreset = (f) => {
    setAccountFilter(f.accountFilter ?? 'all')
    setRegionFilter(f.regionFilter ?? [])
    setTypeFilter(f.typeFilter ?? [])
    setStatusFilter(f.statusFilter ?? [])
    setScheduleFilter(f.scheduleFilter ?? 'all')
    setManagedFilter(f.managedFilter ?? 'all')
    setNameQuery(f.nameQuery ?? '')
    setProblemsOnly(Boolean(f.problemsOnly))
  }
  const saveCurrentPreset = () => {
    const n = presetName.trim()
    if (!n) return
    const filters = { accountFilter, regionFilter, typeFilter, statusFilter, scheduleFilter, managedFilter, nameQuery, problemsOnly }
    persistPresets([...presets.filter((p) => p.name !== n), { name: n, filters }])
    setSavePresetOpen(false)
    setPresetName('')
  }
  const deletePreset = (name) => persistPresets(presets.filter((p) => p.name !== name))

  const themeConfig = {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { colorPrimary: '#7c3aed', borderRadius: 8 },
  }

  const activeNav = NAV.find((n) => n.to === location.pathname) ?? NAV[0]
  // L'header nasconde le superfici a cui il ruolo assunto non ha accesso (deciso lato server via
  // SimulatePrincipalPolicy → health.surfaces): 'denied' = negato in tutti gli account → via.
  // 'allowed'/'unknown'/assente (selfcheck non ancora arrivato) → mostra: default sicuro, mai un
  // header vuoto. Le rotte restano montate: un deep-link a una pagina nascosta funziona comunque.
  const surfaces = health?.surfaces
  const visibleNav = NAV.filter((n) => surfaces?.[n.key] !== 'denied')
  const filterProps = {
    fields: activeNav.fields,
    nameQuery,
    setNameQuery,
    accountFilter,
    setAccountFilter,
    typeFilter,
    setTypeFilter,
    statusFilter,
    setStatusFilter,
    regionFilter,
    setRegionFilter,
    scheduleFilter,
    setScheduleFilter,
    managedFilter,
    setManagedFilter,
    problemsOnly,
    setProblemsOnly,
    accountOptions,
    typeOptions,
    statusOptions,
    regionOptions,
    filtersActive,
    resetFilters,
    presets,
    quickPresets: QUICK_PRESETS,
    applyPreset,
    deletePreset,
    onSavePreset: () => setSavePresetOpen(true),
    t,
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
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <Space>
            <img src={logo} alt="Dadaguard" style={{ width: 32, height: 32, borderRadius: 8, display: 'block' }} />
            <div>
              <Title level={5} style={{ margin: 0, lineHeight: 1.2 }}>
                Dadaguard
              </Title>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('app.subtitle')}
              </Text>
            </div>
          </Space>

          {/* Navigazione tra le pagine (senza le superfici non accessibili a questo ruolo) */}
          <Space wrap>
            {visibleNav.map((n) => {
              const active = n.to === location.pathname
              return (
                <Button
                  key={n.key}
                  type={active ? 'primary' : 'text'}
                  ghost={active}
                  icon={n.icon}
                  onClick={() => navigate(n.to)}
                >
                  {t(`btn.${n.key}`)}
                </Button>
              )
            })}
          </Space>

          <Space wrap>
            <Badge
              dot
              status={health?.status === 'up' ? 'success' : health?.status === 'down' ? 'error' : 'default'}
              offset={[-2, 4]}
            >
              <Button type="text" icon={<ApiOutlined />} onClick={() => setHealthOpen(true)} title={t('health.title')} />
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

          {data && activeNav.fields.length > 0 && <FilterBar {...filterProps} />}

          <Routes>
            <Route
              path="/"
              element={
                <DashboardPage
                  data={data}
                  groups={groups}
                  caps={caps}
                  loading={loading}
                  error={error}
                  onRemove={removeService}
                  onLogs={setLogsService}
                  onEvents={setEventsService}
                  t={t}
                />
              }
            />
            <Route path="/costi" element={<CostsPage accountLabels={aggregateLabels} t={t} lang={lang} />} />
            <Route path="/deploy" element={<DeploysPage accountLabels={aggregateLabels} t={t} lang={lang} />} />
            <Route path="/sprechi" element={<WastePage accountLabels={aggregateLabels} t={t} lang={lang} />} />
            <Route
              path="/topologia"
              element={
                <TopologyPage
                  services={groups.flatMap((g) => g.services)}
                  accountLabels={visibleLabels}
                  dark={dark}
                  t={t}
                />
              }
            />
            <Route path="/quote" element={<QuotasPage accountLabels={aggregateLabels} t={t} lang={lang} />} />
            <Route path="/freetier" element={<FreeTierPage t={t} lang={lang} />} />
            <Route path="/iam" element={<IamPage services={services} t={t} lang={lang} />} />
            <Route path="/sicurezza" element={<SecurityPage t={t} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>

        {/* Popup (azioni contestuali), montati una volta a livello app */}
        <DiscoverDrawer
          open={discoverOpen}
          onClose={() => setDiscoverOpen(false)}
          existingNames={services.map((s) => s.name)}
          onAdded={load}
          t={t}
        />
        <DriftDrawer open={driftOpen} onClose={() => setDriftOpen(false)} t={t} />
        <LogsDrawer
          service={logsService}
          defaultMinutes={logsDefaultMinutes}
          defaultErrorsOnly={logsDefaultErrorsOnly}
          onClose={() => setLogsService(null)}
          t={t}
          lang={lang}
        />
        <EventsDrawer service={eventsService} onClose={() => setEventsService(null)} t={t} lang={lang} />
        <MetaHealthDrawer
          open={healthOpen}
          onClose={() => setHealthOpen(false)}
          health={health}
          accountLabels={aggregateLabels}
          t={t}
        />

        <Modal
          open={savePresetOpen}
          title={t('preset.saveTitle')}
          okText={t('preset.saveOk')}
          cancelText={t('card.removeCancel')}
          onOk={saveCurrentPreset}
          onCancel={() => setSavePresetOpen(false)}
        >
          <Input
            placeholder={t('preset.namePlaceholder')}
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onPressEnter={saveCurrentPreset}
          />
        </Modal>
      </Layout>
    </ConfigProvider>
  )
}
