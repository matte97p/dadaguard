// Spesa giornaliera: Cost Explorer con granularita' DAILY sugli ultimi 30 giorni, oggi compreso.
// Ogni chiamata costa 0,01 $ e il dato si aggiorna poche volte al giorno, quindi la cache e' lunga
// (vedi la rotta). Solo consumo (RECORD_TYPE Usage): i crediti arrivano a fine mese in blocco e una
// colonna negativa a caso nel grafico dei giorni non dice niente di quanto si e' speso quel giorno.
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer'
import { clientOpts } from '../runtime/awsClient.js'

const ymd = (d) => d.toISOString().slice(0, 10)

// [inizio, fine) per 30 giorni che finiscono OGGI incluso (End esclusivo = domani). Puro.
export function intervallo30(now = new Date(), giorni = 30) {
  const fine = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  const inizio = new Date(fine.getTime() - giorni * 86_400_000)
  return { start: ymd(inizio), end: ymd(fine) }
}

// ResultsByTime → [{ giorno, importo }] più la spesa di oggi (l'ultimo giorno, parziale). Puro.
export function aggregaGiorni(resultsByTime = [], oggi = ymd(new Date())) {
  const giorni = resultsByTime.map((r) => ({
    giorno: r.TimePeriod?.Start,
    importo: Math.round(Number(r.Total?.UnblendedCost?.Amount ?? 0) * 100) / 100,
  }))
  return { giorni, oggi: giorni.find((g) => g.giorno === oggi)?.importo ?? 0 }
}

export async function spesaGiornaliera({ profile, roleArn, externalId, accountId } = {}, now = new Date()) {
  const ce = new CostExplorerClient(clientOpts({ profile, roleArn, externalId, region: 'us-east-1' }))
  const { start, end } = intervallo30(now)
  const usage = { Dimensions: { Key: 'RECORD_TYPE', Values: ['Usage'] } }
  // Stesso motivo di `getCosts`: sul payer senza filtro per account si sommerebbe tutta l'org.
  const filter = accountId ? { And: [usage, { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [String(accountId)] } }] } : usage
  const out = await ce.send(
    new GetCostAndUsageCommand({ TimePeriod: { Start: start, End: end }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], Filter: filter }),
  )
  return { period: { start, end }, currency: 'USD', ...aggregaGiorni(out.ResultsByTime ?? [], ymd(now)) }
}
