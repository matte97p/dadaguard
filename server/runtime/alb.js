import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per ALB: stato del LB + target healthy / totali (su tutti i target group).
// Permessi: elasticloadbalancing:Describe*.
// Config: aws: { type: alb, name: <lb-name> }  oppure  { type: alb, arn: <lb-arn> }
export async function albRuntime(cfg, aws) {
  const client = new ElasticLoadBalancingV2Client(clientOpts(aws))

  const lbOut = await client.send(
    new DescribeLoadBalancersCommand(cfg.arn ? { LoadBalancerArns: [cfg.arn] } : { Names: [cfg.name] }),
  )
  const lb = lbOut.LoadBalancers?.[0]
  if (!lb) return { status: 'unknown', reason: 'load balancer non trovato' }
  if (lb.State?.Code !== 'active') {
    return {
      status: lb.State?.Code === 'failed' ? 'down' : 'degraded',
      summary: `stato ${lb.State?.Code}`,
    }
  }

  const tgs =
    (await client.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn })))
      .TargetGroups ?? []
  let healthy = 0
  let total = 0
  for (const tg of tgs) {
    const th =
      (await client.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn })))
        .TargetHealthDescriptions ?? []
    total += th.length
    healthy += th.filter((t) => t.TargetHealth?.State === 'healthy').length
  }

  const status = total === 0 ? 'unknown' : healthy >= total ? 'up' : healthy === 0 ? 'down' : 'degraded'
  return { status, summary: total === 0 ? 'nessun target' : `${healthy}/${total} target healthy` }
}
