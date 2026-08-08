// Budget AWS e anomalie di costo — il pezzo di FinOps che manca a una dashboard di coerenza.
//
// La pagina Costi dice quanto stai spendendo. Non dice se quella cifra è dentro o fuori da quello che
// avevi deciso di spendere: quel numero vive nei budget AWS, che avvisano su Slack e poi non compaiono
// da nessuna parte. Un budget al 92% a metà mese è un fatto operativo — chi legge la dashboard
// dovrebbe vederlo senza andare a cercarlo nella console di fatturazione.
//
// Le ANOMALIE sono l'altra metà: AWS confronta la spesa col proprio modello e segnala lo scostamento
// (un cron che gira 100 volte invece di una si vede lì prima che si veda in bolletta).
//
// Permessi: `budgets:ViewBudget` (per account) e `ce:GetAnomalies` (solo dal payer: la rilevazione è
// org-wide). L'azione NON si chiama come l'operazione: l'SDK chiama `DescribeBudgets`, ma l'azione IAM
// che la autorizza è `ViewBudget` — un `budgets:DescribeBudgets` non esiste, e IAM lo accetterebbe in
// silenzio lasciando una policy che sembra concedere e non concede.
// Entrambi ENDPOINT GLOBALI → us-east-1, come Cost Explorer.
// Read-only. Cachati: sono dati che AWS aggiorna qualche volta al giorno.
import { BudgetsClient, DescribeBudgetsCommand } from '@aws-sdk/client-budgets'
import { CostExplorerClient, GetAnomaliesCommand } from '@aws-sdk/client-cost-explorer'
import { clientOpts } from './runtime/awsClient.js'
import { cachedCall } from './util/cache.js'

const TTL_MS = 30 * 60 * 1000 // i budget si aggiornano ~3 volte al giorno: mezz'ora non perde nulla
const GLOBAL = 'us-east-1'

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Un budget AWS → forma per la UI. `actual` è la spesa a oggi, `forecast` la proiezione di AWS a fine
// periodo: sono due domande diverse ("sono già fuori?" e "ci finirò fuori?") e si mostrano entrambe,
// perché un budget al 60% a metà mese può avere una proiezione al 130%. Puro/testabile.
export function mapBudget(b = {}) {
  const limit = num(b.BudgetLimit?.Amount)
  const actual = num(b.CalculatedSpend?.ActualSpend?.Amount)
  const forecast = num(b.CalculatedSpend?.ForecastedSpend?.Amount)
  return {
    name: b.BudgetName ?? null,
    type: b.BudgetType ?? null, // COST | USAGE | …
    unit: b.BudgetLimit?.Unit ?? null, // USD, o l'unità se è un budget di USAGE
    timeUnit: b.TimeUnit ?? null, // MONTHLY | QUARTERLY | ANNUALLY
    limit,
    actual,
    forecast,
    actualPct: limit ? Math.round(((actual ?? 0) / limit) * 100) : null,
    forecastPct: limit && forecast != null ? Math.round((forecast / limit) * 100) : null,
  }
}

// Severità di un budget, per ordinare e colorare. Lo SFORAMENTO PREVISTO conta come lo sforamento
// già avvenuto: se la proiezione dice 130%, aspettare che il consumo ci arrivi non cambia l'esito,
// toglie solo il tempo per intervenire. Puro/testabile.
export function budgetLevel({ actualPct, forecastPct } = {}) {
  const a = actualPct ?? 0
  const f = forecastPct ?? 0
  if (a >= 100) return 'over' // già sforato
  if (f >= 100) return 'willOver' // ci finirà dentro il periodo
  if (a >= 80 || f >= 90) return 'warn'
  return 'ok'
}

const LEVEL_ORDER = { over: 0, willOver: 1, warn: 2, ok: 3 }

// Anomalia Cost Explorer → forma per la UI. `impact` è la differenza in valuta fra la spesa vista e
// quella attesa dal modello di AWS: è il numero che dice se vale la pena guardare. Puro/testabile.
export function mapAnomaly(a = {}) {
  const total = num(a.Impact?.TotalImpact)
  const expected = num(a.Impact?.TotalExpectedSpend)
  const actual = num(a.Impact?.TotalActualSpend)
  return {
    id: a.AnomalyId ?? null,
    start: a.AnomalyStartDate ?? null,
    end: a.AnomalyEndDate ?? null,
    // `RootCauses` porta servizio/regione/account/tipo d'uso: si tiene il primo, che è quello che
    // AWS considera la causa principale. Il resto è rumore in una riga di dashboard.
    service: a.RootCauses?.[0]?.Service ?? null,
    region: a.RootCauses?.[0]?.Region ?? null,
    account: a.RootCauses?.[0]?.LinkedAccountName ?? a.RootCauses?.[0]?.LinkedAccount ?? null,
    usageType: a.RootCauses?.[0]?.UsageType ?? null,
    impact: total,
    expected,
    actual,
    impactPct: expected ? Math.round(((total ?? 0) / expected) * 100) : null,
    feedback: a.Feedback ?? null, // se qualcuno l'ha già marcata come normale, dirlo
  }
}

// Budget di UN account. `accountId` è obbligatorio per l'API: senza, non si chiede (e non si inventa
// un risultato vuoto che sembrerebbe "nessun budget").
export async function listBudgets({ profile, roleArn, externalId, accountId } = {}) {
  if (!accountId) return { budgets: [], noAccountId: true }
  const client = new BudgetsClient(clientOpts({ profile, roleArn, externalId, region: GLOBAL }))
  const budgets = []
  let token
  do {
    const out = await client.send(new DescribeBudgetsCommand({ AccountId: accountId, MaxResults: 100, NextToken: token }))
    budgets.push(...(out.Budgets ?? []))
    token = out.NextToken
  } while (token)
  const mapped = budgets
    .map(mapBudget)
    .map((b) => ({ ...b, level: budgetLevel(b) }))
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (b.actualPct ?? 0) - (a.actualPct ?? 0))
  return { budgets: mapped }
}

// Anomalie di costo degli ultimi `days` giorni. Si chiede DAL PAYER: la rilevazione è configurata lì
// e copre tutta l'organizzazione, quindi una chiamata sola risponde per tutti gli account.
export async function listAnomalies({ profile, roleArn, externalId } = {}, { days = 30, minImpact = 1, now = Date.now() } = {}) {
  const ce = new CostExplorerClient(clientOpts({ profile, roleArn, externalId, region: GLOBAL }))
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
  const out = await ce.send(
    new GetAnomaliesCommand({
      DateInterval: { StartDate: iso(now - days * 86_400_000), EndDate: iso(now) },
      MaxResults: 100,
    }),
  )
  return (out.Anomalies ?? [])
    .map(mapAnomaly)
    // Sotto la soglia sono centesimi di scostamento su servizi minuscoli: mostrarli insegna a
    // ignorare la sezione, che è l'unico modo di rendere inutile un allarme.
    .filter((a) => (a.impact ?? 0) >= minImpact)
    .sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0))
}

// Budget per account + anomalie org-wide, cachati. Ogni account porta il suo errore: `budgets` non è
// concesso a tutti i ruoli e un account che non risponde non deve spegnere la sezione.
export async function budgetsOverview(accounts = {}, { orgCreds = null, isQueryable = () => true, cleanReason = (e) => e.message, lang = '' } = {}) {
  // La lingua sta nella chiave perché in questa risposta ci sono anche i MESSAGGI D'ERRORE, già
  // tradotti: senza, il primo che apre la pagina decide in che lingua li legge chiunque altro per
  // mezz'ora.
  return cachedCall(`budgets:overview:${lang}`, TTL_MS, async () => {
    const perAccount = {}
    await Promise.all(
      Object.entries(accounts).map(async ([key, a]) => {
        if (!isQueryable(a)) return
        try {
          const { budgets, noAccountId } = await listBudgets({ profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, accountId: a.accountId })
          perAccount[key] = { label: a.label ?? key, color: a.color ?? null, budgets, noAccountId: !!noAccountId }
        } catch (err) {
          perAccount[key] = { label: a.label ?? key, color: a.color ?? null, error: cleanReason(err) }
        }
      }),
    )
    let anomalies = []
    let anomaliesError = null
    try {
      anomalies = await listAnomalies(orgCreds ?? {})
    } catch (err) {
      anomaliesError = cleanReason(err)
    }
    return { accounts: perAccount, anomalies, anomaliesError }
  })
}
