import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// #6 drift COMPLETO (on-demand): lancia `terragrunt plan` per un layer e ne raccoglie
// l'output. Job async in-memory (lo stato è effimero: si perde al riavvio, va bene).
// Esecuzione comandi → è il salto "da dashboard a servizio", scelta consapevole.
const jobs = new Map() // id -> { status, exitCode, output, startedAt, completedAt, layer }

// Eviction: senza pulizia la Map cresce all'infinito (memory leak). A ogni nuovo job
// rimuovo i job in stato terminale più vecchi del TTL e impongo un tetto al totale,
// scartando i più vecchi. Niente setInterval: la pulizia è legata all'uso, così il
// processo resta libero di uscire e il comportamento è prevedibile.
const JOB_TTL_MS = 60 * 60 * 1000 // 1h
const MAX_JOBS = 200

function evictJobs() {
  const now = Date.now()
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && j.completedAt && now - j.completedAt > JOB_TTL_MS) jobs.delete(id)
  }
  // tetto: se ancora troppi, rimuovo i più vecchi per startedAt (mai i 'running').
  if (jobs.size > MAX_JOBS) {
    const removable = [...jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const j of removable) {
      if (jobs.size <= MAX_JOBS) break
      jobs.delete(j.id)
    }
  }
}

// Layer = sottocartelle di live/<env>/ nel repo. Whitelist contro input arbitrario.
export function listLayers(repoDir, env) {
  const dir = join(repoDir, 'live', env)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function startPlan({ repoDir, env, layer }) {
  if (!listLayers(repoDir, env).includes(layer)) throw new Error(`layer '${layer}' non valido`)

  evictJobs() // pulizia opportunistica: tiene la Map limitata
  const id = randomUUID()
  const cwd = join(repoDir, 'live', env, layer)
  const job = { id, status: 'running', exitCode: null, output: '', startedAt: Date.now(), completedAt: null, layer }
  jobs.set(id, job)

  // -detailed-exitcode: 0 = nessun cambiamento, 2 = drift, 1 = errore.
  // I layer cron sono `exclude`-d salvo il flag → li passo entrambi (innocui altrove).
  const child = spawn('terragrunt', ['plan', '-input=false', '-no-color', '-detailed-exitcode'], {
    cwd,
    env: { ...process.env, STAGING_CRON_ENABLED: 'true', PROD_CRON_ENABLED: 'true' },
  })
  child.stdout.on('data', (d) => (job.output += d))
  child.stderr.on('data', (d) => (job.output += d))
  child.on('close', (code) => {
    job.exitCode = code
    job.status = code === 1 ? 'error' : 'done'
    job.completedAt = Date.now() // marca lo stato terminale per l'eviction TTL
  })
  child.on('error', (err) => {
    job.status = 'error'
    job.output += `\n[spawn] ${err.message} (terragrunt nel PATH?)`
    job.completedAt = Date.now()
  })
  return id
}

export function getJob(id) {
  const j = jobs.get(id)
  if (!j) return null
  return {
    status: j.status, // running | done | error
    exitCode: j.exitCode,
    drift: j.exitCode === 2, // 2 = ci sono cambiamenti = drift
    layer: j.layer,
    output: j.output.slice(-12000), // cap per non spingere MB nel browser
  }
}
