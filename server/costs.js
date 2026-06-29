import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer'
import { clientOpts } from './runtime/awsClient.js'

// Costo dell'account, mese corrente (MTD). Cost Explorer è GLOBALE → us-east-1, ~$0.01 a chiamata
// → SEMPRE on-demand. Separiamo per RECORD_TYPE: il CONSUMO (usage, per servizio) dai CREDITI/rimborsi,
// così il netto è leggibile → consumo lordo + crediti (negativi) = quanto paghi davvero.
export async function getCosts({ profile, roleArn, externalId }) {
  const ce = new CostExplorerClient(clientOpts({ profile, roleArn, externalId, region: 'us-east-1' }))

  const now = new Date()
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
  const endD = new Date(now)
  endD.setUTCDate(endD.getUTCDate() + 1) // End è esclusivo in CE: +1 giorno per includere oggi
  const end = endD.toISOString().slice(0, 10)

  // paginazione: con molti servizi i Groups arrivano su più pagine (NextPageToken) → vanno
  // accumulati tutti, altrimenti il consumo risulta troncato (e il netto sbagliato).
  const groups = []
  let pageToken
  do {
    const res = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: start, End: end },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        GroupBy: [
          { Type: 'DIMENSION', Key: 'SERVICE' },
          { Type: 'DIMENSION', Key: 'RECORD_TYPE' },
        ],
        NextPageToken: pageToken,
      }),
    )
    groups.push(...(res.ResultsByTime?.flatMap((r) => r.Groups ?? []) ?? []))
    pageToken = res.NextPageToken
  } while (pageToken)
  const usageByService = new Map()
  let credits = 0 // crediti + rimborsi (importi negativi)
  for (const g of groups) {
    const [service, recordType] = g.Keys ?? []
    const amt = Number(g.Metrics?.UnblendedCost?.Amount ?? 0)
    if (recordType === 'Credit' || recordType === 'Refund') {
      credits += amt
    } else {
      usageByService.set(service, (usageByService.get(service) ?? 0) + amt)
    }
  }

  // items = consumo per servizio (lordo, prima dei crediti)
  const items = [...usageByService.entries()]
    .map(([service, amount]) => ({ service, amount }))
    .filter((i) => Math.abs(i.amount) > 0.005)
    .sort((a, b) => b.amount - a.amount)

  const gross = items.reduce((s, i) => s + i.amount, 0) // consumo lordo
  const total = gross + credits // netto = consumo + crediti
  return { period: { start, end }, currency: 'USD', items, gross, credits, total }
}
