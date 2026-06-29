import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// #6 drift COMPLETO (on-demand): lancia `terragrunt plan` per un layer e ne raccoglie
// l'output. Job async in-memory (lo stato è effimero: si perde al riavvio, va bene).
// Esecuzione comandi → è il salto "da dashboard a servizio", scelta consapevole.
const jobs = new Map() // id -> { status, exitCode, output, startedAt, layer }

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

  const id = randomUUID()
  const cwd = join(repoDir, 'live', env, layer)
  const job = { id, status: 'running', exitCode: null, output: '', startedAt: Date.now(), layer }
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
  })
  child.on('error', (err) => {
    job.status = 'error'
    job.output += `\n[spawn] ${err.message} (terragrunt nel PATH?)`
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
