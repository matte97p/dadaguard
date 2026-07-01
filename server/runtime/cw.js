import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from './awsClient.js'

// Helper condiviso per i provider "a metrica" (Bedrock/SageMaker/SES/OpenSearch): legge una manciata
// di metriche CloudWatch su una finestra e le aggrega secondo lo `Stat` richiesto.
// queries: [[id, metricName, stat], …] con stat in Sum|Average|Maximum|Minimum.
// Ritorna { [id]: number } (0 se la metrica non ha punti). Read-only: cloudwatch:GetMetricData.
export async function metricValues(aws, namespace, dimensions, queries, windowMin) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - windowMin * 60 * 1000)
  const period = Math.min(windowMin * 60, 86400)
  const res = await cw.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: queries.map(([id, name, stat]) => ({
        Id: id,
        ReturnData: true,
        MetricStat: {
          Metric: { Namespace: namespace, MetricName: name, Dimensions: dimensions },
          Period: period,
          Stat: stat,
        },
      })),
    }),
  )
  const out = {}
  for (const [id, , stat] of queries) {
    const v = res.MetricDataResults?.find((r) => r.Id === id)?.Values ?? []
    out[id] = !v.length
      ? 0
      : stat === 'Average'
        ? v.reduce((a, b) => a + b, 0) / v.length
        : stat === 'Maximum'
          ? Math.max(...v)
          : stat === 'Minimum'
            ? Math.min(...v)
            : v.reduce((a, b) => a + b, 0)
  }
  return out
}
