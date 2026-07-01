import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getStatus } from './status.js'
import { discover } from './discover.js'
import { loadConfig } from './config.js'
import { addServices, removeService } from './watchlist.js'
import { findWaste } from './waste.js'
import { getCosts } from './costs.js'
import { deduceTopology } from './topology/deduce.js'
import { networkTopology } from './topology/network.js'
import { renderMetrics } from './metrics.js'
import { recentLogs } from './logs.js'
import { recentEvents } from './events.js'
import { recentChanges } from './changes.js'
import { nearLimitQuotas } from './quotas.js'
import { selfCheck } from './selfcheck.js'
import { listLayers, startPlan, getJob } from './driftFull.js'
import { isCloud, MODE, isDemo } from './mode.js'
import { demoStatus, demoCosts, demoQuotas, demoLogs, demoEvents, demoSelfcheck } from './demo.js'
import { log } from './log.js'

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

app.get('/api/status', async (req, res) => {
  try {
    if (isDemo) return res.json(demoStatus(req.query.lang))
    res.json(await getStatus(req.query.lang))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// #6 meta-salute: Dadaguard riesce a raggiungere/assumere ogni account? (STS, read-only)
app.get('/api/selfcheck', async (_req, res) => {
  try {
    if (isDemo) return res.json(demoSelfcheck())
    res.json(await selfCheck(loadConfig().accounts))
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
app.get('/api/waste', async (_req, res) => {
  try {
    if (isDemo) return res.json({})
    const { accounts } = loadConfig()
    const out = {}
    await Promise.all(
      Object.entries(accounts).map(async ([key, a]) => {
        if (!a.profile && !a.roleArn) return
        try {
          out[key] = {
            label: a.label ?? key,
            color: a.color ?? null,
            ...(await findWaste({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: a.region })),
          }
        } catch (err) {
          out[key] = { label: a.label ?? key, error: err.message }
        }
      }),
    )
    res.json(out)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Costi: spesa MTD per servizio AWS, per account. On-demand (Cost Explorer è a pagamento).
app.get('/api/costs', async (req, res) => {
  try {
    if (isDemo) return res.json(demoCosts())
    const { accounts } = loadConfig()
    const month = req.query.month // 'YYYY-MM' opzionale (default: mese corrente)
    const out = {}
    await Promise.all(
      Object.entries(accounts).map(async ([key, a]) => {
        if (!a.profile && !a.roleArn) return
        try {
          out[key] = {
            label: a.label ?? key,
            color: a.color ?? null,
            ...(await getCosts({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, month })),
          }
        } catch (err) {
          out[key] = { label: a.label ?? key, error: err.message }
        }
      }),
    )
    res.json(out)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Topologia: dipendenze DEDOTTE dai segnali AWS (env Lambda, event source, security group),
// senza config. On-demand (apertura del drawer) → non rallenta la dashboard. Read-only; i valori
// delle env var sono usati solo per il match e non escono mai dal server.
app.get('/api/topology', async (_req, res) => {
  try {
    if (isDemo) return res.json({ edges: [], extraNodes: [] })
    const { accounts, services } = loadConfig()
    res.json(await deduceTopology(services, accounts))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Topologia di RETE: VPC → subnet → servizio + egress (NAT/IGW). On-demand (tab "Rete").
// Read-only; chi non sta in una VPC (es. Lambda non-VPC) finisce nel gruppo "senza VPC".
app.get('/api/network', async (_req, res) => {
  try {
    if (isDemo) return res.json({})
    const { accounts, services } = loadConfig()
    res.json(await networkTopology(services, accounts))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Log recenti di un servizio (on-demand, read-only): il "perché è rosso". Lambda/ECS o logGroup.
app.get('/api/logs', async (req, res) => {
  try {
    if (isDemo) return res.json(demoLogs())
    const { accounts, services } = loadConfig()
    const svc = services.find((s) => s.name === req.query.service)
    if (!svc) return res.status(404).json({ error: 'servizio non trovato' })
    res.json(
      await recentLogs(svc, accounts, {
        errorsOnly: req.query.errorsOnly === 'true',
        minutes: req.query.minutes ? Number(req.query.minutes) : 60,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      }),
    )
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Service Quotas vicine al limite, per account (on-demand, read-only).
app.get('/api/quotas', async (_req, res) => {
  try {
    if (isDemo) return res.json(demoQuotas())
    res.json(await nearLimitQuotas(loadConfig().accounts))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Eventi recenti di un servizio (on-demand, read-only): ECS/RDS/ASG — il "perché" testuale.
app.get('/api/events', async (req, res) => {
  try {
    if (isDemo) return res.json(demoEvents())
    const { accounts, services } = loadConfig()
    const svc = services.find((s) => s.name === req.query.service)
    if (!svc) return res.status(404).json({ error: 'servizio non trovato' })
    // Eventi operativi (ECS/RDS/ASG) + modifiche CloudTrail (la "causa"), in parallelo.
    const [evt, chg] = await Promise.all([recentEvents(svc, accounts, {}), recentChanges(svc, accounts, {})])
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
    res.json({ added: addServices(req.body?.entries ?? []) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/watchlist/remove', requireLocal('Watchlist'), (req, res) => {
  try {
    res.json({ removed: removeService(req.body?.name) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Frontend buildato: in container/prod Express serve dist/ sulla STESSA porta delle API.
// In dev non esiste (ci pensa Vite su :5173), quindi questo blocco è inerte.
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
if (existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get('*', (_req, res) => res.sendFile(join(DIST, 'index.html'))) // SPA fallback
}

// Bind esplicito su IPv4 0.0.0.0: in container il default di Node può fare bind su
// :: (IPv6) non-dual-stack → un sidecar che chiama 127.0.0.1 non raggiunge l'app.
app.listen(PORT, '0.0.0.0', () => {
  log.info('dadaguard up', { port: Number(PORT), mode: MODE })
})
