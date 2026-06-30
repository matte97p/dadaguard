import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs'
import { clientOpts } from './awsClient.js'

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

  const desiredCount = svc.desiredCount ?? 0
  const runningCount = svc.runningCount ?? 0
  const pendingCount = svc.pendingCount ?? 0

  let status
  if (desiredCount === 0) status = 'idle' // scalato a zero di proposito: a riposo, non un errore
  else if (runningCount >= desiredCount) status = 'up'
  else if (runningCount === 0) status = 'down'
  else status = 'degraded'

  const summary =
    t('ecs.tasks', { running: runningCount, desired: desiredCount }) +
    (pendingCount > 0 ? t('ecs.pending', { n: pendingCount }) : '')

  return { status, summary, desiredCount, runningCount, pendingCount }
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
  return { tag: imageTag(image), image, deployedAt }
}

// "repo:tag" / "repo@sha256:…" → tag o sha breve, prefisso ":" per chiarezza in summary.
function imageTag(image) {
  if (!image) return null
  const at = image.indexOf('@sha256:')
  if (at !== -1) return ':' + image.slice(at + 8, at + 8 + 12)
  const colon = image.lastIndexOf(':')
  // evita di scambiare la porta del registry (host:port/repo) per un tag
  if (colon > image.lastIndexOf('/')) return ':' + image.slice(colon + 1)
  return null
}
