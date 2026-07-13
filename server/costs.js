import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer'
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

// Proiezione di fine mese ("run-rate"): la spesa MTD estrapolata linearmente sui giorni del mese —
// "a questo ritmo, a fine mese avrai speso X". Deterministica, niente ML/GetCostForecast (coerente con
// l'ethos no-LLM dell'app; nessuna chiamata extra a pagamento né permesso IAM in più):
//   factor = giorniDelMese / giorniTrascorsi.
// Deriva tutto dal `period` già calcolato da getCosts (start incluso, end ESCLUSIVO = domani per il
// mese corrente), quindi per un mese PASSATO i giorni trascorsi eguagliano quelli del mese → factor 1
// → nessuna estrapolazione (ritorna null). Proietta sia il netto (post-crediti, il numero grande) sia
// il lordo (consumo). NB early-month = pochi giorni → factor alto e stima rumorosa: il chiamante mostra
// sempre la base "su X/Y giorni" così è trasparente. Pura/testabile.
export function monthEndProjection({ gross = 0, total = 0, period } = {}) {
  if (!period?.start || !period?.end) return null
  const start = new Date(`${period.start}T00:00:00Z`)
  const end = new Date(`${period.end}T00:00:00Z`) // esclusivo
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
  const daysElapsed = Math.round((end - start) / 86_400_000) // giorni coperti dall'MTD (end esclusivo)
  if (daysElapsed <= 0 || daysElapsed >= daysInMonth) return null // mese completo → niente da proiettare
  const factor = daysInMonth / daysElapsed
  return {
    daysElapsed,
    daysInMonth,
    pct: Math.round((daysElapsed / daysInMonth) * 100),
    gross: gross * factor,
    net: total * factor,
  }
}
