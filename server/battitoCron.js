// L'ESITO CHE SOPRAVVIVE A UN RIAVVIO: la metrica di successo che un cron ECS scrive da se'.
//
// Perche' serve. L'esito certo di una corsa ECS e' il codice d'uscita, e ECS lo tiene per circa un'ora
// dopo la fine del task. Dadaguard lo annota in memoria (`esitiEcs`, server/runs.js), e dopo un riavvio
// (cioe' a ogni deploy) quella memoria e' vuota: resta il log, e un job che muore con un codice d'uscita
// senza scrivere una riga d'errore torna «riuscito». Visto dopo un deploy: i cron falliti della giornata
// sono diventati verdi tutti insieme, mentre i loro allarmi dicevano ancora che non riuscivano.
//
// Molti job pero' dichiarano da se' quando sono riusciti: alla fine di ogni corsa buona scrivono un punto
// su una metrica CloudWatch, e un allarme suona quando il punto non arriva. Quella metrica non scade con il
// task: e' l'esito duraturo.
//
// Niente da dichiarare: la metrica si DEDUCE dagli allarmi che l'account ha gia'. Un allarme e' il
// «battito» di un cron quando:
//  · guarda UNA metrica (namespace e nome), sommata o contata;
//  · suona sotto uno (`LessThanThreshold` 1, o `LessThanOrEqualToThreshold` 0);
//  · tratta i dati mancanti come guasto (`TreatMissingData: breaching`): e' il silenzio che allarma;
//  · si chiama come il cron piu' un suffisso (`<cron>-<qualcosa>`), la stessa regola con cui la home piega
//    gli allarmi nella riga del cron. Vince il cron dal nome piu' lungo: `job` e `job-notte` sono due cron.
// Un cron senza un allarme cosi' resta com'era: codice d'uscita finche' c'e', poi il log.
//
// Costo: `DescribeAlarms` una volta ogni dieci minuti per account, e una `GetMetricData` per account a
// giro dello storico con una metrica per cron abbinato ($0,01 ogni 1.000 metriche chieste).
// Permessi: cloudwatch:DescribeAlarms e cloudwatch:GetMetricData, gia' nel ruolo di sola lettura.
import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from './runtime/awsClient.js'
import { cached } from './util/ttlcache.js'
import { log } from './log.js'

const MIN = 60_000
// Cinque minuti: e' la risoluzione che CloudWatch tiene per 63 giorni, cioe' anche sullo storico di trenta.
// Quella al minuto sparisce dopo quindici, e una corsa vecchia sembrerebbe senza battito.
export const PERIODO_MS = 5 * MIN
const STAT = new Set(['Sum', 'SampleCount'])

// «Questo allarme e' un battito?» Solo la forma, il nome lo guarda `abbinaBattiti`. Pura.
export function eBattito(a) {
  if (!a?.Namespace || !a?.MetricName || a?.Metrics?.length) return false
  if (a.TreatMissingData !== 'breaching') return false
  if (!STAT.has(a.Statistic)) return false
  const soglia = Number(a.Threshold)
  if (a.ComparisonOperator === 'LessThanThreshold') return soglia > 0 && soglia <= 1
  if (a.ComparisonOperator === 'LessThanOrEqualToThreshold') return soglia >= 0 && soglia < 1
  return false
}

// I battiti dei cron: chiave del cron → la metrica e quanto silenzio il suo allarme tollera. Pura.
// `finestraMs` (periodo × periodi valutati) dice se ogni corsa deve riuscire: vedi `esitiDaBattito`.
export function abbinaBattiti(crons = [], allarmi = []) {
  const perNome = [...crons].filter((c) => c?.name && c?.key).sort((a, b) => b.name.length - a.name.length)
  const fuori = new Map()
  for (const a of allarmi) {
    if (!eBattito(a)) continue
    const nome = String(a.AlarmName ?? '')
    const cron = perNome.find((c) => nome.startsWith(`${c.name}-`))
    if (!cron || fuori.has(cron.key)) continue
    fuori.set(cron.key, {
      allarme: nome,
      namespace: a.Namespace,
      metrica: a.MetricName,
      dimensioni: (a.Dimensions ?? []).map((d) => ({ Name: d.Name, Value: d.Value })),
      stat: a.Statistic,
      finestraMs: (Number(a.Period) || 0) * 1000 * (Number(a.EvaluationPeriods) || 1),
    })
  }
  return fuori
}

export function queryBattiti(battiti = []) {
  return battiti.map((b, i) => ({
    Id: `b${i}`,
    ReturnData: true,
    MetricStat: {
      Metric: { Namespace: b.namespace, MetricName: b.metrica, Dimensions: b.dimensioni },
      Period: PERIODO_MS / 1000,
      Stat: b.stat,
    },
  }))
}

// Gli istanti (inizio della fascia da cinque minuti) in cui il cron ha battuto, in ordine. Pura.
export function istantiBattiti(risultati = [], n = 0) {
  const fuori = Array.from({ length: n }, () => [])
  for (const r of risultati) {
    const m = /^b(\d+)$/.exec(r?.Id ?? '')
    if (!m || !fuori[m[1]]) continue
    ;(r.Timestamps ?? []).forEach((ts, k) => {
      if ((r.Values?.[k] ?? 0) > 0) fuori[m[1]].push(new Date(ts).getTime())
    })
  }
  return fuori.map((v) => v.sort((a, b) => a - b))
}

// L'esito di ogni corsa dal battito, per stream. Pura.
//
// Una corsa e' RIUSCITA se il cron ha battuto fra la fascia in cui e' partita e la partenza della corsa
// dopo: il punto arriva alla fine, e un job che lavora in silenzio dopo l'ultima riga di log (o che lancia
// un lavoro e aspetta) lo scrive anche molto dopo l'ultima riga. Fino alla corsa dopo, e non oltre: quel
// punto e' suo.
//
// Senza battito la corsa e' FALLITA solo se l'allarme del cron pretende un successo a OGNI corsa, cioe' se
// il silenzio che tollera e' meno di due cadenze (un job giornaliero con un allarme a ventisei ore): li' una
// corsa senza punto e' un giro mancato. Con una tolleranza piu' larga il job puo' saltare il punto per
// scelta (non c'era niente da fare), e allora il battito vale solo come prova di successo: la corsa senza
// punto resta al log.
//
// L'ultima corsa non ha una corsa dopo: e' fallita quando e' passato piu' tempo di quanto il cron ci mette
// di solito a battere (una volta e mezza il ritardo piu' lungo visto nella finestra, fra un quarto d'ora e
// sei ore), e prima non si sa. Mai «fallita» per una corsa ancora in corso.
export function esitiDaBattito(corse = [], { istanti = [], finestraMs = 0 } = {}, { ora = Date.now(), cadenzaMs = 0 } = {}) {
  const fuori = new Map()
  const lista = corse.filter((r) => r?.stream && Number.isFinite(r.startedAt)).sort((a, b) => a.startedAt - b.startedAt)
  if (!lista.length) return fuori
  const perCorsa = cadenzaMs > 0 && finestraMs > 0 && finestraMs < 2 * cadenzaMs
  const fascia = (t) => Math.floor(t / PERIODO_MS) * PERIODO_MS
  const ritardi = []
  const battuta = lista.map((r, i) => {
    const da = fascia(r.startedAt)
    const a = lista[i + 1]?.startedAt ?? Infinity
    const t = istanti.find((x) => x >= da && x < a)
    if (t != null) ritardi.push(t + PERIODO_MS - r.startedAt)
    return t != null
  })
  const tipico = ritardi.length ? Math.max(...ritardi) * 1.5 : 30 * MIN
  lista.forEach((r, i) => {
    if (battuta[i]) return void fuori.set(r.stream, 'ok')
    if (!perCorsa || r.running) return
    if (i < lista.length - 1) return void fuori.set(r.stream, 'ko')
    const durata = Number.isFinite(r.endedAt) ? r.endedAt - r.startedAt : 0
    const attesa = Math.max(Math.min(Math.max(tipico, 15 * MIN), 6 * 60 * MIN), durata + 15 * MIN)
    if (ora - r.startedAt > attesa) fuori.set(r.stream, 'ko')
  })
  return fuori
}

// Gli allarmi dell'account, di qualunque stato: un battito che oggi e' OK serve quanto uno che suona.
// Dieci minuti di cache: gli allarmi li muove un apply, non il traffico.
function allarmiAccount(aws) {
  return cached(`battiti:allarmi:${aws?.roleArn ?? aws?.profile ?? 'default'}:${aws?.region ?? ''}`, 10 * MIN, async () => {
    const cw = new CloudWatchClient(clientOpts(aws))
    const fuori = []
    let NextToken
    let pagine = 0
    do {
      const r = await cw.send(new DescribeAlarmsCommand({ AlarmTypes: ['MetricAlarm'], MaxRecords: 100, NextToken }))
      fuori.push(...(r.MetricAlarms ?? []))
      NextToken = r.NextToken
      pagine++
    } while (NextToken && pagine < 20)
    return fuori
  })
}

// I battiti dei cron di UN account nella finestra: chiave del cron → { istanti, finestraMs, allarme }.
// Non lancia: senza permesso o con un errore gli esiti restano quelli di prima (codice d'uscita, log).
export async function leggiBattiti(aws, crons = [], { da, a = Date.now() } = {}) {
  try {
    const abbinati = abbinaBattiti(crons, await allarmiAccount(aws))
    if (!abbinati.size) return new Map()
    const chiavi = [...abbinati.keys()]
    const specifiche = chiavi.map((k) => abbinati.get(k))
    const cw = new CloudWatchClient(clientOpts(aws))
    const query = queryBattiti(specifiche)
    const risultati = []
    // Cinquecento metriche per chiamata e' il tetto di `GetMetricData`.
    for (let i = 0; i < query.length; i += 500) {
      let NextToken
      do {
        const r = await cw.send(
          new GetMetricDataCommand({
            MetricDataQueries: query.slice(i, i + 500),
            StartTime: new Date(Math.floor(da / PERIODO_MS) * PERIODO_MS),
            EndTime: new Date(a),
            NextToken,
          }),
        )
        risultati.push(...(r.MetricDataResults ?? []))
        NextToken = r.NextToken
      } while (NextToken)
    }
    const istanti = istantiBattiti(risultati, chiavi.length)
    return new Map(chiavi.map((k, i) => [k, { ...specifiche[i], istanti: istanti[i] }]))
  } catch (err) {
    log.warn('battiti dei cron non letti: esiti dal codice d\'uscita e dal log', { err: err.message })
    return new Map()
  }
}
