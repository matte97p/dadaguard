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
// `Period` ammesso da CloudWatch: la granularità dipende da QUANTO INDIETRO parte la finestra, e una
// richiesta che la viola NON fallisce — torna `Values: []` con HTTP 200. Un dead man's switch legge
// quel vuoto come «nessuna esecuzione» e dice GIÙ su un cron sano. Visto il 22/09/2026 su un cron
// MENSILE di produzione: finestra di 18 giorni, `Period` 66660 → zero punti, mentre 66600 sulla
// stessa finestra ne restituiva due. Il guasto è muto e intermittente:
// `period` cresce di 60s ogni 24 minuti al passare di `now`, quindi cade su un multiplo di 300 solo
// una volta su cinque, e il cron lampeggia fra GIÙ e SU senza che nessuno l'abbia toccato.
//   ≤ 15 giorni  → multiplo di 60
//   15-63 giorni → multiplo di 300
//   > 63 giorni  → multiplo di 3600
// I margini sono stretti apposta (14 e 62 giorni invece di 15 e 63): una granularità più GROSSA del
// necessario CloudWatch la accetta sempre, quindi si sbaglia dalla parte che non perde punti.
// Si arrotonda per ECCESSO: per difetto il bucket può scendere sotto la granularità minima.
export function periodFor(windowMin) {
  const grana = windowMin > 62 * 1440 ? 3600 : windowMin > 14 * 1440 ? 300 : 60
  const grezzo = Math.max(grana, Math.round(windowMin / 24) * 60) // ~24 bucket sulla finestra
  return Math.min(86400, Math.ceil(grezzo / grana) * grana) // 86400 è multiplo di tutte e tre
}

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
  // sono order/bucket-independent) e in più otteniamo la SERIE per le sparkline.
  const period = periodFor(windowMin)

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

  // Valori E timestamp. I timestamp servono perche' CloudWatch OMETTE i periodi senza dati (una
  // metrica Sum che in quel bucket non ha punti non esce affatto): senza l'ora di ogni punto, tre
  // valori di fila nell'array possono essere tre minuti attaccati o tre minuti sparsi nell'ora, e
  // chi vuole sapere se gli errori sono CONSECUTIVI (`runtime/bedrock.js`) leggerebbe una bugia.
  const byId = {}
  const byIdTs = {}
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
      for (const r of res.MetricDataResults ?? []) {
        byId[r.Id] = r.Values ?? []
        byIdTs[r.Id] = (r.Timestamps ?? []).map((t) => new Date(t).getTime())
      }
    }
    items.forEach((it, i) => {
      // `period` esce insieme ai dati: e' la distanza fra due bucket attaccati, e senza di lei i
      // timestamp non dicono se due punti sono adiacenti.
      const out = { series: {}, times: {}, period }
      it.queries.forEach(([id, , stat], j) => {
        const vals = byId[`i${i}q${j}`] ?? []
        out[id] = aggregate(vals, stat)
        out.series[id] = vals
        out.times[id] = byIdTs[`i${i}q${j}`] ?? []
      })
      it.resolve(out)
    })
  } catch (err) {
    for (const it of items) it.reject(err)
  }
}
