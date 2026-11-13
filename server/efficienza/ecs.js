import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs'
import {
  ApplicationAutoScalingClient,
  DescribeScalableTargetsCommand,
  DescribeScheduledActionsCommand,
} from '@aws-sdk/client-application-auto-scaling'
import { ElasticLoadBalancingV2Client, DescribeTargetGroupsCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { clientOpts } from '../runtime/awsClient.js'
import { cached } from '../util/ttlcache.js'
import { serieOrarie, perOra } from './serie.js'
import { costoOraTask, quotaSpot, tagliaGiusta, percentile, eccessoMinimo, ORE_MESE } from './regole.js'

// Calcolo: TUTTI i servizi ECS su Fargate di un account, scoperti da ListClusters/ListServices (non dalla
// watchlist: un servizio non monitorato costa lo stesso). Per ognuno: taglia del task, quanti task, quanti
// su Spot, autoscaling, uso orario da CloudWatch e richieste dal load balancer.
//
// Permessi: ecs:ListClusters, ecs:ListServices, ecs:DescribeServices, ecs:DescribeTaskDefinition,
// application-autoscaling:DescribeScalableTargets, application-autoscaling:DescribeScheduledActions,
// elasticloadbalancing:DescribeTargetGroups, cloudwatch:GetMetricData. Tutti in sola lettura.
//
// I task su istanze EC2 si pagano per istanza, non per task: restano fuori, e il conteggio lo dice.

const GIORNO = 24 * 60 * 60 * 1000
const GIORNI_TAGLIA = 14 // il picco per la taglia giusta: due settimane, così il lunedì c'è due volte

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))
const nomeDaArn = (arn) => String(arn ?? '').split('/').pop()
// Dimensione CloudWatch di un ARN di load balancer o target group: la parte dopo `loadbalancer/` o
// dopo i due punti finali (`targetgroup/nome/id`).
export function dimensioneAlb(arn) {
  const s = String(arn ?? '')
  const lb = s.split(':loadbalancer/')[1]
  if (lb) return lb
  const tg = s.split(':')[5]
  return tg?.startsWith('targetgroup/') ? tg : null
}

async function tutte(fn) {
  const out = []
  let tok
  let pagine = 0
  do {
    const r = await fn(tok)
    out.push(...r.items)
    tok = r.next
  } while (tok && ++pagine < 50)
  return out
}

function taskDef(ecs, arn) {
  // Una revisione di task definition non cambia mai: si legge una volta al giorno al massimo.
  return cached(`eff:taskdef:${arn}`, GIORNO, async () => {
    const r = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }))
    const td = r.taskDefinition ?? {}
    return {
      cpu: Number(td.cpu) || null,
      memMb: Number(td.memory) || null,
      arch: td.runtimePlatform?.cpuArchitecture === 'ARM64' ? 'arm' : 'x86',
      fargate: (td.requiresCompatibilities ?? []).includes('FARGATE'),
    }
  })
}

// Il servizio gira su Fargate? Dal launch type o dalla capacity provider strategy.
export function suFargate(svc) {
  if (svc.launchType) return svc.launchType === 'FARGATE'
  const cp = svc.capacityProviderStrategy ?? []
  return cp.length > 0 && cp.every((p) => /^FARGATE/.test(p.capacityProvider ?? ''))
}

export async function calcoloAccount(aws, { giorni, prezzi, tagSquadra }) {
  const ecs = new ECSClient(clientOpts(aws))
  const clusters = await tutte(async (nextToken) => {
    const r = await ecs.send(new ListClustersCommand({ nextToken }))
    return { items: r.clusterArns ?? [], next: r.nextToken }
  })
  const servizi = []
  let suEc2 = 0
  for (const cluster of clusters) {
    const arns = await tutte(async (nextToken) => {
      const r = await ecs.send(new ListServicesCommand({ cluster, nextToken, maxResults: 100 }))
      return { items: r.serviceArns ?? [], next: r.nextToken }
    })
    for (const gruppo of chunk(arns, 10)) {
      const r = await ecs.send(new DescribeServicesCommand({ cluster, services: gruppo, include: ['TAGS'] }))
      for (const s of r.services ?? []) {
        if (s.status !== 'ACTIVE') continue
        if (!suFargate(s)) {
          suEc2++
          continue
        }
        servizi.push({ s, cluster: nomeDaArn(cluster) })
      }
    }
  }

  const dettagli = await Promise.all(servizi.map(({ s }) => taskDef(ecs, s.taskDefinition).catch(() => null)))

  // Autoscaling e pianificazioni: in blocchi da 50 risorse.
  const scala = new Map()
  const pianificati = new Set()
  const aas = new ApplicationAutoScalingClient(clientOpts(aws))
  const risorse = servizi.map(({ s, cluster }) => `service/${cluster}/${s.serviceName}`)
  for (const gruppo of chunk(risorse, 50)) {
    // Senza il permesso l'autoscaling resta sconosciuto: il servizio si vede, l'elasticità no.
    try {
      const r = await aas.send(new DescribeScalableTargetsCommand({ ServiceNamespace: 'ecs', ResourceIds: gruppo }))
      for (const t of r.ScalableTargets ?? []) scala.set(t.ResourceId, { min: t.MinCapacity, max: t.MaxCapacity })
    } catch {}
    // Un servizio che ha già azioni pianificate (spento la notte, scalato la mattina) non riceve la
    // proposta di spegnimento fuori orario: qualcuno l'ha già fatto.
    try {
      const p = await aas.send(new DescribeScheduledActionsCommand({ ServiceNamespace: 'ecs', ResourceIds: gruppo }))
      for (const a of p.ScheduledActions ?? []) pianificati.add(a.ResourceId)
    } catch {}
  }

  // Load balancer dei target group, per contare le richieste.
  const tgArns = [...new Set(servizi.flatMap(({ s }) => (s.loadBalancers ?? []).map((l) => l.targetGroupArn).filter(Boolean)))]
  const lbDiTg = new Map()
  const elb = new ElasticLoadBalancingV2Client(clientOpts(aws))
  for (const gruppo of chunk(tgArns, 20)) {
    try {
      const r = await elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: gruppo }))
      for (const tg of r.TargetGroups ?? []) if (tg.LoadBalancerArns?.[0]) lbDiTg.set(tg.TargetGroupArn, tg.LoadBalancerArns[0])
    } catch {
      // le richieste restano sconosciute: il costo per richiesta non compare, il resto sì
    }
  }

  // Serie orarie: 4 metriche per servizio sulla finestra, più le richieste del suo target group.
  const query = []
  servizi.forEach(({ s, cluster }, i) => {
    const dim = { ClusterName: cluster, ServiceName: s.serviceName }
    query.push(
      { id: `c${i}`, namespace: 'AWS/ECS', metrica: 'CPUUtilization', dimensioni: dim, stat: 'Average' },
      { id: `p${i}`, namespace: 'AWS/ECS', metrica: 'CPUUtilization', dimensioni: dim, stat: 'p95' },
      { id: `m${i}`, namespace: 'AWS/ECS', metrica: 'MemoryUtilization', dimensioni: dim, stat: 'p95' },
      { id: `t${i}`, namespace: 'ECS/ContainerInsights', metrica: 'RunningTaskCount', dimensioni: dim, stat: 'Average' },
    )
    const tg = (s.loadBalancers ?? []).map((l) => l.targetGroupArn).find((a) => lbDiTg.has(a))
    if (tg) {
      query.push({
        id: `r${i}`,
        namespace: 'AWS/ApplicationELB',
        metrica: 'RequestCount',
        dimensioni: { LoadBalancer: dimensioneAlb(lbDiTg.get(tg)), TargetGroup: dimensioneAlb(tg) },
        stat: 'Sum',
      })
    }
  })
  const serie = await serieOrarie(aws, query, giorni)

  const daQuando = Date.now() - GIORNI_TAGLIA * GIORNO
  return {
    suEc2,
    servizi: servizi.map(({ s, cluster }, i) => {
      const td = dettagli[i] ?? {}
      const listino = prezzi?.[td.arch] ?? prezzi?.x86 ?? null
      const ore = perOra({ cpu: serie[`c${i}`], task: serie[`t${i}`] })
      const conTask = ore.some(([, o]) => o.task != null)
      const taskStimati = !conTask // senza Container Insights: il numero di task di adesso per ogni ora
      const taskOra = (o) => (o.task != null ? o.task : s.runningCount ?? 0)
      const vcpu = (td.cpu ?? 0) / 1024
      const quota = quotaSpot(s.capacityProviderStrategy, Math.max(1, s.runningCount ?? 1))
      const costoOra = costoOraTask({ cpu: td.cpu, memMb: td.memMb, quotaSpot: quota }, listino)
      const taskMedi = ore.length ? ore.reduce((a, [, o]) => a + taskOra(o), 0) / ore.length : s.runningCount ?? 0
      const recenti = (k) => serie[`${k}${i}`].filter(([t]) => t >= daQuando).map(([, v]) => v)
      const cpuP95 = percentile(recenti('p'), 0.95)
      const memP95 = percentile(recenti('m'), 0.95)
      const proposta = tagliaGiusta({ cpu: td.cpu, memMb: td.memMb, cpuP95, memP95 }, listino)
      const sc = scala.get(`service/${cluster}/${s.serviceName}`) ?? null
      const orarie = ore.map(([t, o]) => ({ t, task: taskOra(o), vcpuUsate: (taskOra(o) * vcpu * (o.cpu ?? 0)) / 100 }))
      const giornaliero = new Map()
      for (const o of orarie) {
        const g = new Date(o.t).toISOString().slice(0, 10)
        const d = giornaliero.get(g) ?? { giorno: g, pagate: 0, usate: 0 }
        d.pagate += o.task * vcpu
        d.usate += o.vcpuUsate
        giornaliero.set(g, d)
      }
      const richieste = serie[`r${i}`]?.length ? serie[`r${i}`].reduce((a, [, v]) => a + v, 0) : null
      return {
        cluster,
        nome: s.serviceName,
        squadra: (s.tags ?? []).find((t) => t.key === tagSquadra)?.value ?? null,
        cpu: td.cpu,
        memMb: td.memMb,
        arch: td.arch ?? 'x86',
        desiderati: s.desiredCount ?? 0,
        attivi: s.runningCount ?? 0,
        taskMedi,
        taskStimati,
        quotaSpot: quota,
        bilanciato: (s.loadBalancers ?? []).length > 0,
        min: sc?.min ?? null,
        max: sc?.max ?? null,
        pianificato: pianificati.has(`service/${cluster}/${s.serviceName}`),
        cpuP95,
        memP95,
        costoOraTask: costoOra,
        usdMese: costoOra != null ? costoOra * taskMedi * ORE_MESE : null,
        proposta,
        eccessoMinimoTaskOra: sc ? eccessoMinimo({ minimo: sc.min, vcpuTask: vcpu, ore: orarie }) : 0,
        richieste,
        giornaliero: [...giornaliero.values()],
        // vCPU usate per ora (per la settimana tipo dell'account), compatte: [ms, vCPU]
        orarie: orarie.map((o) => [o.t, o.vcpuUsate]),
        listino,
      }
    }),
  }
}
