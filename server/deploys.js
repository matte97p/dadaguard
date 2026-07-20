// Deploy in corso/recenti da AWS CodeBuild, per account. On-demand (read-only): mostra i build dei
// progetti di deploy `cato-<env>-<service>-deploy` — stato (in corso/ok/fallito), servizio, commit, ora.
// Permessi: codebuild:ListProjects, ListBuildsForProject, BatchGetBuilds. Zero storage.
import {
  CodeBuildClient,
  ListProjectsCommand,
  ListBuildsForProjectCommand,
  BatchGetBuildsCommand,
} from '@aws-sdk/client-codebuild'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'

const DEPLOY_SUFFIX = '-deploy'

// Ricava il nome-servizio dal progetto CodeBuild: `cato-<env>-<service>-deploy` → `<service>`.
// Toglie il prefisso `cato-<env>-` (env = un token) e il suffisso `-deploy`. Puro/testabile.
export function serviceFromProject(name = '') {
  return name.replace(/^cato-[^-]+-/, '').replace(/-deploy$/, '') || name
}

// SHA corto per i commit; un ref simbolico (branch, es. "staging") resta com'è. Puro/testabile.
export function shortSha(v) {
  if (!v) return null
  return /^[0-9a-f]{7,40}$/i.test(v) ? v.slice(0, 7) : v
}

// Normalizza un build CodeBuild nella forma minima che serve alla UI (nessun valore sensibile).
export function mapBuild(b = {}) {
  const started = b.startTime ?? null
  const ended = b.endTime ?? null
  return {
    service: serviceFromProject(b.projectName),
    project: b.projectName,
    number: b.buildNumber ?? null,
    status: b.buildStatus, // IN_PROGRESS | SUCCEEDED | FAILED | FAULT | STOPPED | TIMED_OUT
    inProgress: b.buildStatus === 'IN_PROGRESS',
    commit: shortSha(b.resolvedSourceVersion || b.sourceVersion),
    phase: b.currentPhase ?? null,
    startedAt: started,
    endedAt: ended,
    durationMs: started && ended ? new Date(ended).getTime() - new Date(started).getTime() : null,
  }
}

// Elenca i deploy (ultimi `perProject` build per progetto di deploy) di un account, dal più recente.
export async function listDeploys({ profile, roleArn, externalId, region } = {}, { perProject = 3 } = {}) {
  const cb = new CodeBuildClient(clientOpts({ profile, roleArn, externalId, region }))

  // 1. progetti di deploy dell'account (paginati)
  const projects = []
  let nextToken
  do {
    const r = await cb.send(new ListProjectsCommand({ nextToken, sortBy: 'NAME' }))
    projects.push(...(r.projects ?? []))
    nextToken = r.nextToken
  } while (nextToken)
  const deployProjects = projects.filter((n) => n.endsWith(DEPLOY_SUFFIX))
  if (deployProjects.length === 0) return { builds: [] }

  // 2. ultimi N id build per progetto (in parallelo)
  const idLists = await Promise.all(
    deployProjects.map((p) =>
      cb
        .send(new ListBuildsForProjectCommand({ projectName: p, sortOrder: 'DESCENDING' }))
        .then((r) => (r.ids ?? []).slice(0, perProject)),
    ),
  )
  const ids = idLists.flat()
  if (ids.length === 0) return { builds: [] }

  // 3. dettagli (BatchGetBuilds: max 100 id a chiamata)
  const raw = []
  for (let i = 0; i < ids.length; i += 100) {
    const r = await cb.send(new BatchGetBuildsCommand({ ids: ids.slice(i, i + 100) }))
    raw.push(...(r.builds ?? []))
  }

  const builds = raw.map(mapBuild).sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0))
  return { builds }
}
