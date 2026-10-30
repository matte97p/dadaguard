import { SQSClient, ReceiveMessageCommand, DeleteMessageBatchCommand } from '@aws-sdk/client-sqs'
import { CloudWatchClient, DescribeAlarmHistoryCommand, DescribeAlarmsCommand, GetMetricDataCommand, ListTagsForResourceCommand } from '@aws-sdk/client-cloudwatch'
import { DescribeServicesCommand, ECSClient } from '@aws-sdk/client-ecs'
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeMetricFiltersCommand,
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import { clientOpts } from '../runtime/awsClient.js'
import { resolveLogGroup } from '../logs.js'
import { alarmDelServizio, isAutoscalingAlarm } from '../checks/alarms.js'
import { resolveServices } from '../status.js'
import { makeT } from '../i18n.js'
import { log } from '../log.js'
import { stripOrgEnv } from '../util/envToken.js'
import { ripulisci } from '../util/ripulisci.js'
import { envTag, postSlack } from './slack.js'
import { chiamaSlack, quadroConfig, regoleSquadre, squadraDiRegole } from './quadro.js'
import { regioneDaUrl } from './eventi.js'

// Gli ALLARMI CloudWatch detti da Dadaguard, nel momento in cui cambiano stato.
//
// Perché esiste: fino a qui ogni modulo d'allarme dell'infrastruttura aveva il SUO recapito (allarme →
// SNS → una Lambda che traduce e scrive su Slack), e ognuno diceva «guarda i log» senza guardarli. Il
// 21/10/2026 un allarme di memoria su un servizio ECS ha detto solo questo, e per sapere che cosa stava
// facendo il task (un job che aveva gonfiato un worker da 0,8 a 1,85 GB, poi ucciso e ripartito) è
// servito un quarto d'ora di query a mano. Qui la stessa ricerca la fa Dadaguard, e la mette nel thread
// del messaggio.
//
// Da dove arrivano: l'evento EventBridge `CloudWatch Alarm State Change`, che ogni account inoltra sul
// bus di Dadaguard, e una regola mette in una coda SQS SOLO sua (`DADAGUARD_ALLARMI_CODA`). Non la coda
// del quadro: quel lettore cancella tutto quello che legge, anche quello che non capisce, e se le due
// cose passassero dalla stessa coda un allarme potrebbe finire cancellato dal lettore sbagliato.
//
// Che cosa si dice, e che cosa no (le regole stanno in `decidi`, tutte su dati che l'evento porta):
//   ALARM                 🚨, o ⚠️ se il tag `severity` dice che è da guardare e non da svegliarsi
//   ALARM → OK            ✅ rientrato
//   INSUFFICIENT_DATA     ⚠️ l'allarme non sa dire
//   INSUFFICIENT → OK     ✅ solo se prima del buco l'allarme suonava (lo dice la sua storia). L'OK di
//                         un allarme appena nato non è un rientro: nessun guasto è mai stato detto
//   INSUFFICIENT → ALARM  con la finestra INTERA vuota è un allarme che non ha ancora mai visto un dato
//                         (un heartbeat appena applicato): ℹ️, e il suo OK non si dice
// Gli allarmi di autoscaling non si dicono mai: scalano, non avvisano.
//
// Dove: il tag `team` dell'allarme, se è `data`, manda nel canale della squadra data; sennò decide la
// regola delle squadre del quadro (DADAGUARD_QUADRO_SQUADRE) sul nome; tutto il resto nel canale
// principale. Il rientro va dove è andato l'allarme, perché i tag sono gli stessi.
//
// La lingua: `DADAGUARD_ALLARMI_LANG`, inglese di default. Le DESCRIZIONI degli allarmi le scrive chi li
// crea (nell'IaC), e arrivano così come sono.
//
// Configurazione:
//   DADAGUARD_ALLARMI_CODA          l'indirizzo della coda. Senza, niente di questo file parte
//   DADAGUARD_ALLARMI_CANALE        id del canale (`C0…`) dove il bot scrive gli allarmi. Col bot il
//                                   messaggio ha un thread, e i log ci vanno dentro. Senza, si usa il
//                                   webhook principale e i log stanno in coda al messaggio, più corti
//   DADAGUARD_ALLARMI_DATA_CANALE   il canale della squadra data (lo stesso del watchdog)
//   DADAGUARD_SLACK_BOT_TOKEN       il bot del quadro, che deve essere nei canali
//   DADAGUARD_ALLARMI_LANG          `en` (default) o `it`

const VISIBILITA_S = 120

export function allarmiConfig(env = process.env) {
  return {
    coda: env.DADAGUARD_ALLARMI_CODA || null,
    canale: env.DADAGUARD_ALLARMI_CANALE || null,
    canaleData: env.DADAGUARD_ALLARMI_DATA_CANALE || null,
    webhook: env.DADAGUARD_SLACK_WEBHOOK || null,
    botToken: env.DADAGUARD_SLACK_BOT_TOKEN || null,
    squadre: quadroConfig(env).squadre,
    publicUrl: env.DADAGUARD_PUBLIC_URL || null,
    lang: env.DADAGUARD_ALLARMI_LANG || 'en',
  }
}

// ── L'evento ───────────────────────────────────────────────────────────────────────────────────────

const STATI = new Set(['OK', 'ALARM', 'INSUFFICIENT_DATA'])
const quando = (x) => (x && Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : null)
const stringa = (x, max = 4000) => (typeof x === 'string' ? x.slice(0, max) : '')

// Il messaggio della coda → l'allarme che serve qui, o `null` se non è un cambio di stato di un allarme.
// La forma è quella di EventBridge: `detail.state`, `detail.previousState`, `detail.configuration`.
// Pura/testabile.
export function normalizzaAllarme(corpo) {
  let m = corpo
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m)
    } catch {
      return null
    }
  }
  if (!m || typeof m !== 'object') return null
  if (m.source !== 'aws.cloudwatch' || m['detail-type'] !== 'CloudWatch Alarm State Change') return null
  const d = m.detail ?? {}
  const nome = stringa(d.alarmName, 255)
  const stato = d.state?.value
  if (!nome || !STATI.has(stato)) return null
  const metriche = (d.configuration?.metrics ?? [])
    .map((x) => x?.metricStat)
    .filter(Boolean)
    .map((s) => ({
      namespace: stringa(s.metric?.namespace, 255),
      nome: stringa(s.metric?.name, 255),
      dimensioni: Object.fromEntries(Object.entries(s.metric?.dimensions ?? {}).map(([k, v]) => [String(k), String(v)])),
      periodo: Number(s.period) || 60,
      stat: stringa(s.stat, 50),
    }))
  let dati = null
  try {
    dati = d.state?.reasonData ? JSON.parse(d.state.reasonData) : null
  } catch {
    dati = null
  }
  return {
    id: stringa(m.id, 100) || null,
    nome,
    arn: stringa(m.resources?.[0], 512) || null,
    conto: stringa(m.account, 20),
    regione: stringa(m.region, 30),
    stato,
    prima: STATI.has(d.previousState?.value) ? d.previousState.value : null,
    motivo: stringa(d.state?.reason, 1000),
    descrizione: stringa(d.configuration?.description, 1024).trim(),
    quando: quando(d.state?.timestamp) ?? quando(m.time),
    // I punti valutati, per la finestra dei log: `evaluatedDatapoints[].timestamp` dice da quando
    // l'allarme stava guardando.
    valutati: (dati?.evaluatedDatapoints ?? []).map((p) => Date.parse(p?.timestamp)).filter(Number.isFinite),
    metriche,
    composto: Boolean(d.configuration?.alarmRule),
  }
}

// «no datapoints were received for 3 periods and 3 missing datapoints»: la finestra INTERA è vuota.
// Con anche un solo punto non lo è, e l'ALARM resta un guasto. Pura.
const RE_FINESTRA_VUOTA = /no datapoints were received for (\d+) periods? and (\d+) missing datapoints/
export function finestraVuota(motivo = '') {
  const m = RE_FINESTRA_VUOTA.exec(motivo)
  return Boolean(m) && m[1] === m[2]
}

// L'ultimo episodio prima di questo OK, dalla storia dell'allarme (le voci `StateUpdate`, dalla più
// recente): che stato c'era prima del buco di dati, e se l'ultimo ALARM era nato senza dati. Pura.
export function letturaStoria(voci = []) {
  let primaDelBuco = null
  let allarmeNatoSenzaDati = null
  for (const v of voci) {
    let h
    try {
      h = JSON.parse(v?.HistoryData ?? '{}')
    } catch {
      continue
    }
    const nuovo = h?.newState?.stateValue
    const vecchio = h?.oldState?.stateValue
    if (primaDelBuco === null && nuovo === 'INSUFFICIENT_DATA' && vecchio) primaDelBuco = vecchio
    if (allarmeNatoSenzaDati === null && nuovo === 'ALARM') allarmeNatoSenzaDati = vecchio === 'INSUFFICIENT_DATA' && finestraVuota(h?.newState?.stateReason ?? '')
    if (primaDelBuco !== null && allarmeNatoSenzaDati !== null) break
  }
  return { primaDelBuco, allarmeNatoSenzaDati: Boolean(allarmeNatoSenzaDati) }
}

// Che cosa dire di questo cambio di stato: `{ tipo, emoji }` o `null` per tacere. `storia` è il
// risultato di `letturaStoria`, chiesto solo quando serve (un OK). Pura/testabile.
export function decidi(a, { storia = null, severita = null } = {}) {
  if (!a || a.composto) return null
  if (isAutoscalingAlarm({ AlarmName: a.nome })) return null
  if (a.stato === 'ALARM') {
    if (a.prima === 'INSUFFICIENT_DATA' && finestraVuota(a.motivo)) return { tipo: 'nuovo', emoji: 'ℹ️' }
    return { tipo: 'acceso', emoji: /^(low|warning|medium)$/i.test(severita ?? '') ? '⚠️' : '🚨' }
  }
  if (a.stato === 'INSUFFICIENT_DATA') return { tipo: 'senzaDati', emoji: '⚠️' }
  // OK
  if (a.prima === 'ALARM') return storia?.allarmeNatoSenzaDati ? null : { tipo: 'rientro', emoji: '✅' }
  if (a.prima === 'INSUFFICIENT_DATA') return storia?.primaDelBuco === 'ALARM' && !storia.allarmeNatoSenzaDati ? { tipo: 'rientro', emoji: '✅' } : null
  return null
}

// Un allarme zittito da chi l'ha creato: notifiche spente, o nessuna azione su nessuno stato e nessun
// tag `team`. Il tag e' il recapito per Dadaguard: un allarme che lo porta senza azioni SNS e' fatto
// apposta per parlare solo da qui, e tacerlo vorrebbe dire non dirlo a nessuno. Puro.
export function zittito(x, tag = {}) {
  if (x?.ActionsEnabled === false) return true
  if (String(tag.team ?? '').trim()) return false
  return ![...(x?.AlarmActions ?? []), ...(x?.OKActions ?? []), ...(x?.InsufficientDataActions ?? [])].length
}

export { ripulisci }

// ── Il testo ───────────────────────────────────────────────────────────────────────────────────────

// La prima frase di una descrizione: su un rientro la descrizione intera parla del GUASTO, e incollata
// accanto a ✅ direbbe il contrario dello stato. La prima frase dice di che cosa si parla. Pura.
export function primaFrase(s = '') {
  const t = String(s).replace(/\s+/g, ' ').trim()
  const i = t.search(/[.!?](\s|$)/)
  return (i > 0 ? t.slice(0, i) : t).trim()
}

const MAX_DESCRIZIONE = 600

export function linkAllarme(a) {
  if (!a?.regione || !a?.nome) return null
  return `https://${a.regione}.console.aws.amazon.com/cloudwatch/home?region=${a.regione}#alarmsV2:alarm/${encodeURIComponent(a.nome)}`
}

// La riga del canale: `🚨 \`<nome>\` [PROD]: <descrizione> · <link>`. Il nome senza organizzazione e
// ambiente, che l'etichetta dice già. Sull'allarme acceso niente «alarm firing»: lo dice l'emoji, e la
// riga arriva prima alla descrizione; il rientro e gli altri stati la parola la tengono. Pura/testabile.
export function testoAllarme(a, decisione, { ambiente = null, t = (k) => k, url = null } = {}) {
  const soggetto = stripOrgEnv(a.nome) || a.nome
  const stato = decisione.tipo === 'acceso' ? '' : ` ${t(`allarmi.${decisione.tipo}`)}`
  const testa = `${decisione.emoji} \`${soggetto}\`${envTag(ambiente)}${stato}`
  const descr = a.descrizione || a.motivo
  const corpo =
    decisione.tipo === 'rientro'
      ? primaFrase(a.descrizione)
      : decisione.tipo === 'nuovo'
        ? t('allarmi.nuovoDettaglio')
        : String(descr).replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIZIONE)
  const link = linkAllarme(a)
  const coda = [link ? `<${link}|${t('allarmi.apri')}>` : null, url ? `<${url}|${t('notify.open')}>` : null].filter(Boolean).join(' · ')
  return `${testa}${corpo ? `: ${corpo}` : ''}${coda ? ` · ${coda}` : ''}`
}

// ── I log ──────────────────────────────────────────────────────────────────────────────────────────

// Le righe che dicono qualcosa su un guasto: errori, eccezioni, e i processi uccisi (un OOM dentro al
// container non scrive ERROR, scrive «Child process died» o «Killed»).
const RE_RIGHE = '(?i)(error|exception|traceback|fatal|critical|panic|died|killed|out of memory|oom|memoryerror|timed out|timeout)'
// Le richieste HTTP finite in 5xx, nella forma degli access log più comuni (`"GET /x HTTP/1.1" 502`).
const RE_5XX = /"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ([^\s?"]+)[^"]*" (5\d\d)\b/

// La FORMA di una riga, per contare insieme quelle che dicono la stessa cosa con numeri diversi: date,
// ore, id, numeri. Pura/testabile.
export function forma(riga = '') {
  return ripulisci(riga)
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]?\d*Z?\b/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\b[0-9a-f]{8,}\b/gi, '[id]')
    .replace(/\d+/g, '#')
    .trim()
}

// Le righe di contorno di un traceback Python: dicono DOVE, non COSA. Contate da sole riempivano il
// messaggio (`38× File "…", line 513`) e lasciavano fuori l'eccezione, che è l'unica riga che spiega.
// Anche le righe di codice che il traceback cita, rientrate di quattro spazi o più, e il rimando di
// SQLAlchemy alla sua documentazione.
const RE_CONTORNO = /^(\s{4}|\s*(Traceback \(most recent call last\)|File ".*", line \d+|The above exception was the direct cause|During handling of the above exception|\(Background on this error at|\^+\s*$|~+\s*$))/

// La riga finale di un'eccezione: `modulo.Classe: messaggio`. Con le eccezioni concatenate la stessa
// causa arriva tre o quattro volte, una per classe (asyncpg, sqlalchemy, la nostra): il messaggio dopo
// l'ultimo `: ` è lo stesso, e lì si raggruppano.
const RE_ECCEZIONE = /^[\w.]*(Error|Exception|Timeout|Interrupt|Exit)\b[^:]*: (.+)$/

// Una riga del logging Python a livello INFO o DEBUG non dice un guasto anche quando contiene «timeout»
// (`reason=idle_timeout`): entrava solo per la parola. Le righe `INFO:` di uvicorn restano.
const RE_INFO = / - (INFO|DEBUG) - /

// L'esempio senza la testa del logging Python (data, ora e il blocco di contesto fra quadre): resta
// `modulo - LIVELLO - messaggio`, che è la parte che si legge. Pura.
// Anche la forma `data ora LIVELLO modulo: messaggio` (il formato di `logging.basicConfig` con
// `%(asctime)s %(levelname)s %(name)s: %(message)s`): l'ora è già nella testata del thread.
const senzaTesta = (s) =>
  s
    .replace(/^\d{4}-\d{2}-\d{2} [\d:.,]+ - /, '')
    .replace(/^\d{4}-\d{2}-\d{2}[ T][\d:.,]+Z? (?=[A-Z]+ )/, '')
    .replace(/ - \[[^\]]*\] - /, ' - ')

// Le righe lette diventano al massimo `max` gruppi, dal più numeroso: `{ n, esempio, stream, gruppo,
// quando }`, più i log group in cui le righe stanno (`gruppi`). Le
// richieste in 5xx si contano per rotta e stato, a parte. Pura/testabile.
export function riassumiRighe(righe = [], { max = 4 } = {}) {
  const gruppi = new Map()
  const rotte = new Map()
  let ultima = null
  // I log group in cui le righe contate stanno davvero, quando la query ne ha letti più d'uno.
  const gruppiVisti = new Set()
  const vista = (r) => {
    if (Number.isFinite(r?.quando) && (ultima === null || r.quando > ultima)) ultima = r.quando
    if (r?.gruppo) gruppiVisti.add(r.gruppo)
  }
  for (const r of righe) {
    const msg = String(r?.message ?? '')
    if (!/[A-Za-z]/.test(msg) || RE_CONTORNO.test(msg)) continue
    const h = RE_5XX.exec(msg)
    if (h) {
      const k = `${h[1]} ${h[2]} ${h[3]}`
      rotte.set(k, (rotte.get(k) ?? 0) + 1)
      vista(r)
      continue
    }
    if (RE_INFO.test(msg)) continue
    vista(r)
    const e = RE_ECCEZIONE.exec(msg.trim())
    const k = e ? `eccezione:${forma(e[2].split(': ').pop())}` : forma(msg)
    const classe = e ? msg.trim().split(':')[0] : null
    const pulita = ripulisci(senzaTesta(msg))
    const g = gruppi.get(k) ?? { n: 0, esempio: pulita, stream: null, gruppo: null, quando: null, perClasse: new Map() }
    gruppi.set(k, g)
    // Stream, gruppo e istante della stessa riga: `puntoNelCodice` ci rilegge lo stack.
    if (r.stream) Object.assign(g, { stream: r.stream, gruppo: r.gruppo ?? null, quando: r.quando ?? null })
    if (!classe) {
      g.n += 1
      g.esempio = pulita
      continue
    }
    // Una catena conta una volta: il numero è quello della classe vista più spesso, non la somma.
    g.perClasse.set(classe, (g.perClasse.get(classe) ?? 0) + 1)
    g.n = Math.max(...g.perClasse.values())
    // L'esempio più corto: nella catena è quello che dice la causa senza il nome dell'altra classe.
    if (pulita.length < g.esempio.length) g.esempio = pulita
  }
  const ordina = (a, b) => b.n - a.n
  return {
    errori: [...gruppi.values()].map(({ perClasse, ...g }) => g).sort(ordina).slice(0, max),
    rotte: [...rotte.entries()].map(([rotta, n]) => ({ rotta, n })).sort(ordina).slice(0, 3),
    gruppi: [...gruppiVisti],
    ultima,
  }
}

// La finestra in cui guardare: da poco prima del primo punto che l'allarme ha valutato fino al momento
// del cambio di stato, più un minuto (l'ultima riga di un traceback arriva dopo). Senza punti, i
// quindici minuti prima. Pura.
export function finestraLog(a, { margineMs = 2 * 60_000, defaultMs = 15 * 60_000 } = {}) {
  const fine = Date.parse(a?.quando) || Date.now()
  const periodo = (a?.metriche?.[0]?.periodo ?? 60) * 1000
  const inizio = a?.valutati?.length ? Math.min(...a.valutati) - margineMs : fine - defaultMs
  return { da: Math.min(inizio, fine - periodo), a: fine + 60_000 }
}

// La risorsa a cui l'allarme appartiene, come configurazione `aws` di Dadaguard: il servizio che la card
// già gli attribuisce (per dimensione o per nome), sennò la Lambda o il servizio ECS nelle dimensioni.
// `null` se l'allarme non ne nomina una. Pura.
export function servizioDi(a, servizi = []) {
  const m = a.metriche?.[0]
  const finto = { AlarmName: a.nome, Dimensions: Object.entries(m?.dimensioni ?? {}).map(([Name, Value]) => ({ Name, Value })) }
  const nomi = (s) => [s?.aws?.function, s?.aws?.taskDefinition, s?.aws?.service, s?.name].filter(Boolean).map(String)
  const candidato =
    servizi.find((s) => s?.aws && alarmDelServizio(finto, s.aws)) ??
    servizi
      .filter((s) => nomi(s).some((n) => n.length > 3 && a.nome.startsWith(`${n}-`)))
      .sort((x, y) => Math.max(...nomi(y).map((n) => n.length)) - Math.max(...nomi(x).map((n) => n.length)))[0]
  const dim = m?.dimensioni ?? {}
  const cfg = candidato?.aws ?? (dim.FunctionName ? { type: 'lambda', function: dim.FunctionName } : dim.ClusterName && dim.ServiceName ? { type: 'ecs', cluster: dim.ClusterName, service: dim.ServiceName } : null)
  return cfg
}

// Il log group di un allarme, dedotto da quello che l'allarme già dice (nessun tag da scrivere a mano):
//   1. una metrica nata da un METRIC FILTER → il suo log group, e il pattern del filtro: le righe che
//      hanno acceso l'allarme sono esattamente quelle. Una metrica può nascere da più filtri su più log
//      group (lo stesso segnale da un'API e dal suo scheduler): si leggono TUTTI, sennò il messaggio
//      guarda nel gruppo sbagliato e dice «nessuna riga» mentre le righe stanno nell'altro
//   2. il servizio di Dadaguard a cui l'allarme appartiene (per dimensione, come fa la card) → il log
//      group che il pannello dei log già usa
//   3. una Lambda o un servizio ECS nominati nelle dimensioni, anche se Dadaguard non li conosce
//   4. il servizio di Dadaguard il cui nome di risorsa apre il nome dell'allarme (un cron, i cui allarmi
//      si chiamano `<funzione>-<verifica>`)
// `null` se nessuna di queste strade porta a un log group. Con più gruppi, `logGroups` li porta tutti e
// `pattern` diventa la lista dei pattern (o `null` se uno dei filtri prende tutto).
export async function logGroupDi(a, { aws, servizi = [], deps = {} } = {}) {
  const logs = deps.logs ?? new CloudWatchLogsClient(clientOpts(aws))
  const risolvi = deps.resolveLogGroup ?? resolveLogGroup
  const m = a.metriche?.[0]
  const dim = m?.dimensioni ?? {}
  if (m?.nome && m?.namespace && !m.namespace.startsWith('AWS/')) {
    try {
      const filtri = (await logs.send(new DescribeMetricFiltersCommand({ metricName: m.nome, metricNamespace: m.namespace }))).metricFilters ?? []
      const gruppi = [...new Set(filtri.map((f) => f.logGroupName).filter(Boolean))]
      const pattern = [...new Set(filtri.map((f) => f.filterPattern || null))]
      if (gruppi.length === 1 && pattern.length === 1) return { logGroup: gruppi[0], pattern: pattern[0] }
      if (gruppi.length) return { logGroup: gruppi[0], logGroups: gruppi, pattern: pattern.includes(null) ? null : pattern }
    } catch (err) {
      log.warn('allarmi: metric filter non letto', { allarme: a.nome, err: err.message })
    }
  }
  const cfg = servizioDi(a, servizi)
  if (cfg) {
    try {
      const r = await risolvi({ aws: cfg }, aws)
      if (r?.logGroup) return { logGroup: r.logGroup, pattern: null }
    } catch (err) {
      log.warn('allarmi: log group non risolto', { allarme: a.nome, err: err.message })
    }
  }
  // Le istanze RDS che esportano i log di Postgres.
  if (dim.DBInstanceIdentifier) {
    const nome = `/aws/rds/instance/${dim.DBInstanceIdentifier}/postgresql`
    try {
      const g = (await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: nome, limit: 1 }))).logGroups?.[0]
      if (g?.logGroupName === nome) return { logGroup: nome, pattern: null }
    } catch {
      // nessun permesso o nessun gruppo: si va avanti senza log
    }
  }
  return null
}

// Il pattern di un metric filter → una condizione di Logs Insights. Solo le forme semplici (termini fra
// virgolette o parole, in AND); il resto (JSON, campi, `?` in OR) si lascia al filtro generico, che
// trova comunque gli errori. Pura/testabile.
export function filtroDaPattern(pattern) {
  const p = String(pattern ?? '').trim()
  if (!p || /[{}[\]?]/.test(p)) return null
  const termini = [...p.matchAll(/"([^"]+)"|(\S+)/g)].map((x) => x[1] ?? x[2]).filter((x) => x && !x.startsWith('-'))
  if (!termini.length) return null
  return termini.map((x) => `@message like ${JSON.stringify(x)}`).join(' and ')
}

const TETTO_QUERY_MS = 20_000

// Le righe della finestra, con UNA query Logs Insights (non FilterLogEvents: su un servizio che scrive
// migliaia di righe al minuto le pagine finiscono prima della finestra). Best-effort: una query che non
// finisce in tempo si ferma, e il messaggio parte senza log.
export async function leggiRighe({ logGroup, logGroups, pattern }, { da, a }, { aws, deps = {} } = {}) {
  const logs = deps.logs ?? new CloudWatchLogsClient(clientOpts(aws))
  const dormi = deps.dormi ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  // Più filtri (uno per log group) → le loro condizioni in OR; se uno non si traduce, il filtro generico.
  const filtri = [].concat(pattern ?? []).map(filtroDaPattern)
  const filtro =
    filtri.length && filtri.every(Boolean)
      ? filtri.length === 1
        ? filtri[0]
        : filtri.map((f) => `(${f})`).join(' or ')
      : `@message like /${RE_RIGHE}/ or @message like /" 5\\d\\d /`
  // Il contorno dei traceback fuori già dalla query: sennò occupa le 300 righe e le 5xx restano fuori.
  const contorno = String.raw`@message not like /^(\s{4}|\s*(Traceback \(most recent|File ".*", line \d|The above exception|During handling of the above|\(Background on this error at))/`
  const query = `fields @timestamp, @message, @logStream, @log | filter ${filtro} | filter ${contorno} | sort @timestamp desc | limit 300`
  const { queryId } = await logs.send(
    new StartQueryCommand({ logGroupNames: logGroups ?? [logGroup], startTime: Math.floor(da / 1000), endTime: Math.ceil(a / 1000), queryString: query }),
  )
  const scade = Date.now() + TETTO_QUERY_MS
  while (Date.now() < scade) {
    await dormi(1000)
    const r = await logs.send(new GetQueryResultsCommand({ queryId }))
    if (r.status === 'Complete') {
      const campo = (riga, nome) => riga.find((c) => c.field === nome)?.value ?? null
      // `@timestamp` arriva come `2026-03-10 09:05:09.787`, in UTC ma senza la zona.
      const quando = (v) => (v ? Date.parse(`${v.replace(' ', 'T')}Z`) : NaN)
      // `@log` arriva come `<account>:<log group>`.
      const gruppo = (v) => (v ? v.slice(v.indexOf(':') + 1) : null)
      return (r.results ?? []).map((riga) => ({
        message: campo(riga, '@message'),
        stream: campo(riga, '@logStream'),
        gruppo: gruppo(campo(riga, '@log')),
        quando: quando(campo(riga, '@timestamp')),
      }))
    }
    if (['Failed', 'Cancelled', 'Timeout'].includes(r.status)) throw new Error(`query ${r.status}`)
  }
  await logs.send(new StopQueryCommand({ queryId })).catch(() => {})
  throw new Error('query oltre il tempo')
}

// Una riga di uno stack Python: `File "<file>", line <n>, in <funzione>`.
const RE_FRAME = /^\s*File "([^"]+)", line (\d+), in (\S+)/
// I frame che non sono codice del servizio: librerie installate, la libreria standard, il codice che
// l'interprete compila al volo (`<string>`, `<frozen …>`).
const RE_NON_NOSTRO = /\/(site-packages|dist-packages)\/|\/lib\/python\d|^</

// Il frame più interno che appartiene al codice del servizio, fra le righe di uno stack in ordine.
// `{ file, riga, funzione }` o `null`. Pura/testabile.
export function ultimoFrame(righe = []) {
  let ultimo = null
  for (const r of righe) {
    const m = RE_FRAME.exec(String(r ?? ''))
    if (m && !RE_NON_NOSTRO.test(m[1])) ultimo = { file: m[1], riga: Number(m[2]), funzione: m[3] }
  }
  return ultimo
}

// DOVE nel codice è nata la prima riga del riassunto: lo stack che il processo ha scritto nello stesso
// istante (un traceback, o lo stack che un watchdog stampa quando un event loop è fermo). La query
// principale lascia fuori quelle righe apposta, quindi si rileggono qui, sul solo stream e su un secondo.
// Con FilterLogEvents e non Logs Insights: a parità di millisecondo Insights non tiene l'ordine delle
// righe, e senza ordine non si sa quale frame è il più interno. Best-effort: `null` se non si legge.
export async function puntoNelCodice(g, { aws, deps = {} } = {}) {
  if (!g?.gruppo || !g?.stream || !Number.isFinite(g?.quando)) return null
  const logs = deps.logs ?? new CloudWatchLogsClient(clientOpts(aws))
  const r = await logs.send(
    new FilterLogEventsCommand({ logGroupName: g.gruppo, logStreamNames: [g.stream], startTime: g.quando, endTime: g.quando + 1000, limit: 500 }),
  )
  return ultimoFrame((r.events ?? []).map((e) => e.message))
}

const ora = (ms) => new Date(ms).toISOString().slice(11, 16)
// Lo stream di un task ECS finisce con l'id del task: le prime sei cifre bastano a distinguerne due.
const replica = (stream) => (stream ? String(stream).split('/').pop().slice(0, 6) : null)
// Un file del frame con le ultime tre parti del percorso: abbastanza per trovarlo, senza la radice
// del container.
const corto = (file) => String(file).split('/').slice(-3).join('/')

export function linkInsights(regione, logGroup, { da, a }) {
  const gruppi = [].concat(logGroup ?? []).filter(Boolean)
  if (!regione || !gruppi.length) return null
  const g = gruppi.map((x) => `~'${encodeURIComponent(x).replace(/%/g, '$25')}`).join('')
  return `https://${regione}.console.aws.amazon.com/cloudwatch/home?region=${regione}#logsV2:logs-insights$3FqueryDetail$3D~(end~'${new Date(a).toISOString()}~start~'${new Date(da).toISOString()}~timeType~'ABSOLUTE~source~(${g}))`
}

// Il testo del thread: da dove, che ore, e i gruppi di righe. `logGroup` può essere una lista: la
// testata nomina i gruppi in cui le righe ci sono (tutti, se non ce n'è nessuna), il link li apre tutti.
// `punto` è il frame di `puntoNelCodice`, sotto la prima riga. Pura/testabile.
export function testoLog({ logGroup, finestra, riassunto, regione, t = (k) => k, errore = null, punto = null }) {
  const letti = riassunto?.gruppi?.length ? riassunto.gruppi : [].concat(logGroup)
  const testa = t('allarmi.log.testa', { gruppo: letti.join('`, `'), da: ora(finestra.da), a: ora(finestra.a) })
  const link = linkInsights(regione, logGroup, finestra)
  const coda = link ? `\n<${link}|${t('allarmi.log.apri')}>` : ''
  if (errore) return `${testa}\n${t('allarmi.log.errore', { errore })}${coda}`
  // Prima le rotte in 5xx: per un allarme sulle risposte sono la risposta, e gli errori dicono perché.
  const errori = riassunto.errori.map((g) => `• ${g.n}× \`${g.esempio.replace(/`/g, "'")}\`${replica(g.stream) ? ` (${replica(g.stream)})` : ''}`)
  if (errori.length && punto) errori[0] += `\n   ↳ ${t('allarmi.log.punto')} \`${punto.funzione}\` (${corto(punto.file)}:${punto.riga})`
  const righe = [...riassunto.rotte.map((r) => `• ${r.n}× ${t('allarmi.log.rotta')} \`${r.rotta}\``), ...errori]
  if (!righe.length) return `${testa}\n${t('allarmi.log.niente')}${coda}`
  return `${testa}\n${righe.join('\n')}${coda}`
}

// ── Il contesto ────────────────────────────────────────────────────────────────────────────────────

// Tre righe sotto il titolo, perché le prime tre domande davanti a un allarme sono sempre le stesse: è
// ancora in corso? è tanto rispetto al solito? è uscito un rilascio poco prima? Rispondere a mano
// vuol dire una query per domanda. Ognuna è best-effort: se non si legge, la riga non c'è e il
// messaggio parte lo stesso.

const DAY_MS = 86_400_000

const HOUR_MS = 3_600_000

// Il ritmo della metrica dell'allarme: il totale delle ultime 24 ore e la media delle sette finestre di
// 24 ore prima. Finestre della stessa lunghezza: un «oggi» da mezzanotte, la mattina, avrebbe contato
// poche ore contro giorni interi e fatto sembrare normale un picco. Solo per le metriche che si
// contano (`Sum`, `SampleCount`): una media di medie o di massimi non dice niente. `null` se non si
// conta o non si legge.
export async function ritmoMetrica(a, { cw, ora = Date.now() } = {}) {
  const m = a.metriche?.[0]
  if (!m?.namespace || !m?.nome || !['Sum', 'SampleCount'].includes(m.stat)) return null
  // Punti orari allineati all'ora: la fine è l'ora in corso compresa, così le finestre si tagliano
  // sui bordi dei punti.
  const fine = Math.floor(ora / HOUR_MS) * HOUR_MS + HOUR_MS
  const r = await cw.send(
    new GetMetricDataCommand({
      StartTime: new Date(fine - 8 * DAY_MS),
      EndTime: new Date(fine),
      MetricDataQueries: [
        {
          Id: 'm',
          MetricStat: {
            Metric: { Namespace: m.namespace, MetricName: m.nome, Dimensions: Object.entries(m.dimensioni ?? {}).map(([Name, Value]) => ({ Name, Value })) },
            Period: 3_600,
            Stat: m.stat,
          },
        },
      ],
    }),
  )
  return ritmoDaSerie(r.MetricDataResults?.[0], fine)
}

// La serie oraria → `{ ultime, media }`: la somma delle 24 ore prima di `fine` e la media delle sette
// finestre di 24 ore precedenti. Un'ora senza punti vale zero: per una metrica che conta errori,
// nessun punto vuol dire nessun errore. Pura/testabile.
export function ritmoDaSerie(serie, fine) {
  const finestre = new Array(8).fill(0)
  ;(serie?.Timestamps ?? []).forEach((ts, i) => {
    const k = Math.floor((fine - 1 - new Date(ts).getTime()) / DAY_MS)
    if (k >= 0 && k < 8) finestre[k] += serie.Values[i] ?? 0
  })
  const somma = finestre.slice(1).reduce((x, y) => x + y, 0)
  return { ultime: Math.round(finestre[0]), media: Math.round((somma / 7) * 10) / 10 }
}

// L'ultimo rilascio del servizio ECS a cui l'allarme appartiene: il deployment più recente. `null` se
// l'allarme non è di un servizio ECS.
export async function ultimoRilascio(a, { aws, servizi = [], deps = {} } = {}) {
  const cfg = servizioDi(a, servizi)
  if (cfg?.type !== 'ecs' || !cfg.cluster || !cfg.service) return null
  const ecs = deps.ecs ?? new ECSClient(clientOpts(aws))
  const svc = (await ecs.send(new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }))).services?.[0]
  const quando = Math.max(...(svc?.deployments ?? []).map((d) => new Date(d.createdAt).getTime()).filter(Number.isFinite))
  return Number.isFinite(quando) ? { servizio: cfg.service, quando } : null
}

// Una durata leggibile: `40 min`, `15h`, `3d`. Pura.
export function durata(ms) {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 120) return `${min} min`
  const ore = Math.round(min / 60)
  return ore < 48 ? `${ore}h` : `${Math.round(ore / 24)}d`
}

// Le righe del contesto, nell'ordine delle domande. Pura/testabile.
export function testoContesto({ ultima = null, ritmo = null, rilascio = null, quando, t = (k) => k }) {
  const allarme = Date.parse(quando) || Date.now()
  // L'ultimo errore e il ritmo stanno su una riga sola: sono due numeri sulla stessa cosa.
  const errori = []
  if (Number.isFinite(ultima)) {
    const prima = allarme - ultima
    errori.push(prima <= 90_000 ? t('allarmi.ctx.ultimaOra', { ora: ora(ultima) }) : t('allarmi.ctx.ultima', { ora: ora(ultima), quanto: durata(prima) }))
  }
  if (ritmo) errori.push(t('allarmi.ctx.ritmo', { ultime: ritmo.ultime, media: ritmo.media }))
  const unita = errori.join(' · ')
  const righe = unita ? [unita[0].toUpperCase() + unita.slice(1)] : []
  if (rilascio) {
    const giorno = new Date(rilascio.quando).toISOString()
    righe.push(t('allarmi.ctx.rilascio', { servizio: rilascio.servizio, quanto: durata(allarme - rilascio.quando), quando: `${giorno.slice(8, 10)}/${giorno.slice(5, 7)} ${ora(rilascio.quando)}` }))
  }
  return righe
}

// ── Il giro di un messaggio ────────────────────────────────────────────────────────────────────────

// L'account di Dadaguard che corrisponde all'id dell'evento: chiave (per l'etichetta) e credenziali.
export function contoDaId(accounts = {}, id) {
  for (const [chiave, a] of Object.entries(accounts ?? {})) {
    if (String(a?.accountId ?? '') === String(id) || String(a?.roleArn ?? '').includes(`::${id}:`)) return { chiave, a }
  }
  return null
}

// L'ambiente per l'etichetta `[PROD]`: dalla chiave dell'account (`acme-production` dalla scoperta org,
// o `production` scritto in config), sennò dal nome dell'allarme. Pura.
export function etichettaAmbiente(chiave, nome) {
  const m = /(production|prod|prd|staging|stg|stage)/i.exec(chiave ?? '') ?? /^(?:[a-z0-9]+-)?(production|prod|prd|staging|stg|stage)-/i.exec(nome ?? '')
  return m ? m[1] : chiave
}

// Un allarme dall'inizio alla fine: decide se dirlo, a chi, scrive la riga e, se è acceso, il thread
// coi log. Restituisce `true` se il messaggio è stato detto (o non andava detto) e la coda può
// cancellarlo, `false` per riprovare. `deps` per le prove.
export async function gestisci(a, cfg, deps = {}) {
  const t = makeT(cfg.lang)
  const servizi = deps.servizi ?? (await resolveServices().catch(() => ({ accounts: {}, services: [] })))
  const conto = contoDaId(servizi.accounts, a.conto)
  const aws = conto ? { profile: conto.a.profile, roleArn: conto.a.roleArn, externalId: conto.a.externalId, region: a.regione || conto.a.region } : { region: a.regione }
  const cw = deps.cw ?? new CloudWatchClient(clientOpts(aws))

  let tag = {}
  if (a.arn) {
    try {
      tag = Object.fromEntries(((await cw.send(new ListTagsForResourceCommand({ ResourceARN: a.arn }))).Tags ?? []).map((x) => [x.Key, x.Value]))
    } catch (err) {
      log.warn('allarmi: tag non letti', { allarme: a.nome, err: err.message })
    }
  }

  // EventBridge manda il cambio di stato anche degli allarmi ZITTITI: notifiche spente apposta
  // (`ActionsEnabled` falso, un job in prova) o nessuna azione e nessun tag `team`. Chi li ha zittiti ha
  // deciso che non parlano, e Dadaguard non li fa parlare. Se non si riesce a leggere l'allarme si dice
  // lo stesso: un allarme vero taciuto per un errore di lettura è peggio di uno di troppo.
  try {
    const conf = (await cw.send(new DescribeAlarmsCommand({ AlarmNames: [a.nome], AlarmTypes: ['MetricAlarm', 'CompositeAlarm'] })))
    const x = conf.MetricAlarms?.[0] ?? conf.CompositeAlarms?.[0]
    if (x && zittito(x, tag)) {
      log.info('allarmi: zittito da chi l ha creato, non si dice', { allarme: a.nome })
      return true
    }
  } catch (err) {
    log.warn('allarmi: configurazione non letta', { allarme: a.nome, err: err.message })
  }
  let storia = null
  if (a.stato === 'OK') {
    try {
      const voci = (await cw.send(new DescribeAlarmHistoryCommand({ AlarmName: a.nome, HistoryItemType: 'StateUpdate', ScanBy: 'TimestampDescending', MaxRecords: 20 })))
        .AlarmHistoryItems
      storia = letturaStoria(voci)
    } catch (err) {
      // Senza storia un rientro vero si dice lo stesso: tacerlo per un errore di lettura è peggio di
      // un ✅ di troppo.
      log.warn('allarmi: storia non letta', { allarme: a.nome, err: err.message })
      storia = { primaDelBuco: 'ALARM', allarmeNatoSenzaDati: false }
    }
  }
  const decisione = decidi(a, { storia, severita: tag.severity })
  if (!decisione) {
    log.info('allarmi: cambio di stato taciuto', { allarme: a.nome, da: a.prima, a: a.stato })
    return true
  }

  const squadra = String(tag.team ?? '').toLowerCase() || squadraDiRegole(regoleSquadre(cfg.squadre), [], [stripOrgEnv(a.nome)])
  const dove = squadra === 'data' && cfg.canaleData && cfg.botToken ? { canale: cfg.canaleData } : cfg.canale && cfg.botToken ? { canale: cfg.canale } : cfg.webhook ? { webhook: cfg.webhook } : null
  if (!dove) {
    log.warn('allarmi: nessuna destinazione configurata', { allarme: a.nome })
    return true
  }
  const testo = testoAllarme(a, decisione, { ambiente: etichettaAmbiente(conto?.chiave, a.nome), t, url: cfg.publicUrl })

  // I log e il contesto solo su un allarme acceso: su un rientro o un buco di dati non c'è niente da cercare.
  let thread = null
  let ultima = null
  if (decisione.tipo === 'acceso') {
    try {
      const gruppo = await (deps.logGroupDi ?? logGroupDi)(a, { aws, servizi: servizi.services ?? [] })
      if (gruppo) {
        const finestra = finestraLog(a)
        try {
          const righe = await (deps.leggiRighe ?? leggiRighe)(gruppo, finestra, { aws })
          const riassunto = riassumiRighe(righe)
          ultima = riassunto.ultima
          const punto = await (deps.puntoNelCodice ?? puntoNelCodice)(riassunto.errori[0], { aws }).catch(
            (err) => (log.warn('allarmi: stack non letto', { allarme: a.nome, err: err.message }), null),
          )
          thread = testoLog({ logGroup: gruppo.logGroups ?? gruppo.logGroup, finestra, riassunto, regione: a.regione, t, punto })
        } catch (err) {
          thread = testoLog({ logGroup: gruppo.logGroups ?? gruppo.logGroup, finestra, riassunto: null, regione: a.regione, t, errore: err.message })
        }
      }
    } catch (err) {
      log.warn('allarmi: log non letti', { allarme: a.nome, err: err.message })
    }
  }
  let testoIntero = testo
  if (decisione.tipo === 'acceso') {
    const [ritmo, rilascio] = await Promise.all([
      (deps.ritmoMetrica ?? ritmoMetrica)(a, { cw }).catch((err) => (log.warn('allarmi: ritmo non letto', { allarme: a.nome, err: err.message }), null)),
      (deps.ultimoRilascio ?? ultimoRilascio)(a, { aws, servizi: servizi.services ?? [] }).catch((err) => (log.warn('allarmi: rilascio non letto', { allarme: a.nome, err: err.message }), null)),
    ])
    const contesto = testoContesto({ ultima, ritmo, rilascio, quando: a.quando, t })
    if (contesto.length) testoIntero = `${testo}\n${contesto.join('\n')}`
  }

  const inviaBot = deps.chiamaSlack ?? chiamaSlack
  const inviaHook = deps.postSlack ?? postSlack
  if (dove.canale) {
    try {
      const r = await inviaBot('chat.postMessage', { channel: dove.canale, text: testoIntero, unfurl_links: false }, cfg.botToken)
      if (thread) await inviaBot('chat.postMessage', { channel: dove.canale, thread_ts: r.ts, text: thread, unfurl_links: false }, cfg.botToken).catch((err) => log.warn('allarmi: thread non scritto', { allarme: a.nome, err: err.message }))
      log.info('allarmi: detto', { allarme: a.nome, stato: a.stato, canale: dove.canale, log: Boolean(thread) })
      return true
    } catch (err) {
      log.error('allarmi: invio col bot fallito', { allarme: a.nome, err: err.message })
      if (!cfg.webhook) return false
    }
  }
  // Senza thread i log vanno in coda al messaggio, a capo.
  const ok = await inviaHook(cfg.webhook, { text: thread ? `${testoIntero}\n${thread}` : testoIntero })
  log.info('allarmi: detto col webhook', { allarme: a.nome, stato: a.stato, inviato: ok })
  return ok
}

// Il lettore della coda, come quello degli eventi del quadro: attesa lunga, e cancellati solo i
// messaggi detti (o da non dire). Uno che non è partito torna dopo la visibilità e si riprova: un
// allarme perso è peggio di uno detto con un minuto di ritardo. I doppioni (SQS standard ne consegna,
// raramente) si riconoscono dall'id dell'evento.
export function ascoltaAllarmi(cfg, deps = {}) {
  const client = deps.client ?? new SQSClient(clientOpts({ region: regioneDaUrl(cfg.coda) }))
  const dormi = deps.dormi ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()))
  const visti = new Map() // id evento → quando
  let attivo = true
  let erroreDetto = null
  ;(async () => {
    log.info('allarmi: ascolto attivo', { coda: cfg.coda.split('/').pop() })
    while (attivo) {
      try {
        const r = await client.send(new ReceiveMessageCommand({ QueueUrl: cfg.coda, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: VISIBILITA_S }))
        const fatti = []
        for (const m of r.Messages ?? []) {
          const a = normalizzaAllarme(m.Body)
          let ok = true
          if (a && !(a.id && visti.has(a.id))) {
            ok = await (deps.gestisci ?? gestisci)(a, cfg).catch((err) => (log.error('allarmi: gestione fallita', { allarme: a.nome, err: err.message }), false))
            if (ok && a.id) visti.set(a.id, Date.now())
          }
          if (ok) fatti.push(m)
        }
        if (fatti.length) await client.send(new DeleteMessageBatchCommand({ QueueUrl: cfg.coda, Entries: fatti.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })) }))
        for (const [id, quando] of visti) if (Date.now() - quando > 3_600_000) visti.delete(id)
        if (erroreDetto) log.info('allarmi: coda di nuovo leggibile')
        erroreDetto = null
        if (deps.unGiro) attivo = false
      } catch (err) {
        if (erroreDetto !== err.message) log.warn('allarmi: coda non letta', { err: err.message })
        erroreDetto = err.message
        if (deps.unGiro) attivo = false
        else await dormi(30_000)
      }
    }
  })()
  return {
    ferma() {
      attivo = false
    },
  }
}

export function startAllarmi(env = process.env) {
  const cfg = allarmiConfig(env)
  if (!cfg.coda) {
    log.info('allarmi: nessuna DADAGUARD_ALLARMI_CODA, allarmi CloudWatch non detti da qui')
    return null
  }
  if (!(cfg.canale && cfg.botToken) && !cfg.webhook) {
    log.warn('allarmi: coda configurata ma nessuna destinazione (DADAGUARD_ALLARMI_CANALE + bot, o DADAGUARD_SLACK_WEBHOOK)')
    return null
  }
  return ascoltaAllarmi(cfg)
}
