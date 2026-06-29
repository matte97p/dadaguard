import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer'
import { clientOpts } from './runtime/awsClient.js'

// Costo per servizio AWS dell'account, mese corrente (MTD). Cost Explorer è un servizio
// GLOBALE → endpoint us-east-1, e costa ~$0.01 a chiamata → SEMPRE on-demand, mai fetch-on-load.
export async function getCosts({ profile, roleArn, externalId }) {
  const ce = new CostExplorerClient(clientOpts({ profile, roleArn, externalId, region: 'us-east-1' }))

  const now = new Date()
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
  const endD = new Date(now)
  endD.setUTCDate(endD.getUTCDate() + 1) // End è esclusivo in CE: +1 giorno per includere oggi
  const end = endD.toISOString().slice(0, 10)

  const res = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  )

  const groups = res.ResultsByTime?.flatMap((r) => r.Groups ?? []) ?? []
  const items = groups
    .map((g) => ({
      service: g.Keys?.[0] ?? '—',
      amount: Number(g.Metrics?.UnblendedCost?.Amount ?? 0),
      unit: g.Metrics?.UnblendedCost?.Unit ?? 'USD',
    }))
    .filter((i) => Math.abs(i.amount) > 0.005) // tiene anche crediti/rimborsi (importi negativi)
    .sort((a, b) => b.amount - a.amount)

  const total = items.reduce((s, i) => s + i.amount, 0) // netto: crediti inclusi
  return { period: { start, end }, total, currency: items[0]?.unit ?? 'USD', items }
}
