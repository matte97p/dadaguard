import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda'
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
