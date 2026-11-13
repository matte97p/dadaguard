import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from '../runtime/awsClient.js'

// Serie ORARIE su una finestra di giorni, per molte metriche in poche chiamate. `runtime/cw.js` dà
// aggregati su ~24 bucket; qui servono le ore vere (settimana tipo, ore ferme, task al minimo), quindi
// Period fisso a 3600, che CloudWatch accetta a qualunque distanza (vedi `periodFor` in cw.js).
//
// `query` = [{ id, namespace, metrica, dimensioni: {Nome: valore}, stat }]. Ritorna { id: [[ms, v], …] }
// in ordine di tempo; una metrica che non esiste torna una lista vuota, non un errore.
export async function serieOrarie(aws, query, giorni, { period = 3600 } = {}) {
  const out = Object.fromEntries(query.map((q) => [q.id, []]))
  if (!query.length) return out
  const client = new CloudWatchClient(clientOpts(aws))
  const fine = new Date(Math.floor(Date.now() / 3600000) * 3600000)
  const inizio = new Date(fine.getTime() - giorni * 24 * 3600000)
  for (let s = 0; s < query.length; s += 500) {
    const blocco = query.slice(s, s + 500)
    let NextToken
    let pagine = 0
    do {
      const res = await client.send(
        new GetMetricDataCommand({
          StartTime: inizio,
          EndTime: fine,
          ScanBy: 'TimestampAscending',
          NextToken,
          MetricDataQueries: blocco.map((q) => ({
            Id: q.id,
            ReturnData: true,
            MetricStat: {
              Metric: {
                Namespace: q.namespace,
                MetricName: q.metrica,
                Dimensions: Object.entries(q.dimensioni).map(([Name, Value]) => ({ Name, Value })),
              },
              Period: period,
              Stat: q.stat,
            },
          })),
        }),
      )
      for (const r of res.MetricDataResults ?? []) {
        const tempi = r.Timestamps ?? []
        const valori = r.Values ?? []
        for (let i = 0; i < valori.length; i++) out[r.Id]?.push([new Date(tempi[i]).getTime(), valori[i]])
      }
      NextToken = res.NextToken
    } while (NextToken && ++pagine < 50)
  }
  for (const id of Object.keys(out)) out[id].sort((a, b) => a[0] - b[0])
  return out
}

// Allinea più serie per ora: { ms: { chiave: valore } }. Le ore senza un valore restano senza chiave.
export function perOra(serie) {
  const ore = new Map()
  for (const [chiave, punti] of Object.entries(serie)) {
    for (const [t, v] of punti) {
      if (!ore.has(t)) ore.set(t, {})
      ore.get(t)[chiave] = v
    }
  }
  return [...ore.entries()].sort((a, b) => a[0] - b[0])
}
