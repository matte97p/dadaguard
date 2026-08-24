import { useCallback, useEffect, useMemo, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { ConfigProvider, theme, Layout, Typography, Button, Space, Badge, Segmented, Modal, Input, Alert, message, Skeleton } from 'antd'
import { makeT, resolveLang } from './i18n.jsx'
import {
  ReloadOutlined,
  RadarChartOutlined,
  MoonOutlined,
  SunOutlined,
  DiffOutlined,
  PieChartOutlined,
  PartitionOutlined,
  DashboardOutlined,
  AppstoreOutlined,
  ApiOutlined,
  SafetyOutlined,
  AlertOutlined,
  RocketOutlined,
  ThunderboltOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  FieldTimeOutlined,
} from '@ant-design/icons'
import FilterBar, { FILTER_FIELDS_FULL, FILTER_FIELDS_ACCOUNT } from './components/FilterBar.jsx'
import SideNav from './components/SideNav.jsx'
import { antdTheme, SPACE, FONT } from './theme.js'
import { asList, matchesAny, isFiltering } from './filters.js'
import DiscoverDrawer from './components/DiscoverDrawer.jsx'
import DriftDrawer from './components/DriftDrawer.jsx'
import MetaHealthDrawer from './components/MetaHealthDrawer.jsx'
import CommandPalette from './components/CommandPalette.jsx'
import ServiceDetailDrawer from './components/ServiceDetailDrawer.jsx'
import { displayName, serviceKey } from './serviceName.js'
import DashboardPage from './pages/DashboardPage.jsx'
import NowPage from './pages/NowPage.jsx'
import RunsPage from './pages/RunsPage.jsx'
import SpendPage from './pages/SpendPage.jsx'
import LimitsPage from './pages/LimitsPage.jsx'
import DeploysPage from './pages/DeploysPage.jsx'
import TopologyPage from './pages/TopologyPage.jsx'
import IamPage from './pages/IamPage.jsx'
import SecurityPage from './pages/SecurityPage.jsx'
import logo from '../assets/logo.png'

const { Header, Content, Sider } = Layout
const { Text } = Typography

// Preset rapidi predefiniti: combinazioni comuni applicabili con un clic (oltre a quelli salvati).
const QUICK_PRESETS = [
  { key: 'problems', labelKey: 'filter.problemsOnly', filters: { problemsOnly: true } },
  { key: 'cron', labelKey: 'filter.schedule.cron', filters: { scheduleFilter: 'cron' } },
  { key: 'ondemand', labelKey: 'filter.schedule.ondemand', filters: { scheduleFilter: 'ondemand' } },
  { key: 'idle', labelKey: 'preset.quick.idle', filters: { statusFilter: ['idle'] } },
  { key: 'untracked', labelKey: 'filter.tf.unmanaged', filters: { managedFilter: 'unmanaged' } },
]

// Navigazione, in GRUPPI. Ogni voce dichiara anche:
//  · `fields`  → quali filtri hanno senso su quella pagina (valore, o funzione della query string
//                quando dipende dalla scheda aperta: sui Costi la regione non filtra niente, sugli
//                Sprechi sì, e una barra con filtri inerti insegna a diffidare di tutti gli altri);
//  · `surfaces`→ le superfici lato server che servono per mostrarla. Vuoto = sempre visibile; più di
//                una (le pagine fuse) = basta che UNA sia concessa, con le schede negate nascoste.
const NAV = [
  // Fuori dai gruppi: non è un argomento, è la risposta alla domanda che viene prima di tutte.
  { to: '/', key: 'now', icon: <ThunderboltOutlined />, fields: ['account'], surfaces: [] },
  {
    group: 'runtime',
    items: [
      { to: '/servizi', key: 'services', icon: <AppstoreOutlined />, fields: FILTER_FIELDS_FULL, surfaces: ['dashboard'] },
      // Esecuzioni: solo Account. Regione e tipo non filtrano una run (il cron ha già la sua regione),
      // e una barra con filtri inerti fa dubitare di tutti gli altri.
      { to: '/esecuzioni', key: 'runs', icon: <FieldTimeOutlined />, fields: ['account'], surfaces: [] },
      // Topologia: solo Account, e nemmeno quello serve granché, la pagina ha il suo selettore
      // d'ambiente. Gli altri filtri (tipo, stato, nome) su una MAPPA fanno danno: nascondono membri di
      // un gruppo senza dirlo, e il conteggio del box diventa una mezza verità.
      { to: '/topologia', key: 'topology', icon: <PartitionOutlined />, fields: ['account'], surfaces: ['topology'] },
    ],
  },
  {
    group: 'releases',
    items: [
      // Deploy: solo Account. Non la Regione — una build di deploy non ha regione (il filtro era lì
      // senza filtrare niente, e una barra con filtri inerti fa pensare che siano rotti tutti).
      { to: '/deploy', key: 'deploys', icon: <RocketOutlined />, fields: ['account'], surfaces: ['deploys'] },
    ],
  },
  {
    group: 'spend',
    items: [
      // Costi: solo Account. Non la Regione — Cost Explorer è globale e la nostra query non raggruppa
      // per regione, quindi quel filtro non filtrava i costi: faceva sparire l'account. Sugli Sprechi
      // (scheda `?tab=sprechi`) la regione filtra davvero: le risorse orfane sono regionali.
      {
        to: '/spesa',
        key: 'spend',
        icon: <PieChartOutlined />,
        fields: (search) => (new URLSearchParams(search).get('tab') === 'sprechi' ? FILTER_FIELDS_ACCOUNT : ['account']),
        surfaces: ['costs', 'waste'],
        tabs: { costs: 'costs', waste: 'waste' },
      },
      {
        to: '/limiti',
        key: 'limits',
        icon: <DashboardOutlined />,
        fields: (search) => (new URLSearchParams(search).get('tab') === 'freetier' ? [] : FILTER_FIELDS_ACCOUNT),
        surfaces: ['quotas', 'freetier'],
        tabs: { quotas: 'quotas', freetier: 'freetier' },
      },
    ],
  },
  {
    group: 'security',
    items: [
      { to: '/sicurezza', key: 'security', icon: <AlertOutlined />, fields: [], surfaces: ['security'] },
      { to: '/iam', key: 'iam', icon: <SafetyOutlined />, fields: [], surfaces: ['iam'] },
    ],
  },
]

// Tutte le voci, gruppi appiattiti: serve per risolvere il percorso corrente in una voce.
const NAV_ITEMS = NAV.flatMap((g) => (g.group ? g.items : [g]))

// I percorsi di prima continuano a funzionare: link salvati, segnalibri e i deep-link che le pagine
// si scambiano. Una riorganizzazione che rompe gli URL fa sembrare rotta l'applicazione.
const REDIRECTS = {
  '/costi': '/spesa',
  '/sprechi': '/spesa?tab=sprechi',
  '/quote': '/limiti',
  '/freetier': '/limiti?tab=freetier',
}

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0) // +1 a ogni "Aggiorna": forza il refresh delle pagine con fetch proprio (Deploy)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [driftOpen, setDriftOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const [health, setHealth] = useState(null) // #6 meta-salute (raggiungibilità account)
  // Una superficie sola per servizio: il nome + QUALE scheda mostrare (panoramica/log/eventi). Le
  // icone in tabella e nelle card non aprono più un secondo drawer sopra il primo: aprono questo,
  // già sulla scheda giusta.
  const [detailTab, setDetailTab] = useState('overview')
  const [paletteOpen, setPaletteOpen] = useState(false) // ⌘K ricerca globale servizi
  // Servizio aperto nel pannello: identificato da account+nome (serviceKey), non dal nome. `tab`
  // omesso = lascia la scheda dov'era (aprire una riga non ti riporta in Panoramica).
  const [detailKey, setDetailKey] = useState(null)
  const openDetail = (service, tab) => {
    if (tab) setDetailTab(tab)
    setDetailKey(service ? serviceKey(service) : null)
  }
  const [dark, setDark] = useState(() => localStorage.getItem('opsdash-dark') === '1')
  // Sidebar chiusa/aperta: è una preferenza di chi guarda (su un portatile lo spazio orizzontale è
  // quello che manca), quindi persiste — riaprirla a ogni ricarica è una piccola offesa quotidiana.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('dadaguard-nav-collapsed') === '1')
  // preferenza lingua salvata (it|en|null); se null → default per modalità (vedi resolveLang)
  const [langPref, setLangPref] = useState(() => localStorage.getItem('dadaguard-lang'))

  // Filtri: account singolo (switch) + region/type/status multi. Lo stato vive qui e persiste
  // mentre si naviga tra le pagine; ogni pagina mostra solo il sottoinsieme di controlli sensato.
  // Elenco, non un valore singolo: «vuoto = tutti» (vedi web/filters.js). Regione, tipo e stato erano
  // già così; l'account no, ed era l'unico filtro che non si potesse aprire su due ambienti insieme —
  // che è la domanda normale qui (staging E produzione, non uno dei due).
  const [accountFilter, setAccountFilter] = useState([])
  const [regionFilter, setRegionFilter] = useState([])
  const [typeFilter, setTypeFilter] = useState([])
  const [statusFilter, setStatusFilter] = useState([]) // multi: up/degraded/down/idle/disabled…
  const [scheduleFilter, setScheduleFilter] = useState('all') // all | cron | ondemand
  const [managedFilter, setManagedFilter] = useState('all') // all | managed | unmanaged (Terraform)
  const [nameQuery, setNameQuery] = useState('')
  const [problemsOnly, setProblemsOnly] = useState(false) // scorciatoia: solo degraded/down

  useEffect(() => {
    localStorage.setItem('opsdash-dark', dark ? '1' : '0')
    // La classe sulla radice serve al foglio di stile: i token antd arrivano via JS, ma le neutre
    // scritte a mano (bordi, righe alternate, tracce) non si possono derivare: in scuro un bordo al
    // 6% sparisce. Senza questo aggancio, metà dell'app cambia tema e metà no.
    document.documentElement.classList.toggle('dg-dark', dark)
  }, [dark])

  useEffect(() => {
    localStorage.setItem('dadaguard-nav-collapsed', collapsed ? '1' : '0')
  }, [collapsed])

  // ⌘K / Ctrl+K → apre la palette di ricerca globale dei servizi.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])


  // Lingua effettiva: preferenza salvata, altrimenti IT in locale / lingua browser in cloud.
  const lang = resolveLang(langPref, data?.mode)
  const t = useMemo(() => makeT(lang), [lang])
  const setLang = useCallback((l) => {
    localStorage.setItem('dadaguard-lang', l)
    setLangPref(l)
  }, [])

  // `fresh`: il bottone «Aggiorna» salta la cache breve del server. Un aggiornamento che restituisce
  // la risposta di prima non è un aggiornamento.
  const load = useCallback(
    async (signal, { fresh = false } = {}) => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/status?lang=${lang}${fresh ? '&fresh=1' : ''}`, { signal })
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

  // Riceve il SERVIZIO, non il suo nome: la voce di services.yaml da cancellare si sceglie con
  // l'identità della risorsa, perché due voci omonime sono due monitoraggi diversi e cancellare
  // quella sbagliata è una scrittura che dalla dashboard non si annulla.
  const removeService = useCallback(
    async (service) => {
      const target = typeof service === 'string' ? { name: service } : service
      try {
        const res = await fetch('/api/watchlist/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: target?.name,
            account: target?.account?.key ?? target?.account,
            resourceId: target?.resourceId,
          }),
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

  // Auto-refresh della Dashboard (stato servizi) ogni 30s, SOLO quando sei sulla "/": in pausa a tab
  // nascosto, fetch immediato al rientro/focus. Le altre viste hanno il proprio polling (Deploy, 15s) o
  // restano manuali (Costi/Quote: chiamate care, es. Cost Explorer a pagamento).
  useEffect(() => {
    // Le due viste che vivono dello stato della flotta: "Adesso" (che lo mostra insieme al resto) e
    // "Servizi". Altrove le chiamate sono care o hanno un polling proprio (Deploy, 15s).
    if (location.pathname !== '/' && location.pathname !== '/servizi') return undefined
    const tick = () => {
      if (!document.hidden) {
        load()
        loadHealth()
      }
    }
    const timer = setInterval(tick, 30000)
    const onVisibility = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', tick)
    }
  }, [location.pathname, load, loadHealth])

  const services = data?.services ?? []
  const detailService = detailKey ? services.find((s) => serviceKey(s) === detailKey) : null
  const isCloud = data?.mode === 'cloud'
  const caps = data?.capabilities ?? { watchlist: !isCloud, discover: !isCloud, fullDrift: !isCloud }

  const accountOptions = useMemo(() => {
    const seen = new Map()
    // Prima dagli account risolti dal server: un account può avere spesa/quote e ZERO servizi
    // monitorati (il payer, dove vivono Bedrock e CodeBuild). Ricavando le opzioni dai soli servizi
    // quell'account non era selezionabile — e sulle pagine per-account spariva senza dirlo.
    for (const a of data?.accounts ?? []) seen.set(a.key, a.label)
    for (const s of services) {
      const key = s.account?.key ?? '__none__'
      if (!seen.has(key)) seen.set(key, s.account?.label ?? t('filter.noAccount'))
    }
    return [
      // Niente voce «Tutti»: in una select multipla sarebbe un valore selezionabile accanto agli altri
      // («Tutti + Staging» non significa niente). Vuoto = tutti, e lo dice il placeholder.
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
  const isCronSvc = Boolean(detailService && (detailService.checks?.runtime?.schedule || detailService.type === 'ecs-scheduled'))
  const logsDefaultMinutes = isCronSvc ? 2880 : 60
  const logsDefaultErrorsOnly = isCronSvc && detailService?.overall === 'down'

  const groups = useMemo(() => {
    const q = nameQuery.trim().toLowerCase()
    const filtered = services.filter((s) => {
      const cron = Boolean(s.checks?.runtime?.schedule)
      return (
        matchesAny(s.account?.key ?? '__none__', accountFilter) &&
        (regionFilter.length === 0 || regionFilter.includes(s.region)) &&
        (typeFilter.length === 0 || typeFilter.includes(s.type)) &&
        (statusFilter.length === 0 || statusFilter.includes(s.overall)) &&
        (scheduleFilter === 'all' || (scheduleFilter === 'cron') === cron) &&
        (managedFilter === 'all' ||
          (managedFilter === 'managed' ? s.managed === true : s.managed === false)) &&
        (!q || s.name.toLowerCase().includes(q) || displayName(s).toLowerCase().includes(q)) &&
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

  // La lista piatta dei servizi filtrati, con identità STABILE. Ricrearla inline a ogni render
  // (`groups.flatMap(...)`) invalidava i `useMemo` di chi la riceve: la Topologia rifaceva il layout
  // del grafo a ogni battuta nel campo di ricerca, perdendo zoom e trascinamenti.
  const flatServices = useMemo(() => groups.flatMap((g) => g.services), [groups])

  // Account (per label) dopo il filtro servizi completo → per la Topologia (che filtra i servizi).
  const visibleLabels = useMemo(() => new Set(groups.map((g) => g.label)), [groups])

  // Account visibili sulle pagine per-account (Costi/Sprechi/Quote): si applica SOLO il filtro
  // Account. Non il tipo/stato/schedule (sono filtri di servizi, non di account) e nemmeno la
  // REGIONE: quelle pagine non sono per-regione — i costi di Cost Explorer sono globali — e
  // filtrarle per regione faceva sparire l'intero account, non le sue righe di una certa regione.
  //
  // La lista parte dagli ACCOUNT risolti, non dai servizi: un account con spesa e zero servizi
  // monitorati (il payer) altrimenti non compariva affatto, senza un messaggio che lo dicesse.
  const aggregateLabels = useMemo(() => {
    // `null` = NON filtrare. Va distinto da "un insieme vuoto", che invece nasconde tutto: finché lo
    // stato della flotta non è arrivato (e con decine di servizi da controllare sono secondi) la lista
    // degli account è vuota, e un filtro vuoto faceva scrivere «Nessun account configurato» sulla
    // pagina Costi — una bugia, mentre i costi erano già lì. Stesso principio del resto: assente e
    // vuoto sono cose diverse, e confonderle fa affermare il falso.
    if (!data) return null
    const all = data.accounts?.length
      ? data.accounts.map((a) => ({ key: a.key, label: a.label }))
      : services.map((svc) => ({ key: svc.account?.key ?? '__none__', label: svc.account?.label ?? t('filter.noAccount') }))
    if (all.length === 0) return null // nessuna lista da cui filtrare: meglio mostrare tutto che niente
    const out = new Set()
    for (const a of all) {
      if (!matchesAny(a.key, accountFilter)) continue
      out.add(a.label)
    }
    return out
  }, [services, data, accountFilter, t])

  const filtersActive =
    isFiltering(accountFilter) ||
    regionFilter.length > 0 ||
    typeFilter.length > 0 ||
    statusFilter.length > 0 ||
    scheduleFilter !== 'all' ||
    managedFilter !== 'all' ||
    nameQuery.trim() !== '' ||
    problemsOnly
  const resetFilters = useCallback(() => {
    setAccountFilter([])
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
    setAccountFilter(asList(f.accountFilter))
    setRegionFilter(asList(f.regionFilter))
    setTypeFilter(asList(f.typeFilter))
    setStatusFilter(asList(f.statusFilter))
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

  const themeConfig = antdTheme(dark ? theme.darkAlgorithm : theme.defaultAlgorithm, dark)

  const activeNav = NAV_ITEMS.find((n) => n.to === location.pathname) ?? NAV_ITEMS[0]
  // `fields` può dipendere dalla scheda aperta (Spesa: Costi vs Sprechi) → può essere una funzione.
  const activeFields = typeof activeNav.fields === 'function' ? activeNav.fields(location.search) : activeNav.fields

  // La navigazione nasconde le superfici a cui il ruolo assunto non ha accesso (deciso lato server via
  // SimulatePrincipalPolicy → health.surfaces): 'denied' = negato in tutti gli account → via.
  // 'allowed'/'unknown'/assente (selfcheck non ancora arrivato) → mostra: default sicuro, mai una
  // sidebar vuota. Le rotte restano montate: un deep-link a una pagina nascosta funziona comunque.
  const surfaces = health?.surfaces
  const allowed = useCallback((keys = []) => keys.length === 0 || keys.some((k) => surfaces?.[k] !== 'denied'), [surfaces])
  // Una pagina fusa resta visibile se almeno una scheda è concessa; le schede negate non compaiono.
  const tabsOf = useCallback((item) => Object.keys(item.tabs ?? {}).filter((k) => surfaces?.[item.tabs[k]] !== 'denied'), [surfaces])
  const visibleNav = useMemo(
    () =>
      NAV.map((g) => (g.group ? { ...g, items: g.items.filter((i) => allowed(i.surfaces)) } : g))
        .filter((g) => (g.group ? g.items.length > 0 : allowed(g.surfaces))),
    [allowed],
  )

  const filterProps = {
    fields: activeFields,
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
          className="dg-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: SPACE.xl,
            height: 'auto',
            lineHeight: 'normal',
            paddingBlock: SPACE.sm,
            background: dark ? 'rgba(27,27,31,0.86)' : 'rgba(255,255,255,0.86)',
            borderBottom: '1px solid var(--dg-line)',
            gap: SPACE.md,
            flexWrap: 'wrap',
          }}
        >
          <Space>
            <Button
              type="text"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((c) => !c)}
              title={t(collapsed ? 'nav.expand' : 'nav.collapse')}
            />
            <img src={logo} alt="Dadaguard" style={{ width: 30, height: 30, borderRadius: 8, display: 'block' }} />
            <div style={{ lineHeight: 1.15 }}>
              <div style={{ fontSize: FONT.lead, fontWeight: 600, letterSpacing: '-0.01em' }}>Dadaguard</div>
              <Text type="secondary" style={{ fontSize: FONT.micro }}>
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
                load(undefined, { fresh: true })
                loadHealth()
                setRefreshKey((k) => k + 1)
              }}
            >
              {t('btn.refresh')}
            </Button>
          </Space>
        </Header>

        <Layout>
          <Sider
            width={216}
            collapsed={collapsed}
            collapsedWidth={56}
            theme={dark ? 'dark' : 'light'}
            // Sotto `lg` la sidebar si chiude da sola: su uno schermo stretto 216px di navigazione
            // sono metà della pagina, e questa è una dashboard che si guarda, non un menu.
            breakpoint="lg"
            onBreakpoint={(broken) => setCollapsed(broken)}
            style={{ background: 'transparent', borderInlineEnd: '1px solid var(--dg-line)', paddingTop: SPACE.sm }}
          >
            <SideNav groups={visibleNav} active={activeNav.to} onPick={(to) => navigate(to)} collapsed={collapsed} t={t} />
          </Sider>

          <Content className="dg-page" style={{ padding: `${SPACE.xl}px ${SPACE.xl}px ${SPACE.xxl}px`, minWidth: 0 }}>
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

            {/* La barra dei filtri ha bisogno dei dati (le opzioni vengono dagli account e dai servizi),
                ma il suo SPAZIO no: senza riservarlo, quando lo stato della flotta arriva — e sulla flotta
                vera sono secondi, perché esegue i controlli di tutti i servizi — la barra compare e spinge
                giù l'intera pagina, facendo perdere il punto in cui si stava leggendo. */}
            {activeFields.length > 0 &&
              (data ? <FilterBar {...filterProps} /> : <FilterBarPlaceholder fields={activeFields} />)}

            <Routes>
              <Route
                path="/"
                element={
                  <NowPage
                    services={services}
                    // `data` presente = la flotta è stata letta almeno una volta. Il flag `loading`
                    // non basta: parte da `false`, e in quella finestra "vuoto" e "non guardato"
                    // sarebbero indistinguibili.
                    statusReady={Boolean(data)}
                    statusLoading={loading}
                    statusError={error}
                    refreshKey={refreshKey}
                    accountFilter={accountFilter}
                    t={t}
                    lang={lang}
                  />
                }
              />
              <Route
                path="/servizi"
                element={
                  <DashboardPage
                    data={data}
                    groups={groups}
                    allServices={services}
                    statusFilter={statusFilter}
                    onStatusFilter={setStatusFilter}
                    caps={caps}
                    loading={loading}
                    error={error}
                    onRemove={removeService}
                    onLogs={(s) => openDetail(s, 'logs')}
                    onEvents={(s) => openDetail(s, 'events')}
                    onOpen={(s) => openDetail(s)}
                    t={t}
                  />
                }
              />
              <Route
                path="/esecuzioni"
                element={<RunsPage t={t} lang={lang} refreshKey={refreshKey} accountFilter={accountFilter} />}
              />
              <Route path="/deploy" element={<DeploysPage t={t} lang={lang} refreshKey={refreshKey} accountFilter={accountFilter} />} />
              <Route
                path="/spesa"
                element={<SpendPage accountLabels={aggregateLabels} tabs={tabsOf(NAV_ITEMS.find((n) => n.key === 'spend'))} t={t} lang={lang} />}
              />
              <Route
                path="/limiti"
                element={<LimitsPage accountLabels={aggregateLabels} tabs={tabsOf(NAV_ITEMS.find((n) => n.key === 'limits'))} t={t} lang={lang} />}
              />
              <Route
                path="/topologia"
                element={
                  <TopologyPage
                    // La flotta INTERA, non quella filtrata dalla barra. La mappa disegna comunque tutto
                    // l'ambiente (i nodi arrivano dal grafo), quindi passandole la lista filtrata i
                    // servizi esclusi restavano sul disegno SENZA stato: pallino grigio e «stato non
                    // letto», che si legge «non lo guardiamo» mentre la verità era «l'hai filtrato via».
                    services={services}
                    filtriAttivi={filtersActive}
                    accountLabels={visibleLabels}
                    dark={dark}
                    // `data` presente = la flotta è stata letta almeno una volta. Serve a non scrivere
                    // «Nessun servizio» mentre i check sono ancora in volo: è una bugia, e su questa
                    // pagina si legge come «la topologia è vuota».
                    statusReady={Boolean(data)}
                    // Dalla mappa al servizio: la topologia dice DOVE guardare, e il passo dopo è
                    // guardarci. Senza questo salto si finiva a ricopiare il nome nella pagina Servizi.
                    onApriServizio={(s) => openDetail(s)}
                    t={t}
                  />
                }
              />
              <Route path="/iam" element={<IamPage services={services} t={t} lang={lang} />} />
              <Route path="/sicurezza" element={<SecurityPage t={t} lang={lang} />} />
              {/* I percorsi vecchi non muoiono: reindirizzano alla scheda giusta della pagina fusa. */}
              {Object.entries(REDIRECTS).map(([from, to]) => (
                <Route key={from} path={from} element={<Navigate to={to} replace />} />
              ))}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Content>
        </Layout>

        {/* Popup (azioni contestuali), montati una volta a livello app */}
        <DiscoverDrawer
          open={discoverOpen}
          onClose={() => setDiscoverOpen(false)}
          existingNames={services.map((s) => s.name)}
          onAdded={load}
          t={t}
        />
        <DriftDrawer open={driftOpen} onClose={() => setDriftOpen(false)} t={t} />
        <MetaHealthDrawer
          open={healthOpen}
          onClose={() => setHealthOpen(false)}
          health={health}
          accountLabels={aggregateLabels}
          t={t}
        />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          services={flatServices}
          onPick={(svc) => openDetail(svc, 'overview')}
          t={t}
        />
        <ServiceDetailDrawer
          service={detailService}
          tab={detailTab}
          onTab={setDetailTab}
          logsDefaultMinutes={logsDefaultMinutes}
          logsDefaultErrorsOnly={logsDefaultErrorsOnly}
          onClose={() => setDetailKey(null)}
          onNavigate={navigate}
          t={t}
          lang={lang}
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

// Sagoma della barra dei filtri: stessa altezza e stesso numero di controlli, in grigio. Serve solo a
// tenere il posto — i valori arrivano coi dati.
function FilterBarPlaceholder({ fields = [] }) {
  const widths = { name: 210, account: 150, type: 120, status: 120, region: 130, schedule: 170, managed: 140, problems: 40, presets: 96 }
  return (
    <Space style={{ marginBottom: 16 }} wrap size={8}>
      {fields.map((f) => (
        <Skeleton.Button key={f} active size="small" style={{ width: widths[f] ?? 120, height: 32 }} />
      ))}
    </Space>
  )
}
