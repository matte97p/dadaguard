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
// LA CORSA FALLITA, quando qualcuno la scrive. Il battito dice solo i successi: un giro senza punto
// puo' essere un fallimento o un giro saltato per scelta, e su un cron settimanale o mensile un battito
// non esiste nemmeno, perche' la sua finestra supererebbe i sette giorni che CloudWatch concede a un
// allarme. Se pero' chi gestisce i job registra anche la corsa fallita, con un punto SOTTO uno sulla
// stessa metrica del successo (per esempio dall'evento di task fermato, che vede anche il container
// ucciso per memoria finita), e lo dichiara con un allarme, quel punto e' un esito certo e duraturo.
// La forma che lo dichiara (`eFallimento`): una metrica sola, nel suo MINIMO, sotto uno, con il dato
// mancante che vale salute; il nome, la stessa regola del battito.
//
// Costo: `DescribeAlarms` una volta ogni dieci minuti per account, e una `GetMetricData` per account a
// giro dello storico con una o due metriche per cron abbinato ($0,01 ogni 1.000 metriche chieste).
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

// «Questo allarme dice dove sta la corsa FALLITA?» Solo la forma, come `eBattito`. Pura.
// Lo specchio del battito: il minimo di una metrica sola sotto uno, e il silenzio non allarma. Un punto
// sotto la soglia vuol dire che in quel momento una corsa non e' riuscita.
export function eFallimento(a) {
  if (!a?.Namespace || !a?.MetricName || a?.Metrics?.length) return false
  if (a.TreatMissingData === 'breaching') return false
  if (a.Statistic !== 'Minimum') return false
  const soglia = Number(a.Threshold)
  if (a.ComparisonOperator === 'LessThanThreshold') return soglia > 0 && soglia <= 1
  if (a.ComparisonOperator === 'LessThanOrEqualToThreshold') return soglia >= 0 && soglia < 1
  return false
}

// Allarmi di una forma → chiave del cron → la metrica, la soglia e quanto silenzio l'allarme tollera.
// Il cron si riconosce dal nome (`<cron>-<qualcosa>`), e vince quello dal nome piu' lungo. Pura.
function abbina(crons, allarmi, forma) {
  const perNome = [...crons].filter((c) => c?.name && c?.key).sort((a, b) => b.name.length - a.name.length)
  const fuori = new Map()
  for (const a of allarmi) {
    if (!forma(a)) continue
    const nome = String(a.AlarmName ?? '')
    const cron = perNome.find((c) => nome.startsWith(`${c.name}-`))
    if (!cron || fuori.has(cron.key)) continue
    fuori.set(cron.key, {
      allarme: nome,
      namespace: a.Namespace,
      metrica: a.MetricName,
      dimensioni: (a.Dimensions ?? []).map((d) => ({ Name: d.Name, Value: d.Value })),
      stat: a.Statistic,
      soglia: Number(a.Threshold),
      operatore: a.ComparisonOperator,
      finestraMs: (Number(a.Period) || 0) * 1000 * (Number(a.EvaluationPeriods) || 1),
    })
  }
  return fuori
}

// I battiti dei cron. `finestraMs` (periodo × periodi valutati) dice se ogni corsa deve riuscire: vedi
// `esitiDaBattito`. Pura.
export function abbinaBattiti(crons = [], allarmi = []) {
  return abbina(crons, allarmi, eBattito)
}

// Dove i cron registrano la corsa fallita (vedi `eFallimento`). Pura.
export function abbinaFallimenti(crons = [], allarmi = []) {
  return abbina(crons, allarmi, eFallimento)
}

export function queryBattiti(battiti = [], prefisso = 'b') {
  return battiti.map((b, i) => ({
    Id: `${prefisso}${i}`,
    ReturnData: true,
    MetricStat: {
      Metric: { Namespace: b.namespace, MetricName: b.metrica, Dimensions: b.dimensioni },
      Period: PERIODO_MS / 1000,
      Stat: b.stat,
    },
  }))
}

// Gli istanti (inizio della fascia da cinque minuti) delle query `<prefisso><i>` in cui `vale` regge,
// in ordine. Pura.
function istanti(risultati, n, prefisso, vale) {
  const fuori = Array.from({ length: n }, () => [])
  const re = new RegExp(`^${prefisso}(\\d+)$`)
  for (const r of risultati) {
    const m = re.exec(r?.Id ?? '')
    if (!m || !fuori[m[1]]) continue
    ;(r.Timestamps ?? []).forEach((ts, k) => {
      const v = r.Values?.[k]
      if (Number.isFinite(v) && vale(v, Number(m[1]))) fuori[m[1]].push(new Date(ts).getTime())
    })
  }
  return fuori.map((v) => v.sort((a, b) => a - b))
}

// Gli istanti in cui il cron ha battuto: i punti sopra zero. Pura.
export function istantiBattiti(risultati = [], n = 0) {
  return istanti(risultati, n, 'b', (v) => v > 0)
}

// Gli istanti delle corse fallite: i punti che fanno suonare il loro allarme (sotto la soglia, o fino
// alla soglia con `LessThanOrEqualToThreshold`). Pura.
export function istantiFallimenti(risultati = [], specifiche = []) {
  return istanti(risultati, specifiche.length, 'f', (v, i) => {
    const { soglia, operatore } = specifiche[i]
    return operatore === 'LessThanOrEqualToThreshold' ? v <= soglia : v < soglia
  })
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
//
// Una corsa con un punto di FALLIMENTO nello stesso intervallo (`fallite`, vedi `eFallimento`) e' fallita
// e basta, qualunque sia la tolleranza del battito, e anche senza battito: lo ha scritto chi l'ha vista
// finire. Se nello stesso intervallo c'e' anche un battito vince il battito, perche' il job ha dichiarato
// di essere arrivato in fondo e il fallimento puo' essere venuto dopo, uscendo.
export function esitiDaBattito(corse = [], { istanti = [], finestraMs = 0, fallite = [] } = {}, { ora = Date.now(), cadenzaMs = 0 } = {}) {
  const fuori = new Map()
  const lista = corse.filter((r) => r?.stream && Number.isFinite(r.startedAt)).sort((a, b) => a.startedAt - b.startedAt)
  if (!lista.length) return fuori
  const perCorsa = cadenzaMs > 0 && finestraMs > 0 && finestraMs < 2 * cadenzaMs
  const fascia = (t) => Math.floor(t / PERIODO_MS) * PERIODO_MS
  const dentro = (punti, i) => {
    const da = fascia(lista[i].startedAt)
    const a = lista[i + 1]?.startedAt ?? Infinity
    return punti.find((x) => x >= da && x < a)
  }
  const ritardi = []
  const battuta = lista.map((r, i) => {
    const t = dentro(istanti, i)
    if (t != null) ritardi.push(t + PERIODO_MS - r.startedAt)
    return t != null
  })
  const tipico = ritardi.length ? Math.max(...ritardi) * 1.5 : 30 * MIN
  lista.forEach((r, i) => {
    if (battuta[i]) return void fuori.set(r.stream, 'ok')
    if (dentro(fallite, i) != null) return void fuori.set(r.stream, 'ko')
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

// I battiti e le corse fallite dei cron di UN account nella finestra: chiave del cron → { istanti,
// fallite, finestraMs, ... }, per i cron che hanno almeno uno dei due allarmi. Non lancia: senza
// permesso o con un errore gli esiti restano quelli di prima (codice d'uscita, log).
export async function leggiBattiti(aws, crons = [], { da, a = Date.now() } = {}) {
  try {
    const allarmi = await allarmiAccount(aws)
    const battiti = abbinaBattiti(crons, allarmi)
    const fallimenti = abbinaFallimenti(crons, allarmi)
    if (!battiti.size && !fallimenti.size) return new Map()
    const kb = [...battiti.keys()]
    const kf = [...fallimenti.keys()]
    const sb = kb.map((k) => battiti.get(k))
    const sf = kf.map((k) => fallimenti.get(k))
    const cw = new CloudWatchClient(clientOpts(aws))
    const query = [...queryBattiti(sb, 'b'), ...queryBattiti(sf, 'f')]
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
    const ib = istantiBattiti(risultati, kb.length)
    const iff = istantiFallimenti(risultati, sf)
    const fuori = new Map(kb.map((k, i) => [k, { ...sb[i], istanti: ib[i], fallite: [] }]))
    // Un cron con il solo allarme del fallimento non ha un battito: niente successi da contare e
    // nessuna tolleranza, quindi il resto lo dice il log.
    kf.forEach((k, i) => fuori.set(k, { istanti: [], finestraMs: 0, ...fuori.get(k), fallite: iff[i] }))
    return fuori
  } catch (err) {
    log.warn('battiti dei cron non letti: esiti dal codice d\'uscita e dal log', { err: err.message })
    return new Map()
  }
}
