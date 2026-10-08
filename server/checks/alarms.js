// Segnale: allarmi CloudWatch ATTIVI (stato ALARM) correlati alla risorsa del servizio.
// È il "c'è qualcosa che sta urlando adesso?" di una dashboard. Read-only.
// Gli allarmi in stato ALARM si precaricano UNA volta per account (in status.js) e qui si
// correlano per dimensione → niente chiamata per-servizio. La riga compare SOLO se c'è un
// allarme attivo per quella risorsa (zero rumore quando è tutto a posto).
// Permesso: cloudwatch:DescribeAlarms.
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from '../runtime/awsClient.js'
import { truncateList } from '../util/format.js'

export const key = 'alarms'

const MAX_NOMI = 3 // quanti allarmi si nominano prima di «+N»

// Allarmi di autoscaling (target tracking): AWS li crea da solo, in coppia, per ogni policy —
// `AlarmHigh` = "scala su", `AlarmLow` = "scala giù". NON sono segnali di salute: l'AlarmLow sta
// in ALARM per design quando il carico è basso (in staging praticamente sempre) e comunque lo
// scale-in non scende mai sotto la capacità minima. Vanno esclusi, altrimenti generano falsi
// "ATTENZIONE" su ogni servizio. Riconoscimento: nome standard `TargetTracking-...` e, come rete
// di sicurezza, azione dell'allarme = una scaling policy (`:scalingPolicy:`).
export function isAutoscalingAlarm(a) {
  if (String(a?.AlarmName ?? '').startsWith('TargetTracking-')) return true
  const actions = [
    ...(a?.AlarmActions ?? []),
    ...(a?.OKActions ?? []),
    ...(a?.InsufficientDataActions ?? []),
  ]
  return actions.some((arn) => String(arn).includes(':scalingPolicy:'))
}

// L'allarme ha GIA' chi lo dice: fra le sue AlarmActions c'e' un topic SNS, cioe' allarme → SNS → una
// Lambda o un abbonamento che scrive su Slack da se' (es. il notifier degli allarmi ALB in
// aws-management, modules/alb-alarms). Per quelli Dadaguard non deve parlare: il notifier lo dice
// nel momento in cui scatta e lo richiude quando rientra, mentre noi arriviamo al giro dopo e con il
// debounce. Visto l'08/10/2026: `acme-production-alb-5xx` scattato alle 14:52, detto dal suo notifier
// alle 14:52 e rientrato alle 15:01, e alle 15:01 un nostro «1 allarme attivo» su un fatto gia' detto
// e gia' finito. Sulla dashboard restano: e' l'unico posto dove si vedono tutti insieme.
// Contano solo le AlarmActions (lo scatto), non le OKActions: e' lo scatto che non va detto due volte.
// La partizione dell'ARN non si fissa (`arn:aws:`, `arn:aws-cn:`, …).
const SNS_ARN = /^arn:[^:]+:sns:/
export function haNotificaPropria(a) {
  return (a?.AlarmActions ?? []).some((arn) => SNS_ARN.test(String(arn)))
}

// Allarmi attualmente in ALARM nell'account (preload), esclusi quelli di autoscaling. Paginato.
// Nota: regionale → usa la region dell'account; i servizi con override `aws.region` in un'altra
// region non sono coperti dal preload (limite noto, raro).
export async function fetchFiringAlarms(aws) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const alarms = []
  let token
  do {
    const out = await cw.send(new DescribeAlarmsCommand({ StateValue: 'ALARM', MaxRecords: 100, NextToken: token }))
    alarms.push(...(out.MetricAlarms ?? []))
    token = out.NextToken
  } while (token)
  return alarms.filter((a) => !isAutoscalingAlarm(a))
}

// Identificativi del servizio da cercare nelle dimensioni degli allarmi.
// ECS: l'identità è il ServiceName (`cfg.service`), NON il cluster. Un cluster è condiviso da più
// servizi (es. acme-staging → backend, agentic-chat, …): se cercassimo anche per cluster, un
// allarme con dimensione `ClusterName` si attaccherebbe a TUTTI i servizi del cluster (falsa
// attribuzione). Per gli altri tipi il "cluster" È la risorsa (EKS, ElastiCache…) → va tenuto.
const resourceIds = (cfg) =>
  (cfg?.type === 'ecs'
    ? [cfg?.service]
    : [cfg?.function, cfg?.cluster, cfg?.service, cfg?.instance, cfg?.instanceId, cfg?.asg, cfg?.name, cfg?.table, cfg?.queue]
  )
    .filter(Boolean)
    .map(String)

// Gli allarmi su un ALB (5xx, latenza, target malsani) NON portano il nome del servizio ECS: le loro
// dimensioni sono `LoadBalancer` = `app/<alb>/<hash>` e `TargetGroup` = `targetgroup/<nome>/<hash>`.
// Col solo confronto per valore restavano invisibili — venivano scaricati e poi scartati.
//
// Il ponte è la convenzione di nome dei target group, che è deterministica: `<cluster>-<servizio>`
// (es. cluster `acme-production` + servizio `backend` → `acme-production-backend`). Confrontiamo il
// SEGMENTO centrale, non la stringa intera, così `LoadBalancer` non entra mai in gioco: un ALB è
// condiviso da più servizi e attaccare i suoi allarmi a tutti sarebbe la stessa falsa attribuzione
// che il commento su `resourceIds` evita per il cluster.
//
// Prefisso e non uguaglianza perché lo stesso servizio può avere più gruppi (`acme-production-backend`
// sull'ALB pubblico e `acme-production-backend-int` su quello interno). Il rovescio: un servizio il cui
// nome è prefisso di un altro erediterebbe i suoi allarmi — oggi non accade, ma se un domani nascesse
// un servizio `analisi` accanto ad `analisi-avanzata` andrebbe stretto a uguaglianza.
const targetGroupMatches = (cfg, dimension) => {
  if (cfg?.type !== 'ecs' || !cfg?.cluster || !cfg?.service) return false
  if (dimension.Name !== 'TargetGroup') return false
  const nome = String(dimension.Value).split('/')[1] // targetgroup/<nome>/<hash>
  return Boolean(nome) && nome.startsWith(`${cfg.cluster}-${cfg.service}`)
}

// «Questo allarme e' di questo servizio?»: le sue dimensioni ne nominano la risorsa. Estratta da `run`
// perche' la stessa domanda serve anche al rovescio, per trovare quelli che non sono di nessuno.
export function alarmDelServizio(alarm, cfgAws) {
  const ids = new Set(resourceIds(cfgAws))
  if (!ids.size) return false
  return (alarm?.Dimensions ?? []).some((d) => ids.has(String(d.Value)) || targetGroupMatches(cfgAws, d))
}

// Gli allarmi che stanno urlando e che nessun servizio riconosce come suoi.
//
// ⚠️ Un allarme nato da un METRIC FILTER su un log group NON ha dimensioni: la sua metrica conta le
// righe di un log, non lo stato di una risorsa, quindi non c'e' niente da correlare. Con la sola
// correlazione per dimensione quegli allarmi venivano scaricati e poi buttati via, cioe' non
// comparivano da nessuna parte: un allarme che nessuno vede e' un allarme che non esiste, ed e'
// esattamente il caso in cui suona qualcosa che nessun servizio possiede (visto il 01/09/2026).
// Restano fuori quelli di autoscaling, come in `fetchFiringAlarms`: li' sono gia' filtrati.
export function alarmiSenzaServizio(firing = [], servizi = []) {
  return firing.filter((a) => !servizi.some((s) => alarmDelServizio(a, s?.aws)))
}

export async function run(service, ctx) {
  const firing = ctx?.alarms // preload per account (undefined = non disponibile → salta)
  if (!firing) return null
  const ids = new Set(resourceIds(service.aws))
  if (!ids.size) return null
  const t = ctx?.t ?? ((k) => k)

  const mine = firing.filter((a) => alarmDelServizio(a, service.aws))
  if (!mine.length) return null // nessun allarme attivo per questa risorsa → niente riga

  // `truncateList` e non un `, +N` scritto a mano: la regola sta in un posto solo (`util/format.js`),
  // che è l'unico modo di cambiarla senza dimenticarne una copia. Tetto 3 e non 2: un allarme arriva
  // spesso in gruppo (5xx + latenza + target), e vederne tre dice se è un sintomo o un incendio.
  const list = truncateList(
    mine.map((a) => a.AlarmName),
    MAX_NOMI,
  )
  const summary = t('alarms.firing', { n: mine.length, list })
  const daDire = mine.filter((a) => !haNotificaPropria(a))
  if (daDire.length === mine.length) return { key, status: 'degraded', summary }

  // Lo stato resta `degraded` per tutti: la card deve restare gialla finche' qualcosa suona. Cambia
  // solo chi lo dice su Slack, e lo decide il notificatore leggendo questi campi (vedi
  // `overallPerNotifica` in status.js):
  //  · tutti gia' detti dal loro notifier → `notificatoAltrove`, e per Slack questo check non conta;
  //  · misti → il check conta, ma `alert` (la frase che va in chat, vedi `snapshot` in notify/diff.js)
  //    nomina solo quelli che nessun altro dice.
  // La nota in coda al summary e' per chi guarda la card: spiega perche' l'allarme non e' arrivato
  // anche da Dadaguard.
  if (!daDire.length) return { key, status: 'degraded', summary: `${summary} · ${t('alarms.notifiedElsewhere')}`, notificatoAltrove: true }
  return {
    key,
    status: 'degraded',
    summary: `${summary} · ${t('alarms.someNotifiedElsewhere', { n: mine.length - daDire.length })}`,
    alert: t('alarms.firing', { n: daDire.length, list: truncateList(daDire.map((a) => a.AlarmName), MAX_NOMI) }),
  }
}
