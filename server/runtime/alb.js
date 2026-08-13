import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { clientOpts } from './awsClient.js'
import { awsState } from '../i18n.js'
import { truncateList } from '../util/format.js'


// I target NON sani, con il motivo che dà AWS (`Target.FailedHealthChecks`, `Target.Timeout`,
// `Elb.RegistrationInProgress`…): è la differenza tra «uno è fuori» e «sapere perché». Arriva dalla
// stessa `DescribeTargetHealth` che serviva per contarli — zero chiamate in più. Pura/testabile.
export function unhealthyList(bad) {
  return truncateList(bad.map((b) => (b.reason ? `${b.id} (${b.reason})` : b.id)))
}

// Endpoint pubblico di un load balancer (per la card): il DNS name SE è internet-facing (raggiungibile
// da fuori); interno → null (non lo mostro, non sarebbe cliccabile). Puro/testabile.
export function publicUrlOfLb(lb) {
  return lb?.Scheme === 'internet-facing' && lb?.DNSName ? `https://${lb.DNSName}` : null
}

// Quanti target sani vogliono dire «tutto a posto». Di norma tutti quelli registrati, ma non sempre:
// nel target group del WRITER di un cluster Postgres in replica, l'health check passa solo sul primario,
// quindi lo standby registrato è `unhealthy` PER COSTRUZIONE e lo stato di regime è 1 sano su 2. Senza
// questa distinzione quel servizio resta giallo per sempre, e un allarme che suona ogni giorno per il
// funzionamento normale insegna a ignorare il canale: il contrario di quello che serve. Pura/testabile.
//
// `atteso` non spegne il rosso: zero sani resta GIÙ anche se ne bastava uno. Un numero più alto dei
// target registrati vale come «tutti» (config vecchia, cluster ridimensionato: non si inventa un guasto).
export function albStatus(healthy, total, expected = null) {
  if (total === 0) return 'unknown'
  if (healthy === 0) return 'down'
  const atteso = Math.min(Number.isFinite(expected) && expected > 0 ? expected : total, total)
  return healthy >= atteso ? 'up' : 'degraded'
}

// RuntimeProvider per ALB: stato del LB + target healthy / totali (su tutti i target group).
// Permessi: elasticloadbalancing:Describe*.
// Config: aws: { type: alb, name: <lb-name> }  oppure  { type: alb, arn: <lb-arn> }
//         `expectedHealthy: <n>` = quanti sani sono la normalità (default: tutti)
export async function albRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const client = new ElasticLoadBalancingV2Client(clientOpts(aws))

  const lbOut = await client.send(
    new DescribeLoadBalancersCommand(cfg.arn ? { LoadBalancerArns: [cfg.arn] } : { Names: [cfg.name] }),
  )
  const lb = lbOut.LoadBalancers?.[0]
  if (!lb) return { status: 'unknown', reason: t('alb.notfound') }
  const url = publicUrlOfLb(lb) // endpoint pubblico (link sulla card), solo se internet-facing
  if (lb.State?.Code !== 'active') {
    return {
      status: lb.State?.Code === 'failed' ? 'down' : 'degraded',
      summary: t('alb.state', { code: awsState(lb.State?.Code, t) }),
      url,
    }
  }

  // Health dei target: se le describe falliscono (permessi, throttling) NON rompere la card —
  // il LB è comunque `active`, quindi degrada con un messaggio chiaro invece di sollevare.
  let healthy = 0
  let total = 0
  const bad = [] // chi è fuori e perché: la notizia è il target FUORI, non quelli dentro
  try {
    // paginazione target group (Marker/NextMarker): senza loop si ignorano i TG oltre la prima pagina.
    const tgs = []
    let marker
    do {
      const r = await client.send(
        new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn, Marker: marker }),
      )
      tgs.push(...(r.TargetGroups ?? []))
      marker = r.NextMarker
    } while (marker)
    for (const tg of tgs) {
      const th =
        (await client.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn })))
          .TargetHealthDescriptions ?? []
      total += th.length
      healthy += th.filter((x) => x.TargetHealth?.State === 'healthy').length
      for (const x of th) {
        if (x.TargetHealth?.State === 'healthy') continue
        bad.push({ id: x.Target?.Id ?? '?', reason: x.TargetHealth?.Reason ?? x.TargetHealth?.State ?? null })
      }
    }
  } catch {
    return { status: 'degraded', summary: t('alb.healthUnreachable'), url }
  }

  const atteso = Number.isFinite(cfg.expectedHealthy) ? Math.min(cfg.expectedHealthy, total) : total
  const status = albStatus(healthy, total, cfg.expectedHealthy)
  // In chat il conteggio da solo non basta: `alert` dice quanti sono fuori (non quanti sono dentro),
  // quali e con che motivo. La card tiene il conteggio, che accanto alla metrica è più leggibile.
  const alert = bad.length && status !== 'up'
    ? t(healthy === 0 ? 'alb.allunhealthy' : 'alb.unhealthy', {
        n: bad.length,
        total,
        list: unhealthyList(bad),
      })
    : undefined
  return {
    status,
    summary:
      total === 0
        ? t('alb.notarget')
        : t('alb.targets', { healthy, total }) + (atteso < total ? t('alb.expected', { n: atteso }) : ''),
    ...(alert ? { alert } : {}),
    metrics:
      total === 0
        ? undefined
        : [{ label: t('m.targets'), value: `${healthy}/${total}`, tone: status === 'up' ? 'good' : status === 'down' ? 'critical' : 'warning' }],
    url,
  }
}
