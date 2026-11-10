import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { clientOpts } from './awsClient.js'
import { cachedCall } from '../util/cache.js'

// Quando e' nato un cron, letto dalla creazione del suo log group. Serve al dead man's switch: fra
// l'apply e il primo orario dello schedule un cron nuovo non ha corse, e senza la data di nascita
// quella finestra suonava come un giro saltato. Le API dei servizi non aiutano: `LastModified` di una
// Lambda e la revision di una task definition si spostano a ogni deploy, e un redeploy dopo un giro
// saltato lo nasconderebbe. Il log group nasce una volta, e per un cron creato da IaC insieme a lui.
// Cache lunga: la data di nascita non cambia, e la chiamata serve solo ai cron senza corse.
const NASCITA_TTL = 60 * 60 * 1000

// Millisecondi, oppure `null` («non lo so»: log group assente, permesso mancante, errore). Con `null`
// il controllo resta quello di prima, e un giro saltato suona comunque.
export function logGroupCreatedAt(logGroup, aws) {
  const acct = aws?.roleArn || aws?.profile || 'default'
  const key = `logGroupNato:${acct}:${aws?.region || ''}:${logGroup}`
  return cachedCall(key, NASCITA_TTL, async () => {
    const r = await new CloudWatchLogsClient(clientOpts(aws)).send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroup, limit: 5 }),
    )
    return (r.logGroups ?? []).find((g) => g.logGroupName === logGroup)?.creationTime ?? null
  }).catch(() => null)
}

// Il cron e' nato DOPO il giro che il dead man's switch si aspettava: non l'ha saltato, non c'era.
// Pura. Senza la finestra dall'espressione (`rate(...)`) l'ora attesa non si sa, e la risposta e' no.
export function natoDopoIlGiro(natoMs, missed) {
  if (natoMs == null || !missed?.expectedAt) return false
  return natoMs > new Date(missed.expectedAt).getTime()
}
