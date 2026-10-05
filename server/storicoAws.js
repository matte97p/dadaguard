// Le letture AWS dello storico (vedi storico.js per il perché). Tutte API di LETTURA, paginate, con il
// retry adattivo di clientOpts sotto throttling, e con un tetto di pagine dichiarato: chi tronca lo dice
// (`troncato: true`), come chiede finestre.conf.
//
// Permessi: cloudwatch:DescribeAlarms, cloudwatch:GetMetricData e ecs:DescribeServices ci sono già nel
// ruolo readonly. cloudwatch:DescribeAlarmHistory NO: senza, quella fonte risponde con un errore suo e
// lo storico resta in piedi con le altre (la riga verde diventa «senza allarmi», ed è dichiarato).
import { CloudWatchClient, DescribeAlarmHistoryCommand, DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs'
import { clientOpts } from './runtime/awsClient.js'
import { isAutoscalingAlarm } from './checks/alarms.js'
import { stripOrgEnv } from './util/envToken.js'
import { ambienteDiConto, componiStorico, inizioGiorno } from './storico.js'

const MAX_PAGINE = 10 // 100 voci a pagina: mille cambi di stato in un giorno sono già un incendio

// La storia dei cambi di stato degli allarmi nella finestra, esclusi quelli di autoscaling (che vanno
// in ALARM per design, vedi checks/alarms.js). Il nome basta per escluderli qui: la storia non porta
// le azioni, e i metadati servono comunque per le dimensioni.
export async function storiaAllarmi(aws, { da, a, tetto = MAX_PAGINE * 100 }) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const voci = []
  let token
  let pagine = 0
  do {
    const out = await cw.send(
      new DescribeAlarmHistoryCommand({ HistoryItemType: 'StateUpdate', StartDate: new Date(da), EndDate: new Date(a), MaxRecords: 100, NextToken: token }),
    )
    voci.push(...(out.AlarmHistoryItems ?? []))
    token = out.NextToken
    pagine++
  } while (token && pagine < MAX_PAGINE && voci.length < tetto)
  return { voci: voci.filter((v) => !String(v.AlarmName ?? '').startsWith('TargetTracking-')), troncato: Boolean(token) }
}

// Le dimensioni di TUTTI gli allarmi (non solo quelli accesi), per sapere a che servizio appartiene un
// allarme che oggi è tornato OK. Stessa chiamata del check, senza filtro di stato. Paginato.
export async function metadatiAllarmi(aws) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const meta = {}
  let token
  let pagine = 0
  do {
    const out = await cw.send(new DescribeAlarmsCommand({ MaxRecords: 100, NextToken: token }))
    for (const al of out.MetricAlarms ?? []) if (!isAutoscalingAlarm(al)) meta[al.AlarmName] = { Dimensions: al.Dimensions ?? [] }
    token = out.NextToken
    pagine++
  } while (token && pagine < MAX_PAGINE)
  return meta
}

// Gli eventi dei servizi ECS dell'account, a gruppi di dieci per cluster (il massimo di
// DescribeServices). ECS ne conserva gli ultimi cento per servizio: per un giorno di solito bastano,
// e non c'è altro posto dove AWS li tenga senza un trail apposta.
export async function eventiEcsAccount(aws, servizi = []) {
  const perCluster = new Map()
  for (const s of servizi) {
    if (s?.aws?.type !== 'ecs' || !s.aws.cluster || !s.aws.service) continue
    if (!perCluster.has(s.aws.cluster)) perCluster.set(s.aws.cluster, [])
    perCluster.get(s.aws.cluster).push(s.aws.service)
  }
  const ecs = new ECSClient(clientOpts(aws))
  const out = []
  for (const [cluster, nomi] of perCluster) {
    for (let i = 0; i < nomi.length; i += 10) {
      const r = await ecs.send(new DescribeServicesCommand({ cluster, services: nomi.slice(i, i + 10) }))
      for (const s of r.services ?? [])
        for (const e of s.events ?? []) out.push({ ts: e.createdAt, message: e.message, servizio: stripOrgEnv(s.serviceName) || s.serviceName })
    }
  }
  return out
}

// Errore medio e p95 di un giorno, dove i dati esistono già: Lambda ha metriche a livello di ACCOUNT
// (senza dimensioni), l'ALB per LoadBalancer, che si sommano con SEARCH. Il p95 di più ALB non si può
// aggregare da percentili separati: si prende il peggiore, e il payload lo dice (`p95: 'max per ALB'`).
// GetMetricData si paga a metrica: sono sei metriche per giorno per account, in cache.
export async function metricheGiorno(aws, { da, a }) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const periodo = Math.max(60, Math.ceil((a - da) / 60_000) * 60)
  const lambda = (id, nome, stat) => ({ Id: id, MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName: nome }, Period: periodo, Stat: stat } })
  const alb = (id, nome, stat) => ({ Id: id, Expression: `SEARCH('{AWS/ApplicationELB,LoadBalancer} MetricName="${nome}"', '${stat}', ${periodo})` })
  const out = await cw.send(
    new GetMetricDataCommand({
      StartTime: new Date(da),
      EndTime: new Date(a),
      MetricDataQueries: [
        lambda('lerr', 'Errors', 'Sum'),
        lambda('linv', 'Invocations', 'Sum'),
        lambda('ldur', 'Duration', 'p95'),
        alb('a5xx', 'HTTPCode_Target_5XX_Count', 'Sum'),
        alb('areq', 'RequestCount', 'Sum'),
        alb('alat', 'TargetResponseTime', 'p95'),
      ],
    }),
  )
  // Una SEARCH torna una serie per ALB, tutte con lo stesso Id: si sommano (conteggi) o si prende il
  // massimo (percentili), come detto sopra.
  const valori = (id) => (out.MetricDataResults ?? []).filter((r) => r.Id === id).flatMap((r) => r.Values ?? [])
  const somma = (id) => {
    const v = valori(id)
    return v.length ? v.reduce((x, y) => x + y, 0) : null
  }
  const massimo = (id) => {
    const v = valori(id)
    return v.length ? Math.max(...v) : null
  }
  return {
    lambda: { errori: somma('lerr'), invocazioni: somma('linv'), p95ms: massimo('ldur') },
    alb: { errori: somma('a5xx'), richieste: somma('areq'), p95ms: massimo('alat') == null ? null : massimo('alat') * 1000 },
  }
}

// Le letture vere, sostituibili nei test.
const LETTURE = { storiaAllarmi, metadatiAllarmi, eventiEcsAccount, metricheGiorno }

// Una lettura che fallisce non porta giù lo storico: diventa un errore di QUELLA fonte, e il resto
// risponde. Un AccessDenied su DescribeAlarmHistory (permesso non ancora concesso) deve leggersi come
// «questa fonte manca», non come una pagina vuota.
const prova = async (fonte, errori, fn, vuoto) => {
  try {
    return await fn()
  } catch (err) {
    const negato = /AccessDenied|not authorized/i.test(`${err?.name ?? ''} ${err?.message ?? ''}`)
    errori.push({ fonte, errore: negato ? 'permesso mancante' : (err?.message ?? String(err)) })
    return vuoto
  }
}

// Lo storico della flotta: legge, per ogni conto con un ambiente, le fonti AWS in parallelo e passa
// tutto a componiStorico (puro, lo stesso che usa la demo). `deploys` è il payload per-account di
// /api/deploys, già in cache: nessun giro CodeBuild o CloudTrail in più. Per Cloudflare le sole fonti
// sono i deploy (allarmi ed ECS lì non esistono), e infatti non ha un conto AWS da interrogare.
export async function storicoFlotta({ accounts = {}, services = [], deploys = {}, ora = Date.now(), ore = 24, letture = LETTURE }) {
  const da = ora - ore * 3600_000
  const oggi0 = inizioGiorno(ora)
  const ieri0 = oggi0 - 24 * 3600_000
  const perConto = {}
  const chiavi = [...new Set([...Object.keys(deploys), ...Object.keys(accounts)])]
  await Promise.all(
    chiavi.map(async (chiave) => {
      const conto = deploys[chiave] ?? {}
      if (!ambienteDiConto(chiave, conto)) return
      const a = accounts[chiave]
      const errori = conto.error ? [{ fonte: 'deploy', errore: conto.error }] : []
      const riga = { provider: conto.provider, builds: conto.builds ?? [], voci: [], meta: {}, ecs: [], metriche: null, troncato: false, errori }
      perConto[chiave] = riga
      if (!a || conto.provider === 'cloudflare') return
      const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: a.region }
      const [storia, meta, ecs, oggi, ieri] = await Promise.all([
        prova('allarmi', errori, () => letture.storiaAllarmi(aws, { da, a: ora }), { voci: [], troncato: false }),
        prova('allarmi', errori, () => letture.metadatiAllarmi(aws), {}),
        prova('ecs', errori, () => letture.eventiEcsAccount(aws, services.filter((s) => s.account === chiave)), []),
        prova('metriche', errori, () => letture.metricheGiorno(aws, { da: oggi0, a: ora }), null),
        prova('metriche', errori, () => letture.metricheGiorno(aws, { da: ieri0, a: oggi0 }), null),
      ])
      Object.assign(riga, { voci: storia.voci, troncato: storia.troncato, meta, ecs, metriche: oggi || ieri ? { oggi, ieri } : null })
    }),
  )
  return componiStorico({ perConto, ora, ore })
}
