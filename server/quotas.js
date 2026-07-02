// Service Quotas vicine al limite, per account (on-demand). Read-only. Copre SOLO le quote che
// espongono un UsageMetric (un sottoinsieme): per quelle correla l'uso corrente (CloudWatch) col
// limite e segnala quelle ≥ soglia. Onesto sui limiti: non tutte le quote hanno una metrica d'uso.
// Permessi: servicequotas:ListServiceQuotas, cloudwatch:GetMetricData.
import { ServiceQuotasClient, ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas'
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'

// service code curati (estendibile): i più soggetti a saturazione.
const SERVICE_CODES = ['lambda', 'ec2', 'vpc', 'rds', 'dynamodb', 'kinesis', 'elasticloadbalancing']
const THRESHOLD = 0.8

async function quotasForCode(sq, cw, code) {
  const quotas = []
  let token
  do {
    const out = await sq.send(new ListServiceQuotasCommand({ ServiceCode: code, NextToken: token, MaxResults: 100 }))
    quotas.push(...(out.Quotas ?? []))
    token = out.NextToken
  } while (token)

  const withUsage = quotas.filter(
    (q) => q.UsageMetric?.MetricNamespace && q.UsageMetric?.MetricName && typeof q.Value === 'number',
  )
  if (!withUsage.length) return []

  const mkQuery = (q, i) => ({
    Id: `q${i}`,
    MetricStat: {
      Metric: {
        Namespace: q.UsageMetric.MetricNamespace,
        MetricName: q.UsageMetric.MetricName,
        Dimensions: Object.entries(q.UsageMetric.MetricDimensions ?? {}).map(([Name, Value]) => ({ Name, Value })),
      },
      Period: 3600,
      Stat: q.UsageMetric.MetricStatisticRecommendation || 'Maximum',
    },
    ReturnData: true,
  })

  const usage = new Map()
  for (let s = 0; s < withUsage.length; s += 500) {
    const slice = withUsage.slice(s, s + 500)
    const res = await cw.send(
      new GetMetricDataCommand({
        StartTime: new Date(Date.now() - 3600 * 1000),
        EndTime: new Date(),
        MetricDataQueries: slice.map((q, j) => mkQuery(q, s + j)),
      }),
    )
    for (const r of res.MetricDataResults ?? []) {
      const vals = r.Values ?? []
      if (vals.length) usage.set(Number(r.Id.slice(1)), Math.max(...vals))
    }
  }

  const out = []
  withUsage.forEach((q, i) => {
    const used = usage.get(i)
    if (used == null || !q.Value) return
    const pct = used / q.Value
    if (pct >= THRESHOLD) {
      out.push({ service: code, name: q.QuotaName, used, limit: q.Value, pct: Math.round(pct * 100) })
    }
  })
  return out
}

// Ritorna { accounts: [{ account, label, color, quotas: [...] , error? }] }.
export async function nearLimitQuotas(accounts, t = (k) => k) {
  const out = await Promise.all(
    Object.entries(accounts).map(async ([key, a]) => {
      if (!a.profile && !a.roleArn) return null
      const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: a.region }
      try {
        const sq = new ServiceQuotasClient(clientOpts(aws))
        const cw = new CloudWatchClient(clientOpts(aws))
        const lists = await Promise.all(SERVICE_CODES.map((c) => quotasForCode(sq, cw, c).catch(() => [])))
        const quotas = lists.flat().sort((x, y) => y.pct - x.pct)
        return { account: key, label: a.label ?? key, color: a.color ?? null, quotas }
      } catch (err) {
        return { account: key, label: a.label ?? key, color: a.color ?? null, error: cleanAwsReason(err, t) }
      }
    }),
  )
  return { accounts: out.filter(Boolean) }
}
