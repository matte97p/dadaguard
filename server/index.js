import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getStatus, resolveServices, invalidateServicesCache, findService } from './status.js'
import { discover } from './discover.js'
import { loadConfig } from './config.js'
import { addServices, removeService } from './watchlist.js'
import { findWaste } from './waste.js'
import { getCosts, monthEndProjection, getCostTrend, getCostByComponent, getCostByCategory, COMPONENT_TAG, COST_CATEGORY } from './costs.js'
import { cached } from './util/ttlcache.js'
import { isQueryable } from './accounts.js'
import { listDeploys } from './deploys.js'
import { tabellaRilasci, daRilasciare, testoRilasci } from './rilasci.js'
import { cloudflareDeploysAccount } from './cloudflare.js'
import { wafOverview } from './waf.js'
import { budgetsOverview } from './budgets.js'
import { getFreeTierUsage } from './freetier.js'
import { deduceTopology } from './topology/deduce.js'
import { networkTopology } from './topology/network.js'
import { renderMetrics } from './metrics.js'
import { recentLogs } from './logs.js'
import { runsOverview } from './runsOverview.js'
import { listCrons } from './crons.js'
import { cronRunLogs } from './runs.js'
import { prefectRunLogs } from './prefect.js'
import { taskMetrics } from './taskMetrics.js'
import { recentEvents } from './events.js'
import { recentChanges } from './changes.js'
import { nearLimitQuotas } from './quotas.js'
import { selfCheck } from './selfcheck.js'
import { publicUrlFromHeaders } from './exposure.js'
import { listLayers, startPlan, getJob } from './driftFull.js'
import { isCloud, MODE, isDemo } from './mode.js'
import { cleanAwsReason } from './runtime/awsClient.js'
import { makeT } from './i18n.js'
import { demoStatus, demoCosts, demoCostTrend, demoCostComponents, demoCostCategories, demoApplyType, demoApplyTypeComponents, demoQuotas, demoFreeTier, demoLogs, demoEvents, demoSelfcheck, demoTopology, demoIamPolicies, demoIamPolicy, demoIamAccess, demoSecurity, demoSsoAccess, demoDeploys, demoTaskMetrics, demoWaf, demoBudgets, demoWaste, demoRuns, demoRunLogs } from './demo.js'
import { listPolicies, policyDetail, accessToResource } from './iam.js'
import { collectFindings } from './security.js'
import { ssoAccess, ssoAccessToResource } from './sso.js'
import { log } from './log.js'
import { startWatcher } from './notify/watch.js'

const PORT = process.env.PORT ?? 3001
const app = express()
app.use(express.json())

// Guard per le funzioni SOLO local-first (scrivono file o usano il repo Terraform locale).
// In cloud (read-only) rispondono 409 con messaggio chiaro, invece di fallire in modo opaco.
const requireLocal = (feature) => (_req, res, next) => {
  if (isCloud) return res.status(409).json({ error: `"${feature}" è disponibile solo in modalità local-first` })
  next()
}

// Liveness dell'app (container/orchestratori): NON chiama AWS, conferma solo che il server è su.
app.get('/healthz', (_req, res) => res.json({ ok: true, mode: MODE }))

// Esposizione Prometheus: severità per servizio/check → Grafana/Alertmanager fanno alert e storico,
// senza che Dadaguard diventi un servizio. Cache breve: Prometheus scrapa spesso, evitiamo di
// martellare AWS a ogni scrape (il /api/status della dashboard resta invece live).
let metricsCache = { at: 0, body: '' }
const METRICS_TTL = 30000
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4')
  try {
    if (metricsCache.body && Date.now() - metricsCache.at < METRICS_TTL) return res.send(metricsCache.body)
    const body = renderMetrics(isDemo ? demoStatus('en') : await getStatus('en'))
    metricsCache = { at: Date.now(), body }
    res.send(body)
  } catch (err) {
    res.status(500).send(`# scrape failed: ${err.message}\ndadaguard_scrape_success 0\n`)
  }
})

// Cache breve dello stato. Un giro completo costa ~4-5s (52 servizi × 8 check su 4 account: le
// metriche CloudWatch e CloudTrail sono la parte grossa), e finora OGNI apertura di pagina lo rifaceva
// da zero — anche due schede aperte, anche due persone insieme. I dati guardano finestre di 24h: 30
// secondi di età non cambiano una diagnosi, e l'età è comunque scritta in pagina («ultimo fetch»).
// Stesso mestiere che /metrics fa già da tempo.
// `?fresh=1` la salta: il bottone «Aggiorna» deve poter dire la verità, altrimenti aggiorna niente.
const STATUS_TTL_MS = Number(process.env.DADAGUARD_STATUS_TTL_MS ?? 30_000)
const statusCache = new Map() // lingua → { at, payload }

app.get('/api/status', async (req, res) => {
  try {
    if (isDemo) return res.json(demoStatus(req.query.lang))
    const lang = req.query.lang ?? 'it'
    const fresh = req.query.fresh === '1'
    const hit = statusCache.get(lang)
    if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) {
      // `cached: true` è dichiarato: chi legge l'API sa che non è un giro nuovo.
      return res.json({ ...hit.payload, cached: true })
    }
    const payload = await getStatus(lang)
    statusCache.set(lang, { at: Date.now(), payload })
    res.json(payload)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// #6 meta-salute: Dadaguard riesce a raggiungere/assumere ogni account? (STS, read-only)
app.get('/api/selfcheck', async (req, res) => {
  try {
    if (isDemo) return res.json(demoSelfcheck())
    const cfg = loadConfig()
    // Guardiano esposizione SOLO in cloud: in locale l'app gira su localhost senza Access davanti,
    // sondarla darebbe un falso "ESPOSTA". URL pubblico dedotto dall'header (via Cloudflare) →
    // zero-config; override opzionale da config/env se servisse forzarlo.
    const publicUrl = isCloud
      ? publicUrlFromHeaders(req.headers, cfg.publicUrl ?? process.env.DADAGUARD_PUBLIC_URL ?? null)
      : null
    res.json(await selfCheck(cfg.accounts, makeT(req.query.lang), publicUrl))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/accounts', (_req, res) => {
  const { accounts } = loadConfig()
  res.json(
    Object.entries(accounts).map(([key, a]) => ({
      key,
      label: a.label ?? key,
      color: a.color ?? null,
    })),
  )
})

// Discovery: lista le risorse di un account. Local-first (a valle alimenta la watchlist su file).
app.get('/api/discover', requireLocal('Scopri servizi'), async (req, res) => {
  try {
    const { accounts } = loadConfig()
    const accountKey = req.query.account
    const acct = accountKey ? accounts[accountKey] : null
    const profile = req.query.profile || acct?.profile
    const region = req.query.region || acct?.region
    const stateBucket = acct?.terraform?.stateBucket
    if (!profile && !acct?.roleArn) return res.status(400).json({ error: 'account/profile mancante' })

    const result = await discover({
      profile,
      roleArn: acct?.roleArn,
      externalId: acct?.externalId,
      region,
      stateBucket,
      activeDays: req.query.activeDays ? Number(req.query.activeDays) : 30,
      exclude: req.query.exclude || undefined,
      all: req.query.all === 'true',
    })
    res.json({ account: accountKey ?? null, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// #10 Sprechi: risorse orfane costose per ambiente (read-only EC2). On-demand.
app.get('/api/waste', async (req, res) => {
  try {
    if (isDemo) return res.json(demoWaste())
    const t = makeT(req.query.lang)
    const { accounts } = loadConfig()
    const out = {}
    await Promise.all(
      Object.entries(accounts).map(async ([key, a]) => {
        if (!isQueryable(a)) return
        try {
          out[key] = {
            label: a.label ?? key,
            color: a.color ?? null,
            ...(await findWaste({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: a.region, ignore: a.wasteIgnore })),
          }
        } catch (err) {
          out[key] = { label: a.label ?? key, error: cleanAwsReason(err, t) }
        }
      }),
    )
    res.json(out)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Cost Explorer si paga a chiamata e si aggiorna poche volte al giorno: un'ora di cache non perde
// niente di reale e evita di ripagare la stessa risposta a ogni apertura della pagina.
const COSTS_TTL = 60 * 60 * 1000

// Costi: spesa MTD per servizio AWS, per account. On-demand (Cost Explorer è a pagamento).
app.get('/api/costs', async (req, res) => {
  try {
    if (isDemo) return res.json(demoApplyType(demoCosts(), req.query.type))
    const t = makeT(req.query.lang)
    const { accounts } = loadConfig()
    const month = req.query.month // 'YYYY-MM' opzionale (default: mese corrente)
    const type = req.query.type // filtro Cost Category (es. 'database'); assente/'all' = tutto
    const out = {}
    await Promise.all(
      Object.entries(accounts).map(async ([key, a]) => {
        if (!isQueryable(a)) return
        try {
          const cost = await cached(`costs:${key}:${month ?? 'now'}:${type ?? 'all'}`, COSTS_TTL, () =>
            getCosts({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, month, accountId: a.accountId, type }),
          )
          // Proiezione di fine mese: run-rate deterministico sui giorni trascorsi (niente ML/GetCostForecast,
          // niente chiamata extra a pagamento né permesso in più). `null` per un mese già chiuso → la UI la
          // mostra solo sul mese corrente.
          out[key] = { label: a.label ?? key, color: a.color ?? null, ...cost, projection: monthEndProjection(cost) }
        } catch (err) {
          out[key] = { label: a.label ?? key, error: cleanAwsReason(err, t) }
        }
      }),
    )
    res.json(out)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Trend costi: 13 mesi, consumo a listino vs fatturato (dopo crediti e tasse). Una chiamata a Cost
// Explorer per account copre tutti i mesi. Non dipende dal mese selezionato → cache a parte.
app.get('/api/costs/trend', async (req, res) => {
  try {
    if (isDemo) return res.json(demoCostTrend())
    const t = makeT(req.query.lang)
    const { accounts } = loadConfig()
    const months = Math.min(24, Math.max(3, Number(req.query.months) || 13))
    const type = req.query.type
    const out = {}
    await Promise.all(
      Object.entries(accounts).map(async ([key, a]) => {
        if (!isQueryable(a)) return
        try {
          const trend = await cached(`trend:${key}:${months}:${type ?? 'all'}`, COSTS_TTL, () =>
            getCostTrend({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, accountId: a.accountId, months, type }),
          )
          out[key] = { label: a.label ?? key, color: a.color ?? null, ...trend }
        } catch (err) {
          out[key] = { label: a.label ?? key, error: cleanAwsReason(err, t) }
        }
      }),
    )
    res.json(out)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Costi per COMPONENTE (tag di allocazione costi): "di chi è questa spesa", non solo "quale servizio
// AWS". Se il tag non è attivato in Billing, Cost Explorer risponde tutto non-taggato: lo diciamo.
app.get('/api/costs/components', async (req, res) => {
  try {
    if (isDemo) return res.json(demoApplyTypeComponents(demoCostComponents(), req.query.type))
    const t = makeT(req.query.lang)
    const { accounts } = loadConfig()
    const month = req.query.month
    const type = req.query.type
    const out = {}
    await Promise.all(
      Object.entries(accounts).map(async ([key, a]) => {
        if (!isQueryable(a)) return
        try {
          const byComp = await cached(`components:${key}:${month ?? 'now'}:${type ?? 'all'}`, COSTS_TTL, () =>
            getCostByComponent({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, accountId: a.accountId, month, type }),
          )
          out[key] = { label: a.label ?? key, color: a.color ?? null, ...byComp }
        } catch (err) {
          out[key] = { label: a.label ?? key, error: cleanAwsReason(err, t), tagKey: COMPONENT_TAG }
        }
      }),
    )
    res.json(out)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Costi per LIVELLO (Cost Category): è il "type" della pagina di analytics. Doppio scopo — la
// ripartizione da mostrare e i valori per il menu del filtro, senza una chiamata in più solo per
// sapere quali livelli esistono.
app.get('/api/costs/categories', async (req, res) => {
  try {
    if (isDemo) return res.json(demoCostCategories())
    const t = makeT(req.query.lang)
    const { accounts } = loadConfig()
    const month = req.query.month
    const out = {}
    await Promise.all(
      Object.entries(accounts).map(async ([key, a]) => {
        if (!isQueryable(a)) return
        try {
          const byCat = await cached(`categories:${key}:${month ?? 'now'}`, COSTS_TTL, () =>
            getCostByCategory({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, accountId: a.accountId, month }),
          )
          out[key] = { label: a.label ?? key, color: a.color ?? null, ...byCat }
        } catch (err) {
          out[key] = { label: a.label ?? key, error: cleanAwsReason(err, t), categoryName: COST_CATEGORY }
        }
      }),
    )
    res.json(out)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Deploy: build CodeBuild dei progetti `acme-*-*-deploy` per account — cosa sta uscendo ORA + gli
// ultimi. On-demand, read-only. Stessa forma per-account di /api/costs (label/color + payload).
// I deploy per account, una volta sola: la usano sia `/api/deploys` (la vista) sia `/api/rilasci`
// (staging contro produzione). Estratta dall'handler perché due endpoint che rifanno lo stesso giro
// CodeBuild sono due giri di rete per lo stesso dato.
async function deploysPerAccount(t) {
  // Account EFFETTIVI (config + org auto-discovery), come le altre viste per-account — così i
  // deploy coprono TUTTI gli account risolti (management/security inclusi), senza elencarli a mano.
  const { accounts } = await resolveServices()
  const out = {}
  await Promise.all(
    Object.entries(accounts).map(async ([key, a]) => {
      if (!isQueryable(a)) return
      try {
        const { builds, noProjects } = await listDeploys({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: a.region })
        out[key] = { label: a.label ?? key, color: a.color ?? null, builds, noProjects: !!noProjects }
      } catch (err) {
        out[key] = { label: a.label ?? key, error: cleanAwsReason(err, t) }
      }
    }),
  )
  // Cloudflare: se c'è un token (env o wrangler), aggiungi i deploy dei Worker come sezione a parte.
  // Nessun token → cloudflareDeploysAccount ritorna null e la sezione non compare.
  try {
    const cf = await cloudflareDeploysAccount()
    if (cf) out.cloudflare = cf
  } catch (err) {
    out.cloudflare = { label: 'Cloudflare', color: '#f6821f', provider: 'cloudflare', error: err.message }
  }
  return out
}

app.get('/api/deploys', async (req, res) => {
  try {
    if (isDemo) return res.json(demoDeploys())
    res.json(await deploysPerAccount(makeT(req.query.lang)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// «La mia modifica è già in produzione?». Riusa /api/deploys (stesso giro AWS, nessuna chiamata in
// più) e mette staging e produzione AFFIANCATI per servizio, più la coda del non rilasciato.
// `?format=testo` risponde in testo piatto: serve al terminale (`curl`) e a una skill, che con il JSON
// dovrebbero rifare a mano l'unica cosa che questa vista sa fare.
app.get('/api/rilasci', async (req, res) => {
  try {
    const perAccount = isDemo ? demoDeploys() : await deploysPerAccount(makeT(req.query.lang))
    const righe = tabellaRilasci(perAccount)
    if (req.query.format === 'testo') return res.type('text/plain').send(testoRilasci(righe))
    res.json({ righe, daRilasciare: daRilasciare(righe) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Free Tier: uso vs limite mensile (es. CodeBuild 100 build-min). Dato org-wide → una sola chiamata
// dal payer (identità `org` del config, o catena di default se Dadaguard gira nel payer). On-demand.
app.get('/api/freetier', async (req, res) => {
  if (isDemo) return res.json(demoFreeTier())
  const t = makeT(req.query.lang)
  try {
    const { accounts, org, freeTierAccount } = loadConfig()
    // Il Free Tier è org-wide, leggibile dal payer. Priorità creds: account indicato da `freeTierAccount`
    // (es. il payer, con il suo profilo/roleArn) → identità `org` → catena di default (in cloud = task role).
    const acct = freeTierAccount ? accounts[freeTierAccount] : null
    const creds = acct
      ? { profile: acct.profile, roleArn: acct.roleArn, externalId: acct.externalId }
      : org
        ? { profile: org.profile, roleArn: org.callerRoleArn, externalId: org.externalId }
        : {}
    res.json(await getFreeTierUsage(creds))
  } catch (err) {
    // errore leggibile in-body (200), come le card per-account: la pagina mostra il motivo, non "HTTP 500"
    res.json({ items: [], error: cleanAwsReason(err, t) })
  }
})

// Budget AWS per account + anomalie di costo org-wide: se la spesa è dentro o fuori da quello che
// avevamo deciso, e cosa è cambiato di colpo. On-demand, read-only, cachato (dati che AWS aggiorna
// poche volte al giorno).
app.get('/api/budgets', async (req, res) => {
  if (isDemo) return res.json(demoBudgets())
  const t = makeT(req.query.lang)
  try {
    const { accounts } = await resolveServices()
    const { org } = loadConfig()
    // Le anomalie sono org-wide e si chiedono dal payer, come il Free Tier: identità `org`, o la
    // catena di default (in cloud = task role, che gira nel payer).
    const orgCreds = org ? { profile: org.profile, roleArn: org.callerRoleArn, externalId: org.externalId } : {}
    res.json(await budgetsOverview(accounts, { orgCreds, isQueryable, cleanReason: (err) => cleanAwsReason(err, t), lang: req.query.lang ?? '' }))
  } catch (err) {
    res.json({ accounts: {}, anomalies: [], error: cleanAwsReason(err, t) })
  }
})

// Topologia: dipendenze DEDOTTE dai segnali AWS (env Lambda, event source, security group),
// senza config. On-demand (apertura del drawer) → non rallenta la dashboard. Read-only; i valori
// delle env var sono usati solo per il match e non escono mai dal server.
app.get('/api/topology', async (_req, res) => {
  try {
    if (isDemo) return res.json(demoTopology())
    const { accounts, services } = await resolveServices()
    // CACHE lunga, e non è pigrizia: questo giro legge le env var di ogni Lambda, i target group di ogni
    // ALB e i security group di ogni servizio — decine di chiamate, ~10 secondi sulla flotta vera. La
    // topologia però cambia quando cambia l'INFRASTRUTTURA (un apply Terraform), non col traffico:
    // rifarla a ogni apertura di pagina significa far aspettare dieci secondi per un disegno identico.
    // Cinque minuti, e le aperture successive (anche di altre persone) sono immediate.
    res.json(await cached('topology', 300_000, () => deduceTopology(services, accounts)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Topologia di RETE: VPC → subnet → servizio + egress (NAT/IGW). On-demand (tab "Rete").
// Read-only; chi non sta in una VPC (es. Lambda non-VPC) finisce nel gruppo "senza VPC".
app.get('/api/network', async (_req, res) => {
  try {
    if (isDemo) return res.json({})
    const { accounts, services } = await resolveServices()
    res.json(await networkTopology(services, accounts))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// IAM policy explorer (read-only, on-demand): elenco policy customer-managed per account…
app.get('/api/iam/policies', async (req, res) => {
  try {
    if (isDemo) return res.json(demoIamPolicies())
    const { accounts } = await resolveServices()
    res.json(await listPolicies(accounts, makeT(req.query.lang)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// …e il dettaglio di una policy: chi la usa (ruoli/utenti/gruppi) + a cosa dà accesso.
app.get('/api/iam/policy', async (req, res) => {
  try {
    if (isDemo) return res.json(demoIamPolicy(req.query.arn))
    const { accounts } = await resolveServices()
    res.json(await policyDetail(accounts, req.query.account, req.query.arn))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Vista "per risorsa": chi accede a una risorsa (match sull'ARN) e con quali azioni.
app.get('/api/iam/access', async (req, res) => {
  try {
    if (isDemo) return res.json(demoIamAccess(req.query.needle))
    const { accounts } = await resolveServices()
    const [byPolicy, viaSso] = await Promise.all([
      accessToResource(accounts, req.query.account, req.query.needle),
      ssoAccessToResource(accounts, req.query.needle).catch(() => []),
    ])
    res.json({ needle: byPolicy.needle, matches: byPolicy.matches, ssoMatches: viaSso })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Vista "Accesso SSO": Identity Center → permission set → utenti/gruppi assegnati, per account.
app.get('/api/iam/sso', async (_req, res) => {
  try {
    if (isDemo) return res.json(demoSsoAccess())
    const { accounts } = await resolveServices()
    res.json(await ssoAccess(accounts))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Findings di sicurezza/governance aggregati (superficie pubblica, scadenze, secret, igiene IAM…).
app.get('/api/security', async (req, res) => {
  try {
    if (isDemo) return res.json(demoSecurity(req.query.lang))
    const { accounts, services } = await resolveServices()
    res.json(await collectFindings(accounts, services, req.query.lang))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// WAF Cloudflare: richieste FERMATE dal firewall nelle ultime ore, per zona e per regola. È traffico
// che non arriva ai servizi e che quindi non compare in nessun log applicativo: senza questa vista
// un blocco sbagliato si scopre solo quando qualcuno segnala a voce che "non funziona".
app.get('/api/waf', async (req, res) => {
  try {
    if (isDemo) return res.json(demoWaf())
    const hours = Math.min(Number(req.query.hours) || 24, 24 * 7)
    const out = await wafOverview({ hours })
    // Nessun token Cloudflare → integrazione spenta, non un errore: la UI non mostra la sezione.
    res.json(out ?? { disabled: true, zones: [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Log recenti di un servizio (on-demand, read-only): il "perché è rosso". Lambda/ECS o logGroup.
app.get('/api/logs', async (req, res) => {
  try {
    if (isDemo) return res.json(demoLogs())
    const { accounts, services } = await resolveServices()
    const svc = findService(services, req.query)
    if (!svc) return res.status(404).json({ error: 'servizio non trovato' })
    res.json(
      await recentLogs(svc, accounts, {
        errorsOnly: req.query.errorsOnly === 'true',
        // Log di UNA esecuzione: stream esatto + intervallo (vedi server/runs.js). Il pannello delle
        // esecuzioni li passa, quello dei log di servizio no e continua a leggere la finestra recente.
        stream: req.query.stream || null,
        from: req.query.from || null,
        to: req.query.to || null,
        // Health-check scartati per default: su un servizio HTTP sano sono ~90% del log e da soli
        // esaurirebbero il tetto di righe. Il pannello li rimette con un interruttore.
        skipHealth: req.query.skipHealth !== 'false',
        task: req.query.task || null, // una sola istanza (task ECS) invece di tutte
        // Numeri non numerici (`?minutes=abc`) tornano al default: passandoli avanti la finestra
        // diventa NaN e il pannello risponde "nessun evento", che è la bugia peggiore possibile qui.
        minutes: Number.isFinite(Number(req.query.minutes)) ? Number(req.query.minutes) : 60,
        limit: Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 100,
        t: makeT(req.query.lang),
      }),
    )
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ESECUZIONI dei cron: quali stanno girando adesso e com'è andata ognuna di quelle finite.
// Senza `cron` = vista d'insieme (poche run per cron); con `cron=<account>/<nome>` = storico profondo
// di quello. Read-only, TTL breve lato server (vedi runsOverview.js).
app.get('/api/runs', async (req, res) => {
  try {
    if (isDemo) return res.json(demoRuns(req.query.lang))
    const { accounts } = await resolveServices()
    const num = (v, d, max) => (Number.isFinite(Number(v)) ? Math.min(Number(v), max) : d)
    res.json(
      await runsOverview(accounts, {
        minutes: num(req.query.minutes, 1440, 43200), // fino a 30 giorni: è la retention dei log dei cron
        limit: num(req.query.limit, req.query.cron ? 25 : 6, 50),
        only: req.query.cron || null,
        t: makeT(req.query.lang),
      }),
    )
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// I log di UNA esecuzione. Il log group lo risolve il server dal cron: il client passa solo QUALE run.
app.get('/api/runs/logs', async (req, res) => {
  try {
    if (isDemo) return res.json(demoRunLogs(req.query))
    // Sorgente orchestratore: i log non stanno su CloudWatch (quel job può girare fuori da AWS).
    if (req.query.source === 'prefect') {
      const out = await prefectRunLogs(req.query.run, {})
      return res.json(out ?? { notApplicable: true })
    }
    const { accounts } = await resolveServices()
    const { crons } = await listCrons(accounts, { t: makeT(req.query.lang) })
    const cron = crons.find((c) => c.key === req.query.cron)
    if (!cron) return res.status(404).json({ error: 'cron non trovato' })
    const a = accounts[cron.account] ?? {}
    const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: cron.region ?? a.region }
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    res.json(
      await cronRunLogs(cron, aws, {
        runId: req.query.run || null,
        stream: req.query.stream || null,
        // Senza `from` si leggerebbe dall'epoca: la finestra di una run la conosce chi ha la riga, e
        // in mancanza si ricade sull'ultima ora — non su «tutto».
        from: num(req.query.from) ?? Date.now() - 3600_000,
        to: num(req.query.to),
        limit: num(req.query.limit) ?? 300,
        errorsOnly: req.query.errorsOnly === 'true',
        t: makeT(req.query.lang),
      }),
    )
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Metriche per ISTANZA di un servizio ECS (una riga per task), on-demand e read-only.
app.get('/api/task-metrics', async (req, res) => {
  try {
    if (isDemo) return res.json(demoTaskMetrics())
    const { accounts, services } = await resolveServices()
    const svc = findService(services, req.query)
    if (!svc) return res.status(404).json({ error: 'servizio non trovato' })
    res.json(
      await taskMetrics(svc, accounts, {
        minutes: Number.isFinite(Number(req.query.minutes)) ? Number(req.query.minutes) : 15,
        t: makeT(req.query.lang),
      }),
    )
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Service Quotas vicine al limite, per account (on-demand, read-only).
app.get('/api/quotas', async (req, res) => {
  try {
    if (isDemo) return res.json(demoQuotas())
    res.json(await nearLimitQuotas(loadConfig().accounts, makeT(req.query.lang)))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Eventi recenti di un servizio (on-demand, read-only): ECS/RDS/ASG — il "perché" testuale.
app.get('/api/events', async (req, res) => {
  try {
    if (isDemo) return res.json(demoEvents())
    const { accounts, services } = await resolveServices()
    const svc = findService(services, req.query)
    if (!svc) return res.status(404).json({ error: 'servizio non trovato' })
    // Eventi operativi (ECS/RDS/ASG) + modifiche CloudTrail (la "causa"), in parallelo.
    const t = makeT(req.query.lang)
    const [evt, chg] = await Promise.all([recentEvents(svc, accounts, { t }), recentChanges(svc, accounts, { t })])
    res.json({ ...evt, changes: chg.changes ?? null, changesError: chg.error })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// #6 drift COMPLETO (on-demand, esegue `terragrunt plan`). Job async.
app.get('/api/drift/layers', requireLocal('Drift completo'), (req, res) => {
  try {
    const { accounts } = loadConfig()
    const acct = accounts[req.query.account]
    if (!acct?.terraform?.repoDir) return res.json({ layers: [] })
    res.json({ layers: listLayers(acct.terraform.repoDir, acct.terraform.env || req.query.account) })
  } catch (err) {
    // readdirSync/listLayers può lanciare (permessi, path sparito): 500 JSON, non crash.
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/drift/run', requireLocal('Drift completo'), (req, res) => {
  try {
    const { accounts } = loadConfig()
    const acct = accounts[req.body?.account]
    if (!acct?.terraform?.repoDir)
      return res.status(400).json({ error: 'repoDir non configurato per questo account' })
    const jobId = startPlan({
      repoDir: acct.terraform.repoDir,
      env: acct.terraform.env || req.body.account,
      layer: req.body.layer,
    })
    res.json({ jobId })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.get('/api/drift/job/:id', (req, res) => {
  const job = getJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job non trovato' })
  res.json(job)
})

// Watchlist = services.yaml. Scrive SOLO il config locale, mai su AWS.
app.post('/api/watchlist/add', requireLocal('Watchlist'), (req, res) => {
  try {
    const added = addServices(req.body?.entries ?? [])
    invalidateServicesCache() // watchlist cambiata → ricalcola la lista al prossimo giro
    res.json({ added })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/watchlist/remove', requireLocal('Watchlist'), (req, res) => {
  try {
    const removed = removeService(req.body?.name)
    invalidateServicesCache()
    res.json({ removed })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Frontend buildato: in container/prod Express serve dist/ sulla STESSA porta delle API.
// In dev non esiste (ci pensa Vite su :5173), quindi questo blocco è inerte.
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
if (existsSync(DIST)) {
  // SPA: gli asset hashati (dist/assets/*) sono immutabili → cache lunga; index.html MAI in cache,
  // altrimenti dopo un deploy il browser tiene la HTML vecchia che punta al bundle JS vecchio.
  app.use(
    express.static(DIST, {
      setHeaders: (res, p) => {
        if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
        else if (/[\\/]assets[\\/]/.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      },
    }),
  )
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(join(DIST, 'index.html'))
  }) // SPA fallback
}

// Bind esplicito su IPv4 0.0.0.0: in container il default di Node può fare bind su
// :: (IPv6) non-dual-stack → un sidecar che chiama 127.0.0.1 non raggiunge l'app.
app.listen(PORT, '0.0.0.0', () => {
  log.info('dadaguard up', { port: Number(PORT), mode: MODE })
  // Watchdog: guarda la flotta a intervalli e avvisa su Slack quando qualcosa attraversa il confine
  // problema/non-problema. Parte solo se il webhook è configurato — senza, non fa nemmeno una
  // chiamata AWS. In demo non parte: non c'è niente di vero da sorvegliare.
  if (!isDemo) startWatcher()
})
