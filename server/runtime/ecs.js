import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs'
import { clientOpts } from './awsClient.js'
import { principalName } from '../util/principal.js'

// Finestra di grazia sui rollout (default 120s): un deploy fresco ha running<desired per
// qualche secondo — è transitorio, non un guasto. Override via env.
const GRACE_MS = (Number(process.env.DADAGUARD_DEPLOY_GRACE_SECONDS) || 120) * 1000

// Classificazione PURA (testabile): da uno snapshot del servizio ECS → stato + se è in rollout.
// #3 grace/debounce SENZA stato locale: usa i `deployments` che AWS già espone. Se running<desired
// MA c'è un rollout in corso (rolloutState IN_PROGRESS, doppio deployment PRIMARY+ACTIVE, o PRIMARY
// creato da poco) → 'idle' transitorio ("rollout in corso"), non degraded/down. Se il rollout è
// FAILED resta un guasto vero. Niente falsi rossi durante i deploy, niente debounce stateful.
export function classifyEcs(svc, now = Date.now(), graceMs = GRACE_MS) {
  const desiredCount = svc.desiredCount ?? 0
  const runningCount = svc.runningCount ?? 0
  const pendingCount = svc.pendingCount ?? 0
  const deployments = svc.deployments ?? []

  let status
  if (desiredCount === 0) status = 'idle' // scalato a zero di proposito: a riposo, non un errore
  else if (runningCount >= desiredCount) status = 'up'
  else if (runningCount === 0) status = 'down'
  else status = 'degraded'

  let deploying = false
  if ((status === 'degraded' || status === 'down') && desiredCount > 0) {
    const failed = deployments.some((d) => d.rolloutState === 'FAILED')
    if (!failed) {
      const inProgress = deployments.some((d) => d.rolloutState === 'IN_PROGRESS')
      const multi = deployments.length > 1 // nuovo PRIMARY + vecchio ACTIVE che drena
      const primary = deployments.find((d) => d.status === 'PRIMARY') ?? deployments[0]
      const startedAt = primary?.createdAt ? new Date(primary.createdAt).getTime() : null
      const recent = startedAt != null && now - startedAt < graceMs
      if (inProgress || multi || recent) {
        status = 'idle' // transitorio: grigio, non rosso
        deploying = true
      }
    }
  }
  return { status, desiredCount, runningCount, pendingCount, deploying }
}

// RuntimeProvider per ECS: desired vs running task count di un servizio.
// Permesso richiesto: ecs:DescribeServices.
export async function ecsRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const client = new ECSClient(clientOpts(aws))
  const out = await client.send(
    new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }),
  )

  const svc = out.services?.[0]
  if (!svc) return { status: 'unknown', reason: t('ecs.notfound') }

  const { status, desiredCount, runningCount, pendingCount, deploying } = classifyEcs(svc)
  const summary = deploying
    ? t('ecs.deploying', { running: runningCount, desired: desiredCount })
    : t('ecs.tasks', { running: runningCount, desired: desiredCount }) +
      (pendingCount > 0 ? t('ecs.pending', { n: pendingCount }) : '')

  return { status, summary, desiredCount, runningCount, pendingCount, deploying }
}

// #2 build/deploy zero-config per ECS: tag immagine del task definition in uso
// + timestamp del deploy più recente. Permessi: ecs:DescribeServices,
// ecs:DescribeTaskDefinition. Ritorna { tag?, image?, deployedAt? } o null.
export async function ecsBuildInfo(cfg, aws) {
  const client = new ECSClient(clientOpts(aws))
  const out = await client.send(
    new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }),
  )
  const svc = out.services?.[0]
  if (!svc) return null

  // deploy più recente (PRIMARY) → timestamp; il task definition in uso è il suo.
  const deployments = svc.deployments ?? []
  const primary = deployments.find((d) => d.status === 'PRIMARY') ?? deployments[0]
  const deployedAt = primary?.createdAt ?? null
  const taskDefArn = primary?.taskDefinition ?? svc.taskDefinition
  if (!taskDefArn) return { deployedAt }

  const td = await client.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }))
  // immagine del primo container (o quello che combacia col service, se dichiarato).
  const containers = td.taskDefinition?.containerDefinitions ?? []
  const image = (cfg.container ? containers.find((c) => c.name === cfg.container) : containers[0])?.image
  // registeredBy = chi ha registrato l'ultima revision della task def (ultimo modificatore), gratis qui.
  return { tag: imageTag(image), image, deployedAt, modifiedBy: principalName(td.taskDefinition?.registeredBy) }
}

// "repo:tag" / "repo@sha256:…" → tag o sha breve, prefisso ":" per chiarezza in summary.
export function imageTag(image) {
  if (!image) return null
  const at = image.indexOf('@sha256:')
  if (at !== -1) return ':' + image.slice(at + 8, at + 8 + 12)
  const colon = image.lastIndexOf(':')
  // evita di scambiare la porta del registry (host:port/repo) per un tag
  if (colon > image.lastIndexOf('/')) return ':' + image.slice(colon + 1)
  return null
}
