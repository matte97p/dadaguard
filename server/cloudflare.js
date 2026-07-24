// Client Cloudflare read-only (API v4 + GraphQL Analytics). Serve a Dadaguard per elencare i Worker,
// i loro deploy (rollout via Wrangler/dash) e il runtime (richieste/errori 24h). Nessuna scrittura.
// Difensivo: le forme dell'API cambiano nel tempo → normalizzatori tolleranti + fallback, così un
// campo mancante degrada (niente crash). I normalizzatori sono puri/testabili; l'I/O è isolato in cfFetch.
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
    const msg = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`
    throw new Error(msg)
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

// Deep-link alla dashboard Cloudflare del Worker (vista deployments).
export function workerDashUrl(accountId, script) {
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${script}/production/deployments`
}

// Un deployment CF (forma variabile) → forma normalizzata { id, createdOn, source, author, versionId }.
export function normalizeDeployment(d = {}) {
  const meta = d.metadata ?? {}
  return {
    id: d.id ?? d.deployment_id ?? null,
    createdOn: d.created_on ?? meta.created_on ?? d.created ?? null,
    source: d.source ?? meta.source ?? null,
    author: d.author_email ?? meta.author_email ?? d.author ?? null,
    versionId: (Array.isArray(d.versions) && d.versions[0] && (d.versions[0].version_id ?? d.versions[0].id)) || d.id || null,
  }
}

// Un deployment normalizzato → la stessa forma "build" della pagina Deploy (provider: cloudflare).
// CF registra solo i rollout RIUSCITI → status SUCCEEDED, niente fasi/fallimenti.
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
    author: dep.author,
    deployUrl: workerDashUrl(accountId, script),
  }
}

// Elenco account accessibili col token (per risolvere l'account id da solo se è uno).
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

// Worker (script) dell'account.
export async function listWorkers(token, accountId) {
  const json = await cfFetch(token, `/accounts/${accountId}/workers/scripts`)
  return (json.result ?? []).map((s) => ({ name: s.id, modifiedOn: s.modified_on ?? s.created_on ?? null }))
}

// Ultimi deploy di un Worker, dal più recente. Normalizza le due forme note (`result.deployments`/`result.items`).
export async function listDeployments(token, accountId, script, { limit = 15 } = {}) {
  const json = await cfFetch(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/deployments`)
  const raw = json.result?.deployments ?? json.result?.items ?? (Array.isArray(json.result) ? json.result : [])
  return raw
    .map(normalizeDeployment)
    .sort((a, b) => new Date(b.createdOn ?? 0) - new Date(a.createdOn ?? 0))
    .slice(0, limit)
}

// Runtime del Worker (GraphQL Analytics): richieste/errori per ora nelle ultime `hours`. Difensivo:
// qualunque errore → null (la card mostra comunque la versione). `sinceIso` iniettabile per i test.
export async function workerAnalytics(token, accountId, script, { hours = 24, sinceIso } = {}) {
  const since = sinceIso ?? new Date(Date.now() - hours * 3600_000).toISOString()
  const query = `query($acct:String!,$script:String!,$since:Time!){
    viewer{accounts(filter:{accountTag:$acct}){
      workersInvocationsAdaptive(limit:1000,orderBy:[datetimeHour_ASC],filter:{scriptName:$script,datetimeHour_geq:$since}){
        sum{requests errors} dimensions{datetimeHour}
      }
    }}
  }`
  try {
    const json = await cfFetch(token, '/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables: { acct: accountId, script, since } }),
    })
    const nodes = json?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []
    return summarizeAnalytics(nodes)
  } catch {
    return null
  }
}

// Nodi GraphQL orari → { requests, errors, errorPct, spark:[req/ora] }. Puro/testabile.
export function summarizeAnalytics(nodes = []) {
  const spark = nodes.map((n) => n.sum?.requests ?? 0)
  const requests = spark.reduce((a, b) => a + b, 0)
  const errors = nodes.reduce((a, n) => a + (n.sum?.errors ?? 0), 0)
  return { requests, errors, errorPct: requests ? (errors / requests) * 100 : 0, spark }
}

// --- Orchestratori (usati dagli endpoint). Ritornano null/[] se non c'è token → integrazione SPENTA. ---

// Pseudo-account "Cloudflare" per la pagina Deploy: i deploy recenti di OGNI Worker come "build".
export async function cloudflareDeploysAccount({ perWorker = 15 } = {}) {
  const cred = cloudflareToken()
  if (!cred) return null
  const { id: accountId } = await resolveAccountId(cred.token, cloudflareAccountId())
  if (!accountId) return null
  const workers = await listWorkers(cred.token, accountId)
  if (workers.length === 0) return { label: 'Cloudflare', color: CF_COLOR, provider: 'cloudflare', builds: [], noProjects: true }
  const lists = await mapLimit(workers, 6, async (w) => {
    try {
      return (await listDeployments(cred.token, accountId, w.name, { limit: perWorker })).map((d) => deploymentToBuild(d, w.name, accountId))
    } catch {
      return []
    }
  })
  const builds = lists.flat().sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0))
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
