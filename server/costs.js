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
  const agg = aggregateMonth(groups)
  return { period: { start, end }, currency: 'USD', ...agg }
}

// Le AI non sono "un servizio come gli altri": da sole possono valere la maggior parte del conto
// (in Cato ~70%), e sommarle all'infrastruttura rende illeggibile l'andamento di QUEST'ULTIMA — sale
// l'uso dei modelli e sembra che sia cresciuto tutto. Bedrock è AWS; i modelli Claude sono fatturati
// via AWS Marketplace, non via Bedrock (vedi la trappola dei costi: non sono la stessa voce).
export function isAiService(service) {
  return /bedrock|marketplace/i.test(String(service ?? ''))
}

// Aggregazione dei gruppi [SERVICE, RECORD_TYPE] di un mese. Puro/testabile.
//
// I RECORD_TYPE non sono tutti consumo, e trattarli come tale è il modo classico di sbagliare il
// conto: `Credit`/`Refund` sono importi NEGATIVI (registrazioni, non uno sconto sul listino) e `Tax`
// è addebitata SOPRA il consumo. Prima le tasse finivano dentro il consumo per servizio, gonfiandolo.
//   consumo (listino) + tasse + crediti = quanto paghi davvero
export function aggregateMonth(groups = []) {
  const usageByService = new Map()
  let credits = 0 // crediti + rimborsi (negativi)
  let tax = 0
  let aiGross = 0
  for (const g of groups) {
    const [service, recordType] = g.Keys ?? []
    const amt = Number(g.Metrics?.UnblendedCost?.Amount ?? 0)
    if (recordType === 'Credit' || recordType === 'Refund') {
      credits += amt
      continue
    }
    if (recordType === 'Tax') {
      tax += amt
      continue
    }
    usageByService.set(service, (usageByService.get(service) ?? 0) + amt)
    if (isAiService(service)) aiGross += amt
  }

  // items = consumo per servizio (a listino, prima di crediti e tasse)
  const items = [...usageByService.entries()]
    .map(([service, amount]) => ({ service, amount }))
    .filter((i) => Math.abs(i.amount) > 0.005)
    .sort((a, b) => b.amount - a.amount)

  const gross = items.reduce((s, i) => s + i.amount, 0)
  return { items, gross, tax, credits, aiGross, infraGross: gross - aiGross, total: gross + tax + credits }
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

// ─── Trend: 13 mesi, consumo a listino vs fatturato ──────────────────────────────────────────────
// "Quanto costa" senza "sta crescendo?" non fa agire nessuno: un numero solo non distingue un mese
// caro da una tendenza. Una CHIAMATA sola copre tutti i mesi (granularità mensile su un periodo
// lungo), non una al mese: Cost Explorer si paga a richiesta.

// Finestra del trend: `months` mesi che FINISCONO col mese corrente (incluso, in corso). End è
// esclusivo → il primo del mese prossimo. Puro/testabile.
export function trendRange(now, months = 13) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-11
  const start = new Date(Date.UTC(y, m - (months - 1), 1))
  const end = new Date(Date.UTC(y, m + 1, 1))
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

// Un mese per riga, con le voci già separate (vedi aggregateMonth). `partial` marca il mese in corso:
// sul grafico va tratteggiato, altrimenti l'ultimo punto sembra un crollo (è solo un mese incompleto).
// Puro/testabile.
export function aggregateTrend(resultsByTime = [], nowMonth = null) {
  return resultsByTime.map((r) => {
    const month = String(r?.TimePeriod?.Start ?? '').slice(0, 7)
    const a = aggregateMonth(r?.Groups ?? [])
    return {
      month,
      usage: a.gross, // a listino, prima di crediti e tasse
      aiUsage: a.aiGross,
      infraUsage: a.infraGross,
      tax: a.tax,
      credits: a.credits,
      invoiced: a.total, // quanto pagato davvero
      partial: nowMonth ? month === nowMonth : false,
    }
  })
}

export async function getCostTrend({ profile, roleArn, externalId, accountId, months = 13, now = new Date() }) {
  const ce = new CostExplorerClient(clientOpts({ profile, roleArn, externalId, region: 'us-east-1' }))
  const { start, end } = trendRange(now, months)
  const filter = accountId ? { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } } : undefined
  const results = []
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
    // Paginando, lo STESSO mese può tornare su più pagine: i gruppi si fondono per mese, altrimenti
    // si otterrebbero due punti per lo stesso mese (e un grafico a zig-zag inventato).
    for (const r of res.ResultsByTime ?? []) {
      const seen = results.find((x) => x.TimePeriod?.Start === r.TimePeriod?.Start)
      if (seen) seen.Groups = [...(seen.Groups ?? []), ...(r.Groups ?? [])]
      else results.push({ ...r, Groups: [...(r.Groups ?? [])] })
    }
    pageToken = res.NextPageToken
  } while (pageToken)
  const nowMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return { currency: 'USD', months: aggregateTrend(results, nowMonth) }
}

// ─── Attribuzione per COMPONENTE (tag di allocazione costi) ──────────────────────────────────────
// Il servizio AWS dice COSA costa (RDS, S3), il tag dice DI CHI è (avvista-db, teleport): è il
// secondo che fa decidere. Richiede che il tag sia attivato come "cost allocation tag" — se non lo è,
// Cost Explorer risponde con tutto in `untagged` (e lo diciamo, invece di mostrare una lista vuota).
// Il nome del tag è CASE-SENSITIVE in Cost Explorer, e sbagliare la maiuscola non dà errore: dà
// tutto "non taggato". In Cato il tag attivo è `Component` (verificato con
// `aws ce list-cost-allocation-tags --status Active`, che è anche il modo di controllarlo altrove).
export const COMPONENT_TAG = process.env.DADAGUARD_COMPONENT_TAG || 'Component'

// Gruppi [TAG, SERVICE] → componenti ordinati per spesa, ognuno col dettaglio per servizio AWS.
// Le chiavi TAG arrivano come `chiave$valore` (valore vuoto = risorsa non taggata). Puro/testabile.
//
// Qui NON si filtrano crediti e tasse: Cost Explorer ammette due soli raggruppamenti, e con
// [TAG, SERVICE] il tipo di record non arriva affatto. L'esclusione la fa la QUERY (vedi
// `notCreditsOrTax`), altrimenti i crediti — che sono negativi — si sottrarrebbero al componente
// sbagliato e l'attribuzione mentirebbe.
export function aggregateComponents(groups = [], tagKey = COMPONENT_TAG) {
  const byComponent = new Map()
  for (const g of groups) {
    const [rawTag, service] = g.Keys ?? []
    const amt = Number(g.Metrics?.UnblendedCost?.Amount ?? 0)
    const value = String(rawTag ?? '').slice(String(tagKey).length + 1) // via il prefisso `chiave$`
    const key = value || null // null = non taggato: la UI lo dice a parole, non lo nasconde
    if (!byComponent.has(key)) byComponent.set(key, { component: key, amount: 0, services: new Map() })
    const c = byComponent.get(key)
    c.amount += amt
    c.services.set(service, (c.services.get(service) ?? 0) + amt)
  }
  return [...byComponent.values()]
    .map((c) => ({
      component: c.component,
      amount: c.amount,
      services: [...c.services.entries()]
        .map(([service, amount]) => ({ service, amount }))
        .filter((i) => Math.abs(i.amount) > 0.005)
        .sort((a, b) => b.amount - a.amount),
    }))
    .filter((c) => Math.abs(c.amount) > 0.005)
    .sort((a, b) => b.amount - a.amount)
}

// Solo consumo: crediti/rimborsi (negativi) e tasse (addebitate sopra) non appartengono a un
// componente. Combinato con l'eventuale filtro account — `And` vuole almeno due termini, quindi con
// un solo termine si passa quello nudo.
export function notCreditsOrTax(accountFilter) {
  const notRecords = { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund', 'Tax'] } } }
  return accountFilter ? { And: [accountFilter, notRecords] } : notRecords
}

export async function getCostByComponent({ profile, roleArn, externalId, accountId, month, tagKey = COMPONENT_TAG }) {
  const ce = new CostExplorerClient(clientOpts({ profile, roleArn, externalId, region: 'us-east-1' }))
  const { start, end } = monthRange(month, new Date())
  const account = accountId ? { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } } : undefined
  const filter = notCreditsOrTax(account)
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
          { Type: 'TAG', Key: tagKey },
          { Type: 'DIMENSION', Key: 'SERVICE' },
        ],
        NextPageToken: pageToken,
      }),
    )
    groups.push(...(res.ResultsByTime?.flatMap((r) => r.Groups ?? []) ?? []))
    pageToken = res.NextPageToken
  } while (pageToken)
  const components = aggregateComponents(groups, tagKey)
  return { period: { start, end }, currency: 'USD', tagKey, components }
}
