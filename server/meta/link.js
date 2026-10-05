// I link «Apri altrove»: lo stesso servizio negli strumenti dove si indaga davvero. Si compongono da
// dati che ci sono gia' (nome, region, log group dedotto dal tipo, repo e commit del deploy, ARN della
// build): nessuna chiamata, nessuna mappa per nome. PostHog compare SOLO se in config c'e'
// `posthog: { host, projectId }` E la risorsa porta il tag `dadaguard:posthog`: senza, un link a un
// progetto o a un servizio indovinato porta da nessuna parte.

// La console CloudWatch codifica il path nel frammento con `$25` al posto di `%`: con l'encoding
// normale la pagina si apre sull'elenco dei gruppi e non sul gruppo. Puro.
export const cwEncode = (s) => encodeURIComponent(s).replace(/%/g, '$25')

export function linkCloudWatchLogs(logGroup, region) {
  if (!logGroup || !region) return null
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${cwEncode(logGroup)}`
}

// Il log group lo si sa senza chiamate solo in due casi: l'override esplicito e la Lambda, che scrive
// sempre in `/aws/lambda/<nome>`. Per ECS sta nella task definition: lo risolve `/api/logs`, qui no.
export function logGroupDi(aws = {}) {
  if (aws.logGroup) return aws.logGroup
  if (aws.type === 'lambda' && aws.function) return `/aws/lambda/${aws.function}`
  return null
}

function posthogBase(posthog) {
  if (!posthog?.host || posthog.projectId == null || posthog.projectId === '') return null
  try {
    const u = new URL(posthog.host)
    return `${u.origin}/project/${encodeURIComponent(posthog.projectId)}`
  } catch {
    return null
  }
}

// I log di UN servizio in PostHog, nel formato che usa il frontend di PostHog stesso
// (products/logs/frontend/components/LogsServices/serviceViewerUrl.ts, letto da `urlToAction` di
// logsSceneLogic): `serviceNames` e `dateRange` sono JSON dentro la query, e `?service=` non lo legge
// nessuno, quindi apriva la pagina senza filtro. Il nome e' il `service.name` dei log, che non e' il
// nome della risorsa AWS: lo dice il tag `dadaguard:posthog`. Puro.
export function linkPosthogLog(posthog, servizio, dateRange = { date_from: '-1h', date_to: null }) {
  const ph = posthogBase(posthog)
  if (!ph || !servizio) return null
  const nomi = encodeURIComponent(JSON.stringify([servizio]))
  const range = encodeURIComponent(JSON.stringify(dateRange))
  return `${ph}/logs?activeTab=viewer&serviceNames=${nomi}&dateRange=${range}`
}

// { chiave, url, filtro } dove `filtro` dice a chi guarda cosa trovera' gia' selezionato.
// Niente link agli errori di PostHog: le eccezioni arrivano dal browser e non portano il servizio,
// quindi un «errori di questo servizio» filtrerebbe su niente. Nessun link e' meglio di uno sbagliato.
export function linkServizio({ aws = {}, region = null, posthog = null, servizioPosthog = null } = {}) {
  const out = []
  const log = linkPosthogLog(posthog, servizioPosthog)
  if (log) out.push({ chiave: 'posthog-log', url: log, filtro: `${servizioPosthog} · 1h` })
  const cw = linkCloudWatchLogs(logGroupDi(aws), region)
  if (cw) out.push({ chiave: 'cloudwatch-log', url: cw, filtro: logGroupDi(aws) })
  return out
}

// Commit su GitHub: solo con un repo https e uno sha esadecimale, che sono gli unici due casi in cui
// la pagina del commit esiste.
export function linkCommit(repo, sha) {
  if (!repo || !/^https:\/\//.test(repo) || !/^[0-9a-f]{7,40}$/i.test(String(sha ?? ''))) return null
  return `${repo.replace(/\.git$/, '').replace(/\/$/, '')}/commit/${sha}`
}

// Lo storico del progetto CodeBuild: region dall'ARN della build, che la porta sempre.
export function linkCodeBuild(project, arn) {
  const region = String(arn ?? '').split(':')[3]
  if (!project || !region) return null
  return `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${encodeURIComponent(project)}/history?region=${region}`
}

export function linkDeploy(d = {}) {
  return [
    { chiave: 'github-commit', url: linkCommit(d.repo, d.commit), filtro: d.commit ?? null },
    { chiave: 'codebuild', url: linkCodeBuild(d.project, d.arn), filtro: d.project ?? null },
  ].filter((l) => l.url)
}
