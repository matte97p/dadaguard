// I link «Apri altrove»: lo stesso servizio negli strumenti dove si indaga davvero. Si compongono da
// dati che ci sono gia' (nome, region, log group dedotto dal tipo, repo e commit del deploy, ARN della
// build): nessuna chiamata, nessuna mappa per nome. PostHog compare SOLO se in config c'e'
// `posthog: { host, projectId }`: senza, un link a un progetto indovinato porta da nessuna parte.

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

// { chiave, url, filtro } dove `filtro` dice a chi guarda cosa trovera' gia' selezionato.
export function linkServizio({ name, aws = {}, region = null, posthog = null } = {}) {
  const out = []
  const ph = posthogBase(posthog)
  if (ph && name) {
    const s = encodeURIComponent(name)
    out.push({ chiave: 'posthog-errori', url: `${ph}/error_tracking?service=${s}&date_from=-1h`, filtro: '1h' })
    out.push({ chiave: 'posthog-log', url: `${ph}/logs?service=${s}&date_from=-1h`, filtro: '1h' })
  }
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
