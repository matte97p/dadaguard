import { LambdaClient, GetFunctionCommand, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda'
import { clientOpts } from './awsClient.js'
import { cachedCall } from '../util/cache.js'

// TTL breve: un watchdog fetch-on-load tollera dati di qualche decina di secondi; l'importante è non
// ripetere la stessa GetFunctionConfiguration a ogni refresh. Override: DADAGUARD_LAMBDA_CFG_TTL_MS.
const TTL = Number(process.env.DADAGUARD_LAMBDA_CFG_TTL_MS) || 60000

// GetFunctionConfiguration con cache + single-flight condivisa fra i check. Build (#2), drift (#6) e
// runtime leggono la config della STESSA Lambda nello stesso refresh: senza questo sono 2-3 chiamate
// control-plane per funzione × N servizi = burst → 429. La chiave separa account (roleArn/profile) e region.
export function getLambdaConfig(functionName, aws) {
  const acct = aws.roleArn || aws.profile || 'default'
  const key = `lambdaCfg:${acct}:${aws.region || ''}:${functionName}`
  return cachedCall(key, TTL, () =>
    new LambdaClient(clientOpts(aws)).send(new GetFunctionConfigurationCommand({ FunctionName: functionName })),
  )
}

// La concorrenza RISERVATA della funzione (`null` se non c'è): sta in GetFunction e non in
// GetFunctionConfiguration, e il ruolo read-only ha già `lambda:GetFunction`. Stessa cache e stessa
// chiave per account della config. Un errore vale `null`, cioè «non lo so»: il check resta quello di
// prima, non sparisce.
export function getLambdaReservedConcurrency(functionName, aws) {
  const acct = aws.roleArn || aws.profile || 'default'
  const key = `lambdaConc:${acct}:${aws.region || ''}:${functionName}`
  return cachedCall(key, TTL, async () => {
    const r = await new LambdaClient(clientOpts(aws)).send(new GetFunctionCommand({ FunctionName: functionName }))
    return r.Concurrency?.ReservedConcurrentExecutions ?? null
  }).catch(() => null)
}

// I TAG di una funzione, per il Codice dei cron Lambda (server/codice.js). Da `GetFunction`, che il
// ruolo read-only ha già: la risposta porta `Tags` SOLO se il ruolo ha anche `lambda:ListTags`
// (regola di AWS, non nostra). Senza quel permesso la chiamata riesce lo stesso e i tag arrivano
// vuoti, quindi il cron tiene il nome di oggi invece di rompersi.
// TTL lungo, un'ora: i tag li muove un apply, non il traffico, e su ~75 cron rileggerli a ogni giro
// della pagina sarebbero ~75 chiamate per sapere una cosa che non è cambiata. Override:
// DADAGUARD_LAMBDA_TAGS_TTL_MS. Un errore NON si mette in cache (lo fa `cachedCall`): al giro dopo
// si riprova, e chi chiama lo tratta come «nessun tag».
const TTL_TAG = Number(process.env.DADAGUARD_LAMBDA_TAGS_TTL_MS) || 3600_000

export function getLambdaTags(functionName, aws) {
  const acct = aws.roleArn || aws.profile || 'default'
  const key = `lambdaTags:${acct}:${aws.region || ''}:${functionName}`
  return cachedCall(key, TTL_TAG, async () => {
    const r = await new LambdaClient(clientOpts(aws)).send(new GetFunctionCommand({ FunctionName: functionName }))
    return r.Tags ?? {}
  })
}
