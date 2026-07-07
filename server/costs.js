import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer'
import { clientOpts } from './runtime/awsClient.js'

// Costo dell'account, mese corrente (MTD). Cost Explorer è GLOBALE → us-east-1, ~$0.01 a chiamata
// → SEMPRE on-demand. Separiamo per RECORD_TYPE: il CONSUMO (usage, per servizio) dai CREDITI/rimborsi,
// così il netto è leggibile → consumo lordo + crediti (negativi) = quanto paghi davvero.
// Intervallo del mese di riferimento per Cost Explorer (End è ESCLUSIVO). `month` = 'YYYY-MM'
// (assente/non valido → mese corrente). Per il mese in corso l'End è cappato a domani, così non si
// chiedono date future. Puro/testabile.
export function monthRange(month, now) {
  const valid = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)
  const y = valid ? Number(month.slice(0, 4)) : now.getUTCFullYear()
  const m = valid ? Number(month.slice(5, 7)) : now.getUTCMonth() + 1 // 1-12
  const start = `${y}-${String(m).padStart(2, '0')}-01`
  const firstOfNext = new Date(Date.UTC(y, m, 1)) // primo del mese successivo (End esclusivo)
  const tomorrow = new Date(now)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const end = (firstOfNext <= tomorrow ? firstOfNext : tomorrow).toISOString().slice(0, 10)
  return { start, end }
}

export async function getCosts({ profile, roleArn, externalId, month, accountId }) {
  const ce = new CostExplorerClient(clientOpts({ profile, roleArn, externalId, region: 'us-east-1' }))

  const { start, end } = monthRange(month, new Date())
  // Consolidated billing: il payer vede i costi di TUTTA l'org → senza filtro il suo card sommerebbe
  // anche gli altri account (doppioni). Quando l'id è noto, restringi al singolo account (LINKED_ACCOUNT).
  const filter = accountId ? { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } } : undefined

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
        Filter: filter,
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

// Costo PREVISTO per i giorni RESTANTI del mese corrente (Cost Explorer GetCostForecast, UNBLENDED_COST).
// Start = oggi (l'API non prevede il passato), End = primo del mese prossimo (esclusivo). Ritorna 0 se
// il mese è di fatto finito. Il chiamante somma questo alla spesa MTD → stima di fine mese. Puro-ish.
export async function getMonthEndForecast({ profile, roleArn, externalId, accountId }, now = new Date()) {
  const start = now.toISOString().slice(0, 10)
  const firstOfNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
  if (start >= firstOfNext) return 0 // ultimo giorno del mese → nessun residuo da prevedere
  const ce = new CostExplorerClient(clientOpts({ profile, roleArn, externalId, region: 'us-east-1' }))
  const res = await ce.send(
    new GetCostForecastCommand({
      TimePeriod: { Start: start, End: firstOfNext },
      Granularity: 'MONTHLY',
      Metric: 'UNBLENDED_COST',
      // stesso filtro per-account dei costi MTD, altrimenti il payer prevede l'intera org (doppioni)
      Filter: accountId ? { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } } : undefined,
    }),
  )
  return Number(res.Total?.Amount ?? 0)
}
