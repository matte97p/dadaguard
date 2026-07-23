import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from './awsClient.js'

// Aggregazione client-side dei punti di una metrica secondo lo Stat. I percentili (p95, p99…) sono
// già calcolati da CloudWatch per ogni punto: qui prendo il MAX dei punti (la coda peggiore della
// finestra). Pura/testabile.
export function aggregate(values, stat) {
  if (!values?.length) return 0
  if (stat === 'Average') return values.reduce((a, b) => a + b, 0) / values.length
  if (stat === 'Maximum' || /^p\d/.test(stat)) return Math.max(...values)
  if (stat === 'Minimum') return Math.min(...values)
  return values.reduce((a, b) => a + b, 0) // Sum (default)
}

const credKey = (aws) => `${aws.region ?? ''}|${aws.profile ?? ''}|${aws.roleArn ?? ''}|${aws.externalId ?? ''}`
const clients = new Map()
function clientFor(aws) {
  const k = credKey(aws)
  if (!clients.has(k)) clients.set(k, new CloudWatchClient(clientOpts(aws)))
  return clients.get(k)
}

// BATCH coalescing: le richieste con stesse credenziali/region E stessa finestra, arrivate entro lo
// stesso tick (FLUSH_MS), vengono unite in poche GetMetricData (≤500 metriche/chiamata) invece di una
// per servizio → molte meno chiamate CloudWatch (anti-throttling). Ogni chiamante riceve solo i suoi
// valori. La firma è quella di prima: i provider non cambiano.
const FLUSH_MS = 20
const queues = new Map()

export function metricValues(aws, namespace, dimensions, queries, windowMin) {
  return new Promise((resolve, reject) => {
    const bkey = `${credKey(aws)}||${windowMin}`
    let q = queues.get(bkey)
    if (!q) {
      q = { aws, windowMin, items: [] }
      queues.set(bkey, q)
      q.timer = setTimeout(() => flush(bkey), FLUSH_MS)
    }
    q.items.push({ namespace, dimensions, queries, resolve, reject })
  })
}

async function flush(bkey) {
  const q = queues.get(bkey)
  queues.delete(bkey)
  const { aws, windowMin, items } = q
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - windowMin * 60 * 1000)
  // ~24 bucket invece di un unico secchione: l'aggregato client-side resta corretto (Sum/Max/Avg
  // sono order/bucket-independent) e in più otteniamo la SERIE per le sparkline. Period ≥ 60s (multiplo).
  const windowSec = windowMin * 60
  const period = Math.min(86400, Math.max(60, Math.round(windowSec / 24 / 60) * 60))

  // ID globale per (item i, query j): "i{i}q{j}" → riconducibile al chiamante alla ricezione.
  const all = []
  items.forEach((it, i) =>
    it.queries.forEach(([, name, stat], j) =>
      all.push({
        Id: `i${i}q${j}`,
        ReturnData: true,
        MetricStat: {
          Metric: { Namespace: it.namespace, MetricName: name, Dimensions: it.dimensions },
          Period: period,
          Stat: stat,
        },
      }),
    ),
  )

  const byId = {}
  try {
    const client = clientFor(aws)
    for (let s = 0; s < all.length; s += 500) {
      const res = await client.send(
        new GetMetricDataCommand({
          StartTime: startTime,
          EndTime: endTime,
          ScanBy: 'TimestampAscending', // serie ordinata vecchio→nuovo (per le sparkline)
          MetricDataQueries: all.slice(s, s + 500),
        }),
      )
      for (const r of res.MetricDataResults ?? []) byId[r.Id] = r.Values ?? []
    }
    items.forEach((it, i) => {
      const out = { series: {} }
      it.queries.forEach(([id, , stat], j) => {
        const vals = byId[`i${i}q${j}`] ?? []
        out[id] = aggregate(vals, stat)
        out.series[id] = vals
      })
      it.resolve(out)
    })
  } catch (err) {
    for (const it of items) it.reject(err)
  }
}
