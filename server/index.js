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
import { listLayers, startPlan, getJob } from './driftFull.js'

const PORT = process.env.PORT ?? 3001
const app = express()
app.use(express.json())

app.get('/api/status', async (_req, res) => {
  try {
    res.json(await getStatus())
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

// Discovery read-only: lista le risorse di un account. NON scrive niente.
app.get('/api/discover', async (req, res) => {
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
app.get('/api/costs', async (_req, res) => {
  try {
    const { accounts } = loadConfig()
    const out = {}
    await Promise.all(
      Object.entries(accounts).map(async ([key, a]) => {
        if (!a.profile && !a.roleArn) return
        try {
          out[key] = {
            label: a.label ?? key,
            color: a.color ?? null,
            ...(await getCosts({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId })),
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

// #6 drift COMPLETO (on-demand, esegue `terragrunt plan`). Job async.
app.get('/api/drift/layers', (req, res) => {
  const { accounts } = loadConfig()
  const acct = accounts[req.query.account]
  if (!acct?.terraform?.repoDir) return res.json({ layers: [] })
  res.json({ layers: listLayers(acct.terraform.repoDir, acct.terraform.env || req.query.account) })
})

app.post('/api/drift/run', (req, res) => {
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
app.post('/api/watchlist/add', (req, res) => {
  try {
    res.json({ added: addServices(req.body?.entries ?? []) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/watchlist/remove', (req, res) => {
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
  console.log(`dadaguard → http://0.0.0.0:${PORT}`)
})
