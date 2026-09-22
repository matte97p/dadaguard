import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from './awsClient.js'
import { fmtCount } from '../util/format.js'
import { risolviProfilo, valuta, testoRegola } from './soglie.js'

// RuntimeProvider per API Gateway: errori 5xx recenti (15 min) via CloudWatch.
//
// La soglia è il profilo `utente` di `soglie.js` (dal 22/09/2026): un 5xx HTTP non lo ritenta
// nessuno, lo vede la persona davanti al browser, quindi basta l'1% delle richieste della finestra.
// Prima bastava UN 5xx qualsiasi, che su una API con migliaia di richieste al quarto d'ora è lo
// 0,0x%: la stessa asimmetria per cui su Bedrock un tetto assoluto decideva tutto. Sotto le 20
// richieste la percentuale non decide da sola, ma «sono fallite tutte» allarma lo stesso
// (`tuttoFallitoAllarma`), o una API poco chiamata potrebbe stare giù in silenzio.
// Permesso: cloudwatch:GetMetricData. Config: aws: { type: apigateway, apiName: <nome>, stage?: <stage> }
export async function apigatewayRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  if (!cfg.apiName) return { status: 'unknown', reason: t('apigw.noname') }
  const cw = new CloudWatchClient(clientOpts(aws))
  const end = new Date()
  const start = new Date(end.getTime() - 15 * 60 * 1000)
  const dims = [{ Name: 'ApiName', Value: cfg.apiName }, ...(cfg.stage ? [{ Name: 'Stage', Value: cfg.stage }] : [])]
  const q = (id, name) => ({
    Id: id,
    MetricStat: { Metric: { Namespace: 'AWS/ApiGateway', MetricName: name, Dimensions: dims }, Period: 900, Stat: 'Sum' },
    ReturnData: true,
  })
  const res = await cw.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: [q('c', 'Count'), q('e', '5XXError')] }))
  const sum = (id) => (res.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []).reduce((a, b) => a + b, 0)
  const count = sum('c')
  const e5 = sum('e')
  const soglia = risolviProfilo('utente', cfg.soglie ?? opts.soglie?.apigateway)
  const sforo = valuta(e5, count, soglia)
  // La finestra è 15 minuti e non lo diceva nessuno: "3.400 richieste" senza periodo non è un numero.
  // Sta nel testo e non in un campo `window`: quello lo rende solo la card, e questo provider non
  // espone metriche, quindi lì non arriverebbe mai — due fonti per lo stesso dato, una muta.
  const window = '15m'
  return {
    status: sforo?.tuttoFallito ? 'down' : sforo ? 'degraded' : 'up',
    summary: t('apigw.summary', { n: fmtCount(Math.round(count)), e: e5, window }),
    ...(sforo
      ? {
          alert:
            t('apigw.alert', { e: e5, n: fmtCount(Math.round(count)), window }) +
            t('rule.fires', { regola: testoRegola(soglia, t, t('soglia.unita.richieste')) }),
        }
      : {}),
  }
}
