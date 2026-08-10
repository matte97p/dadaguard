// Segnale: allarmi CloudWatch ATTIVI (stato ALARM) correlati alla risorsa del servizio.
// È il "c'è qualcosa che sta urlando adesso?" di una dashboard. Read-only.
// Gli allarmi in stato ALARM si precaricano UNA volta per account (in status.js) e qui si
// correlano per dimensione → niente chiamata per-servizio. La riga compare SOLO se c'è un
// allarme attivo per quella risorsa (zero rumore quando è tutto a posto).
// Permesso: cloudwatch:DescribeAlarms.
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from '../runtime/awsClient.js'

export const key = 'alarms'

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

export async function run(service, ctx) {
  const firing = ctx?.alarms // preload per account (undefined = non disponibile → salta)
  if (!firing) return null
  const ids = new Set(resourceIds(service.aws))
  if (!ids.size) return null
  const t = ctx?.t ?? ((k) => k)

  const mine = firing.filter((a) =>
    (a.Dimensions ?? []).some((d) => ids.has(String(d.Value)) || targetGroupMatches(service.aws, d)),
  )
  if (!mine.length) return null // nessun allarme attivo per questa risorsa → niente riga

  const names = mine.slice(0, 3).map((a) => a.AlarmName)
  const more = mine.length > 3 ? `, +${mine.length - 3}` : ''
  return { key, status: 'degraded', summary: t('alarms.firing', { n: mine.length, list: names.join(', ') + more }) }
}
