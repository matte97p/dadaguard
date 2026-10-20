// L'ANDAMENTO dei servizi web (vista «Andamento» della pagina Servizi): quanto rispondono e quanti
// errori danno, nel tempo, letti dalle metriche dell'Application Load Balancer davanti a ciascuno.
//
// Da dove: `AWS/ApplicationELB`, per target group (dimensioni LoadBalancer + TargetGroup, l'unica
// combinazione che AWS pubblica per servizio), quattro metriche per servizio:
//   TargetResponseTime p50 e p90   il tempo di risposta di solito e nei momenti lenti
//   HTTPCode_Target_5XX_Count Sum  gli errori dell'APPLICAZIONE (un 502 dell'ALB non e' un bug suo)
//   RequestCount Sum               il denominatore, e il traffico
// Gli access log (server/albLatency.js) darebbero la latenza per replica, ma qui serve l'andamento di
// settimane: scaricare e decomprimere un mese di log per ogni servizio costerebbe minuti e gigabyte.
//
// COSA COSTA, ed e' il vincolo di progetto: GetMetricData si paga a metrica chiesta, circa 0,01 $ ogni
// 1.000 metriche, qualunque sia il numero di punti di ciascuna. Un'apertura chiede 4 metriche per
// servizio, con un tetto di TETTO servizi (30): al massimo 120 metriche, cioe' 0,0012 $.
//   · 24 ore, cache 5 minuti: anche con la pagina aperta tutto il giorno sono 288 giri, 34.560
//     metriche, 0,35 $ al giorno (circa 10 $ al mese nel caso peggiore di un tab sempre aperto). Chi
//     non guarda non paga: la cache rinfresca solo quando qualcuno chiede (util/swr.js), e la pagina
//     smette di chiedere col tab nascosto (usePoll).
//   · 7 e 30 giorni, cache 30 minuti: 48 giri al giorno, 5.760 metriche, meno di 0,06 $ al giorno.
// Per confronto, lo stato completo legge circa 470 metriche a giro (vedi quadroStato.js).
// Le DESCRIBE che servono a trovare i target group (ECS DescribeServices, ELB DescribeTargetGroups e
// DescribeLoadBalancers) sono gratuite.
//
// Le query stanno in poche chiamate: fino a 500 per GetMetricData, ma anche non oltre i 100.800 punti
// che una risposta porta prima di paginare (a 288 punti sono 350 query), cosi' non si pagina mai.
//
// Le serie escono gia' sulla griglia della finestra (un valore per fascia, `null` dove non c'e'
// latenza); le somme fra servizi e i filtri li fa la pagina (shared/serviziSerie.js), cosi' cambiare
// servizio non rifa' il giro e non si ripaga.
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs'
import { ElasticLoadBalancingV2Client, DescribeTargetGroupsCommand, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { clientOpts } from './runtime/awsClient.js'
import { isQueryable } from './accounts.js'

// Le finestre ammesse, in ore, e il passo di ciascuna: 288, 168 e 120 punti, mai oltre i ~300 che un
// grafico largo uno schermo riesce a mostrare. Il passo rispetta anche le granularita' di CloudWatch
// (multiplo di 300 oltre i 15 giorni, vedi runtime/cw.js): una richiesta che le viola torna VUOTA senza
// errore, cioe' un grafico piatto che sembra un servizio fermo.
export const ORE = [24, 168, 720]
const PERIODO_S = { 24: 300, 168: 3600, 720: 21600 }

// Quanti servizi al massimo per giro. E' il tetto del costo: chi ne ha di piu' lo vede scritto in
// pagina, e restringe con l'ambiente in alto (che il server rispetta prima di tagliare).
export const TETTO = Number(process.env.DADAGUARD_ANDAMENTO_TETTO) || 30

export const METRICHE = [
  { k: 'p50', nome: 'TargetResponseTime', stat: 'p50' },
  { k: 'p90', nome: 'TargetResponseTime', stat: 'p90' },
  { k: 'errori', nome: 'HTTPCode_Target_5XX_Count', stat: 'Sum' },
  { k: 'richieste', nome: 'RequestCount', stat: 'Sum' },
]

const MAX_QUERY = 500
const MAX_PUNTI_RISPOSTA = 100_800
const MAX_PAGINE = 4 // non dovrebbe servire (vedi `blocchi`): e' la cintura, non le bretelle

// `?ore=` portato alla finestra ammessa piu' vicina per eccesso: 1 diventa 24, 100 diventa 168, oltre
// il mese resta il mese. Un valore che non e' un numero vale 24. Puro.
export function oreAndamento(q) {
  const n = Number(q)
  if (q == null || q === '' || !Number.isFinite(n)) return 24
  return ORE.find((o) => n <= o) ?? ORE.at(-1)
}

// La griglia della finestra: fasce del passo, allineate al passo (CloudWatch restituisce i punti
// allineati all'inizio chiesto, e con un inizio tondo ogni punto cade esattamente in una fascia).
// L'ultima fascia e' l'ultima CHIUSA: quella in corso avrebbe meta' delle richieste e sembrerebbe un
// calo di traffico ogni volta che si apre la pagina. Puro.
export function grigliaAndamento(ore, ora = Date.now()) {
  const passoMs = (PERIODO_S[ore] ?? PERIODO_S[24]) * 1000
  const fine = Math.floor(ora / passoMs) * passoMs
  const punti = Math.round((ore * 3_600_000) / passoMs)
  return { ore, inizio: fine - punti * passoMs, passoMs, punti }
}

// I valori di dimensione dagli ARN: CloudWatch vuole `targetgroup/<nome>/<id>` e `app/<nome>/<id>`, la
// coda dell'ARN. Un Network Load Balancer (`net/…`) torna null: pubblica in `AWS/NetworkELB`, dove il
// tempo di risposta non esiste. Puri.
export const dimensioneTg = (arn) => String(arn ?? '').match(/:(targetgroup\/[^:]+)$/)?.[1] ?? null
export const dimensioneLb = (arn) => String(arn ?? '').match(/:loadbalancer\/(app\/[^:]+)$/)?.[1] ?? null

// Le query di GetMetricData per i bersagli ({ lb, tg }): quattro per bersaglio, con un Id che dice da
// chi viene (`b<i>_<metrica>`). Un bersaglio senza target group (un ALB intero, `aws.type: alb`) si
// legge per LoadBalancer. Puro.
export function querieAndamento(bersagli, periodoS) {
  return bersagli.flatMap((b, i) =>
    METRICHE.map((m) => ({
      Id: `b${i}_${m.k}`,
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ApplicationELB',
          MetricName: m.nome,
          Dimensions: [{ Name: 'LoadBalancer', Value: b.lb }, ...(b.tg ? [{ Name: 'TargetGroup', Value: b.tg }] : [])],
        },
        Period: periodoS,
        Stat: m.stat,
      },
    })),
  )
}

// Le query divise in chiamate: al massimo 500, e non piu' di quante ne stanno in una risposta senza
// pagine. Puro.
export function blocchi(query, punti) {
  const misura = Math.max(1, Math.min(MAX_QUERY, Math.floor(MAX_PUNTI_RISPOSTA / Math.max(1, punti))))
  const out = []
  for (let i = 0; i < query.length; i += misura) out.push(query.slice(i, i + misura))
  return out
}

// Dai risultati di GetMetricData alle serie per servizio, sulla griglia. CloudWatch OMETTE le fasce
// senza dati: per i conteggi vuol dire zero (l'ALB non pubblica RequestCount se non e' arrivato
// niente), per la latenza vuol dire «non c'e'», e resta null. Una fascia con zero richieste non ha un
// tempo di risposta anche se ne arrivasse uno: sarebbe di una richiesta che non contiamo. Puro.
export function componiAndamento(bersagli, risultati, g) {
  const perId = new Map((risultati ?? []).map((r) => [r.Id, r]))
  return bersagli.map((b, i) => {
    const serie = {
      richieste: Array(g.punti).fill(0),
      errori: Array(g.punti).fill(0),
      p50: Array(g.punti).fill(null),
      p90: Array(g.punti).fill(null),
    }
    for (const m of METRICHE) {
      const r = perId.get(`b${i}_${m.k}`)
      const ts = r?.Timestamps ?? []
      const vs = r?.Values ?? []
      ts.forEach((t, j) => {
        const k = Math.round((new Date(t).getTime() - g.inizio) / g.passoMs)
        const v = vs[j]
        if (k < 0 || k >= g.punti || !Number.isFinite(v)) return
        // La latenza arriva in secondi: in millisecondi interi si legge e pesa meta' nel JSON.
        serie[m.k][k] = m.stat === 'Sum' ? Math.round(v) : Math.round(v * 1000)
      })
    }
    for (let k = 0; k < g.punti; k++) {
      if (serie.richieste[k] > 0) continue
      serie.p50[k] = null
      serie.p90[k] = null
    }
    return { k: `${b.account}|${b.servizio}`, account: b.account, servizio: b.servizio, ...serie }
  })
}

// Il payload della pagina: griglia, serie, conti e quanto si e' tagliato. Lo stesso per il vero e per
// la demo, che gli passa risultati finti. Puro.
export function payloadAndamento({ g, bersagli, risultati, account = {}, trovati = bersagli.length }) {
  return {
    ...g,
    servizi: componiAndamento(bersagli, risultati, g),
    account,
    bersagli: { trovati, mostrati: bersagli.length, tetto: TETTO },
    metriche: bersagli.length * METRICHE.length,
  }
}

// I candidati: i servizi ECS (cluster + service) e gli ALB dichiarati come servizio. Gli altri tipi
// non hanno un load balancer applicativo davanti. Puro.
export function candidati(services = [], accounts = {}, filtroConti = []) {
  return services.filter((s) => {
    const a = s.aws ?? {}
    if (!s.account || !accounts[s.account] || !isQueryable(accounts[s.account])) return false
    if (filtroConti.length && !filtroConti.includes(s.account)) return false
    return (a.type === 'ecs' && a.cluster && a.service) || (a.type === 'alb' && (a.arn || a.name))
  })
}

// Il tetto, in ordine stabile (ambiente, poi nome): dieci aperture di fila mostrano gli stessi trenta,
// e la pagina dice quanti ne restano fuori. Puro.
export function taglia(bersagli, tetto = TETTO) {
  const ordinati = [...bersagli].sort((a, b) => a.account.localeCompare(b.account) || a.servizio.localeCompare(b.servizio))
  return { scelti: ordinati.slice(0, tetto), trovati: ordinati.length }
}

const aGruppi = (lista, n) => Array.from({ length: Math.ceil(lista.length / n) }, (_, i) => lista.slice(i * n, i * n + n))

// I bersagli di un conto e di una regione: dal servizio ECS al suo target group (il primo, come la
// card: ecs.js), dal target group al suo load balancer. Tutte describe gratuite, a gruppi (dieci
// servizi per DescribeServices, venti ARN per le describe di ELB).
async function bersagliDi(account, servizi, aws) {
  const ecs = new ECSClient(clientOpts(aws))
  const elb = new ElasticLoadBalancingV2Client(clientOpts(aws))
  const tgDi = new Map() // nome servizio -> ARN del target group
  const perCluster = new Map()
  for (const s of servizi.filter((x) => x.aws.type === 'ecs')) {
    if (!perCluster.has(s.aws.cluster)) perCluster.set(s.aws.cluster, [])
    perCluster.get(s.aws.cluster).push(s)
  }
  for (const [cluster, lista] of perCluster) {
    for (const gruppo of aGruppi(lista, 10)) {
      const out = await ecs.send(new DescribeServicesCommand({ cluster, services: gruppo.map((s) => s.aws.service) }))
      for (const d of out.services ?? []) {
        const tg = (d.loadBalancers ?? []).map((lb) => lb.targetGroupArn).find(Boolean)
        const s = gruppo.find((x) => x.aws.service === d.serviceName || d.serviceArn?.endsWith(`/${x.aws.service}`))
        if (tg && s) tgDi.set(s.name, tg)
      }
    }
  }
  const lbDiTg = new Map()
  for (const gruppo of aGruppi([...new Set(tgDi.values())], 20)) {
    const out = await elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: gruppo }))
    for (const tg of out.TargetGroups ?? []) lbDiTg.set(tg.TargetGroupArn, tg.LoadBalancerArns?.[0] ?? null)
  }
  const fuori = []
  for (const [nome, tgArn] of tgDi) {
    const lb = dimensioneLb(lbDiTg.get(tgArn))
    const tg = dimensioneTg(tgArn)
    if (lb && tg) fuori.push({ account, servizio: nome, lb, tg })
  }
  // Gli ALB dichiarati come servizio: per ARN o per nome, letti insieme.
  const alb = servizi.filter((x) => x.aws.type === 'alb')
  const perArn = alb.filter((s) => s.aws.arn)
  const perNome = alb.filter((s) => !s.aws.arn)
  const lbs = []
  for (const g of aGruppi(perArn, 20)) lbs.push(...((await elb.send(new DescribeLoadBalancersCommand({ LoadBalancerArns: g.map((s) => s.aws.arn) }))).LoadBalancers ?? []))
  for (const g of aGruppi(perNome, 20)) lbs.push(...((await elb.send(new DescribeLoadBalancersCommand({ Names: g.map((s) => s.aws.name) }))).LoadBalancers ?? []))
  for (const s of alb) {
    const lb = lbs.find((x) => x.LoadBalancerArn === s.aws.arn || x.LoadBalancerName === s.aws.name)
    const dim = lb?.Type === 'application' ? dimensioneLb(lb.LoadBalancerArn) : null
    if (dim) fuori.push({ account, servizio: s.name, lb: dim, tg: null })
  }
  return fuori
}

// Le metriche di un conto e di una regione, nelle poche chiamate di `blocchi`.
async function metricheDi(bersagli, aws, g) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const risultati = []
  for (const blocco of blocchi(querieAndamento(bersagli, g.passoMs / 1000), g.punti)) {
    let token
    let pagine = 0
    do {
      const out = await cw.send(
        new GetMetricDataCommand({
          StartTime: new Date(g.inizio),
          EndTime: new Date(g.inizio + g.punti * g.passoMs),
          ScanBy: 'TimestampAscending',
          MetricDataQueries: blocco,
          NextToken: token,
        }),
      )
      for (const r of out.MetricDataResults ?? []) {
        const gia = risultati.find((x) => x.Id === r.Id)
        if (gia) {
          gia.Timestamps.push(...(r.Timestamps ?? []))
          gia.Values.push(...(r.Values ?? []))
        } else risultati.push({ Id: r.Id, Timestamps: [...(r.Timestamps ?? [])], Values: [...(r.Values ?? [])] })
      }
      token = out.NextToken
      pagine++
    } while (token && pagine < MAX_PAGINE)
  }
  return risultati
}

// La lettura vera: bersagli di ogni conto (e regione), tetto, metriche. Un conto che non si legge
// diventa un errore di QUEL conto, e gli altri rispondono: «non ho potuto guardare» non e' «nessun
// servizio». `cleanAwsReason` lo passa chi chiama, come fanno gli altri endpoint per conto.
export async function andamentoServizi({ services, accounts, ore = 24, conti = [], ora = Date.now(), errore = (e) => e.message }) {
  const g = grigliaAndamento(ore, ora)
  const scelti = candidati(services, accounts, conti)
  const gruppi = new Map()
  for (const s of scelti) {
    const a = accounts[s.account]
    const region = s.aws.region ?? a.region
    const k = `${s.account}|${region ?? ''}`
    if (!gruppi.has(k)) gruppi.set(k, { account: s.account, aws: { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region }, servizi: [] })
    gruppi.get(k).servizi.push(s)
  }
  const conto = {}
  const etichetta = (k) => accounts[k]?.label ?? k
  for (const s of scelti) conto[s.account] = { label: etichetta(s.account) }

  const trovatiPerGruppo = await Promise.all(
    [...gruppi.values()].map(async (gr) => {
      try {
        return (await bersagliDi(gr.account, gr.servizi, gr.aws)).map((b) => ({ ...b, gruppo: gr }))
      } catch (err) {
        conto[gr.account] = { label: etichetta(gr.account), error: errore(err) }
        return []
      }
    }),
  )
  const { scelti: bersagli, trovati } = taglia(trovatiPerGruppo.flat())

  // Le metriche per gruppo (credenziali e regione diverse), poi tutte insieme nell'ordine dei
  // bersagli: gli Id ritornano globali, cosi' `componiAndamento` non sa da quale conto arrivano.
  const risultati = []
  const falliti = new Set()
  const perGruppo = new Map()
  bersagli.forEach((b, i) => {
    if (!perGruppo.has(b.gruppo)) perGruppo.set(b.gruppo, [])
    perGruppo.get(b.gruppo).push(i)
  })
  await Promise.all(
    [...perGruppo].map(async ([gr, indici]) => {
      try {
        const locali = await metricheDi(indici.map((i) => bersagli[i]), gr.aws, g)
        // Id locale `b<j>_…` -> Id globale `b<indici[j]>_…`.
        for (const r of locali) {
          const [, j, m] = r.Id.match(/^b(\d+)_(.+)$/) ?? []
          if (j != null) risultati.push({ ...r, Id: `b${indici[Number(j)]}_${m}` })
        }
      } catch (err) {
        falliti.add(gr)
        conto[gr.account] = { label: etichetta(gr.account), error: errore(err) }
      }
    }),
  )
  const puliti = bersagli.map(({ gruppo, ...b }) => b)
  const out = payloadAndamento({ g, bersagli: puliti, risultati, account: conto, trovati })
  // Un gruppo senza metriche esce dalle serie: i suoi zeri direbbero «nessuna richiesta», che e'
  // l'opposto di «non sono riuscito a leggere». L'errore resta scritto sul suo conto.
  out.servizi = out.servizi.filter((_, i) => !falliti.has(bersagli[i].gruppo))
  return out
}
