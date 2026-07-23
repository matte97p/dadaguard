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

// Come è partito il build, dall'`initiator` CodeBuild: ruolo GHA di deploy / webhook GitHub /
// CodeConnections → "auto" (push); altrimenti (start-build a mano, ruolo SSO) → "manuale". Puro/testabile.
export function triggerOf(initiator) {
  return /gha-deploy|github|hookshot|codeconnection|codestar/i.test(initiator || '') ? 'auto' : 'manuale'
}

const FAILED_PHASE = new Set(['FAILED', 'FAULT', 'TIMED_OUT'])

// Messaggi tecnici di una fase (contexts CodeBuild): il "perché". Niente valori sensibili — sono
// stringhe d'errore del builder (es. "Command did not exit successfully ... exit status 1"). Puro.
function phaseMessage(p = {}) {
  return (p.contexts ?? []).map((c) => c.message || c.statusCode).filter(Boolean).join(' · ')
}

// Fase CodeBuild → forma compatta per la timeline del drawer di dettaglio. Il messaggio si include
// SOLO per le fasi non riuscite (è lì che serve il perché), per tenere il payload piccolo. Puro/testabile.
export function mapPhase(p = {}) {
  const msg = FAILED_PHASE.has(p.phaseStatus) ? phaseMessage(p) : ''
  return {
    type: p.phaseType, // SUBMITTED | QUEUED | PROVISIONING | DOWNLOAD_SOURCE | INSTALL | PRE_BUILD | BUILD | POST_BUILD | ...
    status: p.phaseStatus ?? null, // l'ultima fase (COMPLETED) non ha status
    durationMs: p.durationInSeconds != null ? p.durationInSeconds * 1000 : null,
    ...(msg ? { message: msg } : {}),
  }
}

// Motivo del fallimento di un build: prima fase fallita + il suo messaggio. Null se nessuna fase fallita.
// Puro/testabile.
export function failureOf(phases = []) {
  const f = (phases ?? []).find((p) => FAILED_PHASE.has(p.phaseStatus))
  if (!f) return null
  return { phase: f.phaseType, reason: phaseMessage(f) || null }
}

// Normalizza un build CodeBuild nella forma che serve alla UI (nessun segreto): stato/commit/trigger,
// più le FASI (timeline), il MOTIVO del fallimento e il deep-link ai log CloudWatch (per il drawer).
export function mapBuild(b = {}) {
  const started = b.startTime ?? null
  const ended = b.endTime ?? null
  const phases = (b.phases ?? []).map(mapPhase)
  const fail = failureOf(b.phases)
  return {
    id: b.id ?? null,
    service: serviceFromProject(b.projectName),
    project: b.projectName,
    number: b.buildNumber ?? null,
    status: b.buildStatus, // IN_PROGRESS | SUCCEEDED | FAILED | FAULT | STOPPED | TIMED_OUT
    inProgress: b.buildStatus === 'IN_PROGRESS',
    commit: shortSha(b.resolvedSourceVersion || b.sourceVersion),
    phase: b.currentPhase ?? null,
    trigger: triggerOf(b.initiator),
    startedAt: started,
    endedAt: ended,
    durationMs: started && ended ? new Date(ended).getTime() - new Date(started).getTime() : null,
    phases,
    failPhase: fail?.phase ?? null,
    failReason: fail?.reason ?? null,
    logsUrl: b.logs?.deepLink ?? null, // console CloudWatch del log stream di questo build
  }
}

// Elenca i deploy (ultimi `perProject` build per progetto di deploy) di un account, dal più recente.
export async function listDeploys({ profile, roleArn, externalId, region } = {}, { perProject = 15 } = {}) {
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
  // Nessun progetto `*-deploy`: l'account non fa deploy CodeBuild (es. payer/security).
  // `noProjects` lo distingue dal "ci sono progetti ma nessuna build" → la UI mostra il messaggio giusto.
  if (deployProjects.length === 0) return { builds: [], noProjects: true }

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
