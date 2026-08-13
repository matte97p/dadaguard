import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs'
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetGroupsCommand,
  DescribeLoadBalancersCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { clientOpts } from './awsClient.js'
import { cached } from '../util/ttlcache.js'
import { publicUrlOfLb, unhealthyList } from './alb.js'
import { principalName } from '../util/principal.js'

// Le stesse informazioni servivano a DUE check diversi (`runtime` e `version`), che girano in
// parallelo sullo stesso servizio: erano due `DescribeServices` identiche per ogni servizio ECS.
// `cached` condivide anche la promessa in volo, quindi le due richieste concorrenti diventano una.
// TTL corto: `runningCount` e `desiredCount` vengono da qui, e la risposta ha comunque una cache di 30s.
const SERVICE_TTL_MS = Number(process.env.DADAGUARD_ECS_SERVICE_TTL_MS ?? 15_000)

// Una task definition, dato il suo ARN, è IMMUTABILE: una revisione non cambia più. Rileggerla non
// può dare un risultato diverso, quindi la cache non è un compromesso — è la verità, letta una volta.
// Un deploy registra una revisione NUOVA, cioè una chiave nuova: si invalida da sé.
const TASKDEF_TTL_MS = Number(process.env.DADAGUARD_TASKDEF_TTL_MS ?? 60 * 60 * 1000)

// ALB e target group: il DNS di un load balancer non cambia mai nella pratica (cambia se lo ricrei,
// e allora cambia anche l'ARN). Dieci minuti.
const ELB_TTL_MS = Number(process.env.DADAGUARD_ELB_TTL_MS ?? 10 * 60 * 1000)

// La salute dei target cambia in secondi (è il polso del servizio): TTL corto, come DescribeServices.
const HEALTH_TTL_MS = Number(process.env.DADAGUARD_TARGET_HEALTH_TTL_MS ?? 15_000)

const credKey = (aws) => `${aws?.region ?? ''}|${aws?.profile ?? ''}|${aws?.roleArn ?? ''}`

function describeService(cfg, aws) {
  return cached(`ecs:svc:${credKey(aws)}|${cfg.cluster}|${cfg.service}`, SERVICE_TTL_MS, async () => {
    const client = new ECSClient(clientOpts(aws))
    const out = await client.send(new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }))
    return out.services?.[0] ?? null
  })
}

function describeTaskDef(taskDefArn, aws) {
  return cached(`ecs:td:${credKey(aws)}|${taskDefArn}`, TASKDEF_TTL_MS, async () => {
    const client = new ECSClient(clientOpts(aws))
    return client.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn, include: ['TAGS'] }))
  })
}

// Endpoint pubblico di un servizio ECS dietro ALB (per la card): dal target group del servizio risalgo
// al load balancer e ne prendo il DNS SE internet-facing (interno → null). Best-effort: se le describe
// elbv2 falliscono NON rompe la card (l'endpoint è un extra). Permessi: elasticloadbalancing:Describe*.
async function ecsAlbUrl(svc, aws) {
  const tgArn = (svc.loadBalancers ?? [])[0]?.targetGroupArn
  if (!tgArn) return null // servizio senza LB (worker/interno) → nessun endpoint
  try {
    const elb = new ElasticLoadBalancingV2Client(clientOpts(aws))
    const tg = await cached(`elb:tg:${credKey(aws)}|${tgArn}`, ELB_TTL_MS, async () =>
      (await elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [tgArn] }))).TargetGroups?.[0],
    )
    const lbArn = tg?.LoadBalancerArns?.[0]
    if (!lbArn) return null
    const lb = await cached(`elb:lb:${credKey(aws)}|${lbArn}`, ELB_TTL_MS, async () =>
      (await elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [lbArn] }))).LoadBalancers?.[0],
    )
    return publicUrlOfLb(lb)
  } catch {
    return null
  }
}

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

// Come la salute dei target cambia lo stato del servizio. Pura/testabile, perché è la regola che
// decide se una card è rossa: va inchiodata, non dedotta leggendo il codice.
//   - nessun target o nessun dato → non si applica (lo stato resta quello dei task)
//   - zero sani con task voluti → GIÙ: i container girano ma il load balancer non manda traffico,
//     e per chi usa il servizio "non risponde" è esattamente essere giù
//   - alcuni sani su molti → ATTENZIONE, anche se i task risultano tutti su
//   - durante un deploy non si giudica: i target vecchi vanno in draining e i nuovi si registrano,
//     un rosso lì sarebbe un falso allarme a ogni rilascio
export function applyTargetHealth({ status, desiredCount = 0, deploying = false }, health) {
  if (deploying || !health || !health.total) return { status, changed: false }
  if (health.healthy === 0 && desiredCount > 0) return { status: 'down', changed: true }
  if (health.healthy < health.total && status === 'up') return { status: 'degraded', changed: true }
  return { status, changed: false }
}

// Salute dei TARGET dietro l'ALB: quanti bersagli il load balancer considera sani.
//
// Per un servizio INTERNO (dietro un ALB interno, come i microservizi di staging) è l'unico segnale di
// liveness ottenibile: una sonda HTTP da fuori non arriverà mai in quella VPC, né adesso né dopo un
// cutover — non è un problema di DNS, è che il servizio non è pubblico per costruzione.
//
// E dice una cosa che "task attivi" NON dice: un servizio può avere 2/2 container su e 0/2 target sani
// (health check che fallisce, target in draining, porta sbagliata). In quel caso il load balancer non
// gli manda traffico, cioè per chi lo usa è GIÙ — mentre il conteggio dei task lo mostrava verde.
// Nessun load balancer → null, e il segnale non si applica (non si inventa).
async function targetHealth(svc, aws) {
  const arns = (svc.loadBalancers ?? []).map((lb) => lb.targetGroupArn).filter(Boolean)
  if (!arns.length) return null
  try {
    const elb = new ElasticLoadBalancingV2Client(clientOpts(aws))
    const per = await Promise.all(
      arns.map((TargetGroupArn) =>
        cached(`elb:health:${credKey(aws)}|${TargetGroupArn}`, HEALTH_TTL_MS, async () => {
          const out = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn }))
          const desc = out.TargetHealthDescriptions ?? []
          return {
            total: desc.length,
            healthy: desc.filter((d) => d.TargetHealth?.State === 'healthy').length,
            // Chi è fuori e perché: la risposta ce l'ha già, e in una notifica è l'unica parte utile.
            bad: desc
              .filter((d) => d.TargetHealth?.State !== 'healthy')
              .map((d) => ({ id: d.Target?.Id ?? '?', reason: d.TargetHealth?.Reason ?? d.TargetHealth?.State ?? null })),
          }
        }),
      ),
    )
    return per.reduce((a, b) => ({ total: a.total + b.total, healthy: a.healthy + b.healthy, bad: [...a.bad, ...b.bad] }), { total: 0, healthy: 0, bad: [] })
  } catch {
    return null // permesso mancante o chiamata fallita: nessun segnale, non un falso allarme
  }
}

// RuntimeProvider per ECS: desired vs running task count di un servizio.
// Permesso richiesto: ecs:DescribeServices.
export async function ecsRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const svc = await describeService(cfg, aws)
  if (!svc) return { status: 'unknown', reason: t('ecs.notfound') }

  const { status, desiredCount, runningCount, pendingCount, deploying } = classifyEcs(svc)
  const summary = deploying
    ? t('ecs.deploying', { running: runningCount, desired: desiredCount })
    : t('ecs.tasks', { running: runningCount, desired: desiredCount }) +
      (pendingCount > 0 ? t('ecs.pending', { n: pendingCount }) : '')

  const metrics = [
    {
      label: t('m.tasks'),
      value: `${runningCount}/${desiredCount}`,
      tone: deploying ? 'warning' : status === 'up' ? 'good' : status === 'down' ? 'critical' : status === 'degraded' ? 'warning' : undefined,
    },
  ]
  if (pendingCount > 0) metrics.push({ label: t('m.pending'), value: String(pendingCount), tone: 'warning' })

  // Salute dei target: per un servizio interno è l'unico segnale di liveness, e per uno pubblico dice
  // se il load balancer gli manda davvero traffico. Peggiora lo stato quando i container sono su ma
  // l'ALB non li considera sani — che per chi usa il servizio significa GIÙ.
  const [url, health] = await Promise.all([ecsAlbUrl(svc, aws), targetHealth(svc, aws)])
  if (health && health.total > 0 && !deploying) {
    metrics.push({
      label: t('m.targets'),
      value: `${health.healthy}/${health.total}`,
      tone: health.healthy === health.total ? 'good' : health.healthy === 0 ? 'critical' : 'warning',
    })
  }
  const { status: finalStatus } = applyTargetHealth({ status, desiredCount, deploying }, health)
  const targetiFuori = Boolean(health && health.total > 0 && health.healthy < health.total && !deploying)
  const finalSummary = targetiFuori
    ? `${summary} · ${t('ecs.targets', { healthy: health.healthy, total: health.total })}`
    : summary
  // In chat il conteggio dei task non spiega niente se il problema sta dietro al load balancer: qui si
  // dice quale target è fuori e con che motivo (dalla stessa risposta AWS già in mano).
  const alert =
    targetiFuori && (health.bad ?? []).length
      ? `${summary} · ${t(health.healthy === 0 ? 'alb.allunhealthy' : 'alb.unhealthy', {
          n: health.bad.length,
          total: health.total,
          list: unhealthyList(health.bad, t),
        })}`
      : undefined

  return {
    status: finalStatus,
    summary: finalSummary,
    ...(alert ? { alert } : {}),
    // Se il servizio è degradato DAI TARGET (container tutti su, load balancer che non manda traffico),
    // la notifica deve intestare la riga «target»: `task` nominerebbe il segnale che sta bene.
    ...(targetiFuori && status === 'up' ? { causeType: 'alb' } : {}),
    metrics,
    url,
    desiredCount,
    runningCount,
    pendingCount,
    deploying,
    targetHealth: health,
  }
}

// #2 build/deploy zero-config per ECS: tag immagine del task definition in uso
// + timestamp del deploy più recente. Permessi: ecs:DescribeServices,
// ecs:DescribeTaskDefinition. Ritorna { tag?, image?, deployedAt? } o null.
export async function ecsBuildInfo(cfg, aws) {
  const svc = await describeService(cfg, aws)
  if (!svc) return null

  // deploy più recente (PRIMARY) → timestamp; il task definition in uso è il suo.
  const deployments = svc.deployments ?? []
  const primary = deployments.find((d) => d.status === 'PRIMARY') ?? deployments[0]
  const deployedAt = primary?.createdAt ?? null
  const taskDefArn = primary?.taskDefinition ?? svc.taskDefinition
  if (!taskDefArn) return { deployedAt }

  const td = await describeTaskDef(taskDefArn, aws)
  // immagine del primo container (o quello che combacia col service, se dichiarato).
  const containers = td.taskDefinition?.containerDefinitions ?? []
  const image = (cfg.container ? containers.find((c) => c.name === cfg.container) : containers[0])?.image
  // Chi ha deployato: il tag `deployedBy` (la PERSONA, stampata dal buildspec) vince; in fallback
  // `registeredBy` (chi ha registrato la revision — spesso la pipeline).
  const deployedBy = (td.tags ?? []).find((t) => t.key === 'deployedBy')?.value
  return { tag: imageTag(image), image, deployedAt, modifiedBy: deployedBy || principalName(td.taskDefinition?.registeredBy) }
}

// "repo:tag" / "repo@sha256:…" → il tag NUDO (o le prime 12 cifre del digest).
// Niente prefisso ":": (a) in card si leggeva come un errore di sintassi (":0e89c21…"), (b) rompeva
// il confronto con la versione ATTESA dichiarata in config (`:v2` !== `v2` → falso mismatch).
export function imageTag(image) {
  if (!image) return null
  const at = image.indexOf('@sha256:')
  if (at !== -1) return image.slice(at + 8, at + 8 + 12)
  const colon = image.lastIndexOf(':')
  // evita di scambiare la porta del registry (host:port/repo) per un tag
  if (colon > image.lastIndexOf('/')) return image.slice(colon + 1)
  return null
}
