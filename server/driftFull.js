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

// exit 2 = "ci sono cambiamenti", ma NON distingue aggiunte da modifiche/distruzioni.
// Parso "Plan: A to add, C to change, D to destroy" per classificare onestamente:
//   insync  = nessun cambiamento
//   pending = solo aggiunte (definito in TF ma non ancora applicato) → NON è drift
//   drift   = ci sono change/destroy (la realtà diverge da ciò che è applicato)
// Funzione pura (testabile) separata dallo stato del job.
export function classifyPlan(status, exitCode, output) {
  const m = /Plan:\s+(\d+) to add,\s+(\d+) to change,\s+(\d+) to destroy/.exec(output ?? '')
  const counts = m ? { add: +m[1], change: +m[2], destroy: +m[3] } : null
  let kind
  if (status === 'error') kind = 'error'
  else if (exitCode === 0) kind = 'insync'
  else if (counts && counts.change === 0 && counts.destroy === 0 && counts.add > 0) kind = 'pending'
  else kind = 'drift' // exit 2 con modifiche/distruzioni, o piano con cambiamenti non parsabile
  return { kind, counts }
}

// Redazione di sicurezza: il plan può contenere in chiaro valori di attributi NON marcati `sensitive`
// (es. una connection string dentro una env var). Prima di esporre l'output alla UI mascheriamo i
// VALORI stringa — a destra di `=`, e da entrambi i lati di `->` nei diff — tenendo struttura, nomi
// degli attributi e i tipi/nomi di risorsa (che stanno tra virgolette ma non sono segreti).
export function redactPlan(text) {
  return String(text ?? '')
    .replace(/(=|->)(\s*)"(?:[^"\\]|\\.)*"/g, '$1$2(redacted)') // valore dopo = o ->
    .replace(/"(?:[^"\\]|\\.)*"(\s*->)/g, '(redacted)$1') // valore prima di -> (lato "vecchio" del diff)
}

export function getJob(id) {
  const j = jobs.get(id)
  if (!j) return null
  const { kind, counts } = classifyPlan(j.status, j.exitCode, j.output)
  return {
    status: j.status, // running | done | error
    exitCode: j.exitCode,
    kind, // insync | pending | drift | error
    counts, // { add, change, destroy } | null
    drift: kind === 'drift', // retro-compat
    layer: j.layer,
    output: redactPlan(j.output.slice(-12000)), // cap + redazione dei valori (nessun secret in chiaro)
  }
}
