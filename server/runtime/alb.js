import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { clientOpts } from './awsClient.js'

// Endpoint pubblico di un load balancer (per la card): il DNS name SE è internet-facing (raggiungibile
// da fuori); interno → null (non lo mostro, non sarebbe cliccabile). Puro/testabile.
export function publicUrlOfLb(lb) {
  return lb?.Scheme === 'internet-facing' && lb?.DNSName ? `https://${lb.DNSName}` : null
}

// RuntimeProvider per ALB: stato del LB + target healthy / totali (su tutti i target group).
// Permessi: elasticloadbalancing:Describe*.
// Config: aws: { type: alb, name: <lb-name> }  oppure  { type: alb, arn: <lb-arn> }
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
      summary: t('alb.state', { code: lb.State?.Code }),
      url,
    }
  }

  // Health dei target: se le describe falliscono (permessi, throttling) NON rompere la card —
  // il LB è comunque `active`, quindi degrada con un messaggio chiaro invece di sollevare.
  let healthy = 0
  let total = 0
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
    }
  } catch {
    return { status: 'degraded', summary: t('alb.healthUnreachable'), url }
  }

  const status = total === 0 ? 'unknown' : healthy >= total ? 'up' : healthy === 0 ? 'down' : 'degraded'
  return {
    status,
    summary: total === 0 ? t('alb.notarget') : t('alb.targets', { healthy, total }),
    metrics: total === 0 ? undefined : [{ label: t('m.targets'), value: `${healthy}/${total}`, tone: healthy >= total ? 'good' : healthy === 0 ? 'critical' : 'warning' }],
    url,
  }
}
