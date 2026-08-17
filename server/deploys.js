// Deploy in corso/recenti da AWS CodeBuild, per account. On-demand (read-only): mostra i build dei
// progetti di deploy `acme-<env>-<service>-deploy` — stato (in corso/ok/fallito), servizio, commit, ora.
// Permessi: codebuild:ListProjects, ListBuildsForProject, BatchGetBuilds. Zero storage.
import {
  CodeBuildClient,
  ListProjectsCommand,
  ListBuildsForProjectCommand,
  BatchGetBuildsCommand,
} from '@aws-sdk/client-codebuild'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'
import { manualActions } from './manualActions.js'
import { stripOrgEnv } from './util/envToken.js'

const DEPLOY_SUFFIX = '-deploy'

// Ricava il nome-servizio dal progetto CodeBuild: `<org>-<env>-<service>-deploy` → `<service>`.
// L'ancora è l'AMBIENTE, non il nome dell'organizzazione: quello cambia da chi usa lo strumento (e
// scriverlo qui, in un repo pubblico, diceva di chi è l'infrastruttura). Puro/testabile.
export function serviceFromProject(name = '') {
  return stripOrgEnv(name).replace(/-deploy$/, '') || name
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

// Etichetta finale dell'avvio, incrociando l'`initiator` con quello che CloudTrail sa della chiamata
// `StartBuild` (chi, con quale ruolo). Serve perché `initiator` da solo non distingue un hotfix
// forzato fuori dalla CI da una build riavviata da console: sono entrambi "manuale", e sono due
// fatti molto diversi. L'`initiator` resta la fonte per l'"auto" (CloudTrail può non avere l'evento,
// per ritardo di indicizzazione o perché fuori finestra). Puro/testabile.
export function resolveTrigger(initiator, starter) {
  const base = triggerOf(initiator)
  if (base === 'auto') return 'auto'
  return starter?.hotfix ? 'hotfix' : 'manuale'
}

// Chi ha lanciato il deploy: la variabile CodeBuild esportata `DEPLOYER` (autore del commit, scritta dal
// buildspec). Assente sui build vecchi o su progetti che non la esportano → null. Puro/testabile.
export function deployerOf(build = {}) {
  const v = (build.exportedEnvironmentVariables ?? []).find((e) => e.name === 'DEPLOYER')?.value
  return v || null
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
//
// `starter` = quello che CloudTrail sa dello `StartBuild` di QUESTA build (chi ha premuto, con quale
// ruolo). Assente su tutte le build "auto" e su quelle fuori dai 90 giorni di event history: in quel
// caso il comportamento è quello di prima.
export function mapBuild(b = {}, starter = null) {
  const started = b.startTime ?? null
  const ended = b.endTime ?? null
  const phases = (b.phases ?? []).map(mapPhase)
  const fail = failureOf(b.phases)
  return {
    id: b.id ?? null,
    arn: b.arn ?? null, // chiave per attribuire la build al suo evento CloudTrail StartBuild
    service: serviceFromProject(b.projectName),
    project: b.projectName,
    number: b.buildNumber ?? null,
    status: b.buildStatus, // IN_PROGRESS | SUCCEEDED | FAILED | FAULT | STOPPED | TIMED_OUT
    inProgress: b.buildStatus === 'IN_PROGRESS',
    commit: shortSha(b.resolvedSourceVersion || b.sourceVersion),
    phase: b.currentPhase ?? null,
    trigger: resolveTrigger(b.initiator, starter),
    author: deployerOf(b), // chi ha lanciato (autore commit), da exported-variable DEPLOYER
    // Chi ha PREMUTO, che su un hotfix non è l'autore del commit. Solo per le build non-auto: sulle
    // altre il "chi" è la pipeline, e stamparlo accanto a "auto" non aggiunge niente.
    forcedBy: starter?.forcedBy ?? null,
    // Chi ha premuto E CHE COSA E': una persona, la CI, un servizio. «forzato da GitHub Actions» era la
    // definizione di non-forzato, e la parola sbagliata qui fa cercare una persona che non esiste.
    actorKind: starter?.actorKind ?? null,
    viaTeleport: starter?.viaTeleport ?? false,
    startedAt: started,
    endedAt: ended,
    durationMs: started && ended ? new Date(ended).getTime() - new Date(started).getTime() : null,
    phases,
    failPhase: fail?.phase ?? null,
    failReason: fail?.reason ?? null,
    logsUrl: b.logs?.deepLink ?? null, // console CloudWatch del log stream di questo build
  }
}

const byRecent = (a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0)

// Elenca i deploy di un account, dal più recente: le build dei progetti `*-deploy` (ultime
// `perProject` per progetto) PIÙ i riavvii forzati a mano, che non sono build e prima non si
// vedevano da nessuna parte.
export async function listDeploys({ profile, roleArn, externalId, region } = {}, { perProject = 15 } = {}) {
  const aws = { profile, roleArn, externalId, region }
  const cb = new CodeBuildClient(clientOpts(aws))

  // Le azioni a mano si leggono da CloudTrail, in parallelo alle build: sono una fonte diversa e
  // indipendente, e non deve allungare la risposta di un giro sequenziale.
  const manual = manualActions(aws)

  // 1. progetti di deploy dell'account (paginati)
  const projects = []
  let nextToken
  do {
    const r = await cb.send(new ListProjectsCommand({ nextToken, sortBy: 'NAME' }))
    projects.push(...(r.projects ?? []))
    nextToken = r.nextToken
  } while (nextToken)
  const deployProjects = projects.filter((n) => n.endsWith(DEPLOY_SUFFIX))

  // Nessun progetto `*-deploy`: l'account non fa deploy CodeBuild (es. payer/security). I riavvii a
  // mano però ci sono comunque — in management gira Dadaguard stessa — quindi si restituiscono.
  // `noProjects` lo distingue dal "ci sono progetti ma nessuna build" → la UI mostra il messaggio giusto.
  if (deployProjects.length === 0) {
    const { restarts } = await manual
    return { builds: restarts.sort(byRecent), noProjects: true }
  }

  // 2. ultimi N id build per progetto (in parallelo)
  const idLists = await Promise.all(
    deployProjects.map((p) =>
      cb
        .send(new ListBuildsForProjectCommand({ projectName: p, sortOrder: 'DESCENDING' }))
        .then((r) => (r.ids ?? []).slice(0, perProject)),
    ),
  )
  const ids = idLists.flat()

  // 3. dettagli (BatchGetBuilds: max 100 id a chiamata)
  const raw = []
  for (let i = 0; i < ids.length; i += 100) {
    const r = await cb.send(new BatchGetBuildsCommand({ ids: ids.slice(i, i + 100) }))
    raw.push(...(r.builds ?? []))
  }

  const { restarts, startedBy } = await manual
  const builds = raw.map((b) => mapBuild(b, startedBy.get(b.arn) ?? startedBy.get(b.id)))
  return { builds: [...builds, ...restarts].sort(byRecent) }
}
