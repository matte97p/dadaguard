import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { clientOpts } from './awsClient.js'
import { awsState } from '../i18n.js'
import { truncateList } from '../util/format.js'
import { isTransientTargetState } from '../../shared/targetStates.js'


// I target NON sani, con il motivo che dà AWS (`Target.FailedHealthChecks`, `Target.Timeout`,
// `Elb.RegistrationInProgress`…): è la differenza tra «uno è fuori» e «sapere perché». Arriva dalla
// stessa `DescribeTargetHealth` che serviva per contarli — zero chiamate in più. Pura/testabile.
export function unhealthyList(bad) {
  return truncateList(bad.map((b) => (b.reason ? `${b.id} (${b.reason})` : b.id)))
}

// Divide le `TargetHealthDescriptions` di un target group in sani / rotti / in transizione (l'elenco
// degli stati di transizione sta in `shared/targetStates.js`, perché lo usa anche il web).
//
// I target in transizione escono da ENTRAMBI i conteggi, non solo dalla lista: lasciarli in `total`
// terrebbe `healthy < total`, cioè il giallo, che è esattamente il falso allarme da togliere. Contarli
// come guasti significava un ATTENZIONE a OGNI rilascio: visto il 15/08/2026 alle 04:56 su un ALB
// interno di staging (2 target su 8 «non sani», entrambi `Target.DeregistrationInProgress`, con il
// rilascio dei due servizi finito 50 secondi dopo). Il debounce di `diffStates` non basta: il draining
// dura minuti, quindi regge due letture di fila.
//
// `registered` resta il numero VERO di target iscritti al target group, transizione compresa: è quello
// che va detto in chat («2 su 8», non «2 su 1») ed è il denominatore su cui si misura `expectedHealthy`.
// `total` invece è quanti target stanno davvero servendo o dovrebbero: è la base del colore. Pura/testabile.
export function countTargets(descs) {
  let healthy = 0
  let total = 0
  let transitioning = 0
  const bad = []
  for (const d of descs ?? []) {
    const state = d.TargetHealth?.State
    if (isTransientTargetState(state)) {
      transitioning++
      continue
    }
    total++
    if (state === 'healthy') {
      healthy++
      continue
    }
    bad.push({ id: d.Target?.Id ?? '?', reason: d.TargetHealth?.Reason ?? state ?? null })
  }
  return { healthy, total, transitioning, registered: total + transitioning, bad }
}

// Endpoint pubblico di un load balancer (per la card): il DNS name SE è internet-facing (raggiungibile
// da fuori); interno → null (non lo mostro, non sarebbe cliccabile). Puro/testabile.
export function publicUrlOfLb(lb) {
  return lb?.Scheme === 'internet-facing' && lb?.DNSName ? `https://${lb.DNSName}` : null
}

// Quanti target sani vogliono dire «tutto a posto». Di norma tutti quelli registrati, ma non sempre:
// nel target group del WRITER di un cluster Postgres in replica, l'health check passa solo sul primario,
// quindi lo standby registrato è `unhealthy` PER COSTRUZIONE e lo stato di regime è 1 sano su 2. Senza
// questa distinzione quel servizio resta giallo per sempre, e un allarme che suona ogni giorno per il
// funzionamento normale insegna a ignorare il canale: il contrario di quello che serve. Pura/testabile.
//
// `atteso` non spegne il rosso: zero sani resta GIÙ anche se ne bastava uno. Un numero più alto dei
// target registrati vale come «tutti» (config vecchia, cluster ridimensionato: non si inventa un guasto).
//
// `transitioning` è il caso limite in cui NESSUN target sta servendo perché stanno entrando o uscendo
// tutti: capita per mezzo minuto quando si rilascia un servizio a una copia sola (vecchia in draining,
// nuova ancora `initial`). Lì il load balancer risponde davvero 503, quindi non si può tacere, ma
// nemmeno gridare GIÙ per una cosa che rientra da sé: giallo, e il giro di notifica lo conferma solo se
// REGGE due letture (a 300s l'una fanno dieci minuti di traffico a vuoto, che non è più un rilascio).
export function albStatus(healthy, total, expected = null, transitioning = 0) {
  if (total === 0) return transitioning > 0 ? 'degraded' : 'unknown'
  if (healthy === 0) return 'down'
  const atteso = Math.min(Number.isFinite(expected) && expected > 0 ? expected : total, total)
  return healthy >= atteso ? 'up' : 'degraded'
}

// Quanti target sani ci si aspetta, misurati sui target REGISTRATI: `expectedHealthy` è un pavimento
// dichiarato a mano («di questi quattro, due devono servire»), quindi schiacciarlo sul totale già
// ridotto dalla transizione lo trasformerebbe in «basta quello che è rimasto», cioè verde a un target
// solo su due voluti. Pura/testabile.
export function expectedHealthyFloor(expected, registered) {
  return Math.min(Number.isFinite(expected) && expected > 0 ? expected : registered, registered)
}

// La frase della card. Tre casi che è facile confondere, e confonderli manda a cercare la cosa
// sbagliata: nessun target ISCRITTO (configurazione, o servizio spento), tutti i target in TRANSIZIONE
// (rilascio in corso), e il caso normale. Pura/testabile: la composizione è dove si sbaglia il ramo.
export function targetsSummary({ healthy, total, transitioning, registered, atteso }, t) {
  if (total === 0) return transitioning > 0 ? t('alb.alltransitioning', { n: transitioning }) : t('alb.notarget')
  return (
    t('alb.targets', { healthy, total }) +
    (atteso < registered ? t('alb.expected', { n: atteso }) : '') +
    (transitioning > 0 ? t('alb.transitioning', { n: transitioning }) : '')
  )
}

// RuntimeProvider per ALB: stato del LB + target healthy / totali (su tutti i target group).
// Permessi: elasticloadbalancing:Describe*.
// Config: aws: { type: alb, name: <lb-name> }  oppure  { type: alb, arn: <lb-arn> }
//         `expectedHealthy: <n>` = quanti sani sono la normalità (default: tutti)
export async function albRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const client = new ElasticLoadBalancingV2Client(clientOpts(aws))

  const lbOut = await client.send(
    new DescribeLoadBalancersCommand(cfg.arn ? { LoadBalancerArns: [cfg.arn] } : { Names: [cfg.name] }),
  )
  const lb = lbOut.LoadBalancers?.[0]
  if (!lb) return { status: 'unknown', reason: t('alb.notfound') }
  const url = publicUrlOfLb(lb) // endpoint pubblico (link sulla card), solo se internet-facing
  if (lb.State?.Code !== 'active') {
    return {
      status: lb.State?.Code === 'failed' ? 'down' : 'degraded',
      summary: t('alb.state', { code: awsState(lb.State?.Code, t) }),
      url,
    }
  }

  // Health dei target: se le describe falliscono (permessi, throttling) NON rompere la card —
  // il LB è comunque `active`, quindi degrada con un messaggio chiaro invece di sollevare.
  let healthy = 0
  let total = 0
  let transitioning = 0 // target che entrano o escono: non sono né sani né rotti (vedi countTargets)
  const bad = [] // chi è fuori e perché: la notizia è il target FUORI, non quelli dentro
  try {
    // paginazione target group (Marker/NextMarker): senza loop si ignorano i TG oltre la prima pagina.
    const tgs = []
    let marker
    do {
      const r = await client.send(
        new DescribeTargetGroupsCommand({ LoadBalancerArn: lb.LoadBalancerArn, Marker: marker }),
      )
      tgs.push(...(r.TargetGroups ?? []))
      marker = r.NextMarker
    } while (marker)
    for (const tg of tgs) {
      const th =
        (await client.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn })))
          .TargetHealthDescriptions ?? []
      const c = countTargets(th)
      total += c.total
      healthy += c.healthy
      transitioning += c.transitioning
      bad.push(...c.bad)
    }
  } catch {
    return { status: 'degraded', summary: t('alb.healthUnreachable'), url }
  }

  const registered = total + transitioning
  const atteso = expectedHealthyFloor(cfg.expectedHealthy, registered)
  const status = albStatus(healthy, total, cfg.expectedHealthy, transitioning)
  // In chat il conteggio da solo non basta: `alert` dice quanti sono fuori (non quanti sono dentro),
  // quali e con che motivo. La card tiene il conteggio, che accanto alla metrica è più leggibile.
  // Il denominatore è quello REGISTRATO: «nessuno dei 1 target è sano» con otto iscritti farebbe
  // dimensionare il guasto sul numero sbagliato a chi legge in reperibilità.
  const alert = bad.length && status !== 'up'
    ? t(healthy === 0 ? 'alb.allunhealthy' : 'alb.unhealthy', {
        n: bad.length,
        total: registered,
        list: unhealthyList(bad),
      })
    : undefined
  return {
    status,
    summary: targetsSummary({ healthy, total, transitioning, registered, atteso }, t),
    ...(alert ? { alert } : {}),
    // I target in transizione escono dal COLORE ma non dalla risposta: senza questo campo l'unico posto
    // dove esistono è una frase tradotta, e il prossimo che ne ha bisogno la rilegge con una regex.
    ...(transitioning > 0 ? { transitioning } : {}),
    registered,
    metrics:
      total === 0
        ? undefined
        : [{ label: t('m.targets'), value: `${healthy}/${total}`, tone: status === 'up' ? 'good' : status === 'down' ? 'critical' : 'warning' }],
    url,
  }
}
