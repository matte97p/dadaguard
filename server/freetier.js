import { FreeTierClient, GetFreeTierUsageCommand } from '@aws-sdk/client-freetier'
import { clientOpts } from './runtime/awsClient.js'

// Uso del Free Tier AWS (es. CodeBuild 100 build-min/mese). È un dato AGGREGATO a livello di
// organizzazione, visibile SOLO dal payer/management → si interroga una volta sola con l'identità
// `org` del config (o la catena di default = il task role, se Dadaguard gira nel payer). Endpoint
// globale → us-east-1. Read-only.

// Righe API Free Tier → forma pulita { service, usageType, region, unit, used, limit, forecast, pct }.
// pct = used/limit (0 se limit mancante); ordinate per pct desc → le voci a rischio in cima
// (es. CodeBuild oltre i 100 min). Pura/testabile.
export function summarizeFreeTier(usages = []) {
  return usages
    .map((u) => {
      const used = Number(u.actualUsageAmount ?? 0)
      const limit = Number(u.limit ?? 0)
      const forecast = Number(u.forecastedUsageAmount ?? 0)
      return {
        service: u.service ?? '',
        usageType: u.usageType ?? '',
        region: u.region ?? null,
        unit: u.unit ?? '',
        used,
        limit,
        forecast,
        pct: limit > 0 ? Math.round((used / limit) * 100) : 0,
      }
    })
    .sort((a, b) => b.pct - a.pct)
}

export async function getFreeTierUsage({ profile, roleArn, externalId } = {}) {
  const client = new FreeTierClient(clientOpts({ profile, roleArn, externalId, region: 'us-east-1' }))
  const rows = []
  let token
  do {
    const res = await client.send(new GetFreeTierUsageCommand(token ? { nextToken: token } : {}))
    rows.push(...(res.freeTierUsages ?? []))
    token = res.nextToken
  } while (token)
  return { items: summarizeFreeTier(rows) }
}
