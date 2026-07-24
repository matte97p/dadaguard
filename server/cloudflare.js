// Client Cloudflare read-only (API v4 + GraphQL Analytics). Serve a Dadaguard per elencare Worker e
// Pages, i loro deploy e il runtime dei Worker. Nessuna scrittura. Difensivo: normalizzatori tolleranti
// + fallback, così un campo mancante degrada (niente crash). Normalizzatori puri/testabili; I/O in cfFetch.
import { cloudflareToken, cloudflareAccountId } from './cfToken.js'
import { mapLimit } from './util/pool.js'

const API = 'https://api.cloudflare.com/client/v4'
export const CF_COLOR = '#f6821f' // arancione Cloudflare

async function cfFetch(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || (json && json.success === false)) {
    const errs = json?.errors ?? []
    const msg = errs.map((e) => e.message).join('; ') || `HTTP ${res.status}`
    const op = path.split('?')[0]
    // code 10000 su un endpoint specifico = quasi sempre uno SCOPE mancante del token (non token invalido:
    // verify e /accounts passerebbero). Diciamolo, così l'utente sa cosa aggiungere.
    const hint = errs.some((e) => e.code === 10000)
      ? ' — controlla gli scope del token (Workers Scripts:Read · Pages:Read · Account Analytics:Read)'
      : ''
    throw new Error(`${msg} [${op}]${hint}`)
  }
  return json
}

// SHA/hash corto per l'id di versione/deploy (l'equivalente del commit sulla card).
export function shortId(v) {
  if (!v) return null
  const s = String(v)
  return s.length > 8 ? s.slice(0, 8) : s
}

// Sorgente del deploy → "manuale" se dalla dashboard, altrimenti "auto" (wrangler/api/upload = da pipeline).
export function triggerOfSource(source = '') {
  return /dash|dashboard/i.test(source) ? 'manuale' : 'auto'
}

export function workerDashUrl(accountId, script) {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${script}/production/deployments`
}
export function pagesDashUrl(accountId, project) {
  return `https://dash.cloudflare.com/${accountId}/pages/view/${project}`
}

// --- Worker deployments ---

// Un deployment Worker (forma variabile) → { id, createdOn, source, author, versionId, versions[] }.
// `versions` porta il rollout graduale (canary): [{ id, percentage }].
export function normalizeDeployment(d = {}) {
  const meta = d.metadata ?? {}
  const versions = (Array.isArray(d.versions) ? d.versions : [])
    .map((v) => ({ id: v.version_id ?? v.id ?? null, percentage: v.percentage ?? v.traffic ?? null }))
    .filter((v) => v.id)
  return {
    id: d.id ?? d.deployment_id ?? null,
    createdOn: d.created_on ?? meta.created_on ?? d.created ?? null,
    source: d.source ?? meta.source ?? null,
    author: d.author_email ?? meta.author_email ?? d.author ?? null,
    versionId: versions[0]?.id || d.id || null,
    versions,
  }
}

// Deployment Worker → forma "build" della pagina Deploy. CF registra solo i rollout RIUSCITI → SUCCEEDED.
export function deploymentToBuild(dep, script, accountId) {
  return {
    id: dep.id,
    service: script,
    project: script,
    number: null,
    status: 'SUCCEEDED',
    inProgress: false,
    commit: shortId(dep.versionId || dep.id),
    trigger: triggerOfSource(dep.source),
    startedAt: dep.createdOn,
    endedAt: dep.createdOn,
    durationMs: null,
    provider: 'cloudflare',
    kind: 'worker',
    author: dep.author,
    versions: dep.versions,
    deployUrl: workerDashUrl(accountId, script),
  }
}

// --- Pages deployments (hanno uno STATO reale: success/failure/active) ---

// Stato dello stage Pages → stato "build" uniforme.
export function pagesStatus(stage) {
  const s = String(stage?.status ?? '').toLowerCase()
  if (s === 'success') return 'SUCCEEDED'
  if (s === 'failure' || s === 'failed') return 'FAILED'
  if (['active', 'building', 'deploying', 'queued', 'initializing'].includes(s)) return 'IN_PROGRESS'
  if (['canceled', 'cancelled', 'skipped'].includes(s)) return 'STOPPED'
  return 'SUCCEEDED'
}

export function normalizePagesDeployment(d = {}) {
  const trig = d.deployment_trigger ?? {}
  const meta = trig.metadata ?? {}
  return {
    id: d.id ?? null,
    createdOn: d.created_on ?? d.modified_on ?? null,
    env: d.environment ?? null,
    stage: d.latest_stage?.name ?? null,
    status: pagesStatus(d.latest_stage),
    commit: meta.commit_hash ?? null,
    branch: meta.branch ?? null,
    triggerType: trig.type ?? null, // 'github:push' | 'ad_hoc' | ...
  }
}

export function pagesDeploymentToBuild(dep, project, accountId) {
  const failed = dep.status === 'FAILED'
  return {
    id: dep.id,
    service: project,
    project,
    number: null,
    status: dep.status,
    inProgress: dep.status === 'IN_PROGRESS',
    commit: shortId(dep.commit || dep.id),
    trigger: /github|push|ci/i.test(dep.triggerType || '') ? 'auto' : 'manuale',
    startedAt: dep.createdOn,
    endedAt: dep.createdOn,
    durationMs: null,
    provider: 'cloudflare',
    kind: 'pages',
    branch: dep.branch,
    env: dep.env,
    failPhase: failed ? dep.stage || 'deploy' : null,
    failReason: null,
    deployUrl: pagesDashUrl(accountId, project),
  }
}

// --- Elenchi ---

export async function listAccounts(token) {
  const json = await cfFetch(token, '/accounts?per_page=50')
  return (json.result ?? []).map((a) => ({ id: a.id, name: a.name }))
}

// Risolve l'account id: override esplicito → altrimenti l'unico accessibile. >1 e nessun override:
// prende il primo e segnala `ambiguous` (il chiamante logga). 0 → null.
export async function resolveAccountId(token, override) {
  if (override) return { id: override }
  const accounts = await listAccounts(token)
  if (accounts.length === 0) return { id: null }
  if (accounts.length === 1) return { id: accounts[0].id, name: accounts[0].name }
  return { id: accounts[0].id, name: accounts[0].name, ambiguous: accounts.map((a) => a.id) }
}

export async function listWorkers(token, accountId) {
  const json = await cfFetch(token, `/accounts/${accountId}/workers/scripts`)
  return (json.result ?? []).map((s) => ({ name: s.id, modifiedOn: s.modified_on ?? s.created_on ?? null }))
}

export async function listDeployments(token, accountId, script, { limit = 15 } = {}) {
  const json = await cfFetch(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`)
  const raw = json.result?.deployments ?? json.result?.items ?? (Array.isArray(json.result) ? json.result : [])
  return raw
    .map(normalizeDeployment)
    .sort((a, b) => new Date(b.createdOn ?? 0) - new Date(a.createdOn ?? 0))
    .slice(0, limit)
}

export async function listPagesProjects(token, accountId) {
  const json = await cfFetch(token, `/accounts/${accountId}/pages/projects`)
  return (json.result ?? []).map((p) => ({ name: p.name }))
}

export async function listPagesDeployments(token, accountId, project, { limit = 15 } = {}) {
  const json = await cfFetch(token, `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/deployments`)
  const raw = Array.isArray(json.result) ? json.result : json.result?.deployments ?? []
  return raw
    .map(normalizePagesDeployment)
    .sort((a, b) => new Date(b.createdOn ?? 0) - new Date(a.createdOn ?? 0))
    .slice(0, limit)
}

// --- Runtime (GraphQL Analytics) ---

function analyticsQuery(fields) {
  return `query($acct:String!,$script:String!,$since:Time!){viewer{accounts(filter:{accountTag:$acct}){workersInvocationsAdaptive(limit:1000,orderBy:[datetimeHour_ASC],filter:{scriptName:$script,datetimeHour_geq:$since}){${fields}}}}}`
}
const FIELDS_RICH = 'sum{requests errors subrequests} quantiles{cpuTimeP99} dimensions{datetimeHour}'
const FIELDS_MIN = 'sum{requests errors} dimensions{datetimeHour}'

// Runtime del Worker: prova la query RICCA (cpu p99 + subrequests); se lo schema non la accetta, ripiega
// sulla MINIMA (richieste/errori, già validata). Qualunque errore finale → null (la card mostra la versione).
export async function workerAnalytics(token, accountId, script, { hours = 24, sinceIso } = {}) {
  const since = sinceIso ?? new Date(Date.now() - hours * 3600_000).toISOString()
  const run = async (fields) => {
    const json = await cfFetch(token, '/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: analyticsQuery(fields), variables: { acct: accountId, script, since } }),
    })
    if (json?.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; ')) // GraphQL: errori nel body, HTTP 200
    return json?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []
  }
  try {
    return summarizeAnalytics(await run(FIELDS_RICH))
  } catch {
    try {
      return summarizeAnalytics(await run(FIELDS_MIN))
    } catch {
      return null
    }
  }
}

// Nodi orari → { requests, errors, errorPct, subrequests, cpuP99Ms, spark:[req/ora] }. Puro/testabile.
// cpuTimeP99 arriva in microsecondi → ms; assente (query minima) → null.
export function summarizeAnalytics(nodes = []) {
  const spark = nodes.map((n) => n.sum?.requests ?? 0)
  const requests = spark.reduce((a, b) => a + b, 0)
  const errors = nodes.reduce((a, n) => a + (n.sum?.errors ?? 0), 0)
  const subrequests = nodes.reduce((a, n) => a + (n.sum?.subrequests ?? 0), 0)
  const p99us = nodes.reduce((m, n) => Math.max(m, n.quantiles?.cpuTimeP99 ?? 0), 0)
  return {
    requests,
    errors,
    errorPct: requests ? (errors / requests) * 100 : 0,
    subrequests,
    cpuP99Ms: p99us ? p99us / 1000 : null,
    spark,
  }
}

// --- Orchestratori. Ritornano null/[] se non c'è token → integrazione SPENTA. ---

// Pseudo-account "Cloudflare" per la pagina Deploy: deploy di OGNI Worker + Pages come "build".
// Workers = provider primario (se lo scope manca, l'errore emerge). Pages = bonus (scope Pages:Read):
// se manca o non ce ne sono, si salta in silenzio.
export async function cloudflareDeploysAccount({ perWorker = 15 } = {}) {
  const cred = cloudflareToken()
  if (!cred) return null
  const { id: accountId } = await resolveAccountId(cred.token, cloudflareAccountId())
  if (!accountId) return null
  const workers = await listWorkers(cred.token, accountId)
  const pages = await listPagesProjects(cred.token, accountId).catch(() => [])
  const workerBuilds = (
    await mapLimit(workers, 6, async (w) => {
      try {
        return (await listDeployments(cred.token, accountId, w.name, { limit: perWorker })).map((d) => deploymentToBuild(d, w.name, accountId))
      } catch {
        return []
      }
    })
  ).flat()
  const pageBuilds = (
    await mapLimit(pages, 6, async (p) => {
      try {
        return (await listPagesDeployments(cred.token, accountId, p.name, { limit: perWorker })).map((d) => pagesDeploymentToBuild(d, p.name, accountId))
      } catch {
        return []
      }
    })
  ).flat()
  const builds = [...workerBuilds, ...pageBuilds].sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0))
  if (workers.length === 0 && pages.length === 0) return { label: 'Cloudflare', color: CF_COLOR, provider: 'cloudflare', builds: [], noProjects: true }
  return { label: 'Cloudflare', color: CF_COLOR, provider: 'cloudflare', builds }
}

// Stato dei Worker per la Dashboard: per ciascuno l'ultimo deploy (versione) + runtime 24h (analytics).
export async function cloudflareWorkersStatus({ hours = 24 } = {}) {
  const cred = cloudflareToken()
  if (!cred) return []
  const { id: accountId } = await resolveAccountId(cred.token, cloudflareAccountId())
  if (!accountId) return []
  const workers = await listWorkers(cred.token, accountId)
  return mapLimit(workers, 6, async (w) => {
    const [deps, analytics] = await Promise.all([
      listDeployments(cred.token, accountId, w.name, { limit: 1 }).catch(() => []),
      workerAnalytics(cred.token, accountId, w.name, { hours }),
    ])
    return { name: w.name, latest: deps[0] ?? null, analytics, deployUrl: workerDashUrl(accountId, w.name) }
  })
}
