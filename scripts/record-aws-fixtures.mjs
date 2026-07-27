// Registratore di FIXTURE DI CONTRATTO: cattura le risposte VERE di AWS e le salva in
// test/fixtures/aws/, sanificate, per rigiocarle nei test senza rete e senza credenziali.
//
// Perché esiste: i test normali provano la nostra logica su dati che abbiamo scritto noi, e quindi
// non trovano i bug che vivono nell'INCONTRO con AWS. I tre guasti del 27/07/2026 stavano tutti lì:
//   1. FilterLogEvents restituisce una pagina VUOTA con un nextToken pur essendoci i match
//      → un cron fallito veniva mostrato verde;
//   2. GetSchedule dichiara ScheduleExpressionTimezone (Europe/Rome) che non leggevamo
//      → cron sani dati per fermi, e "prossima esecuzione" sbagliata di due ore;
//   3. il tag immagine di una task-def e' lo sha del commit, 40 cifre senza spazi
//      → il testo sfondava la card.
// Registrata una volta, la forma vera entra nel repo: quei bug non possono tornare in silenzio.
//
// Uso (SOLA LETTURA). Le credenziali arrivano dall'ambiente, così funziona con SSO, con un profilo
// classico o col proxy Teleport — chi le esporta decide come sono ottenute:
//   eval "$(aws configure export-credentials --profile production-ro --format env)"
//   node scripts/record-aws-fixtures.mjs --region eu-central-1 \
//        --log-group /ecs/cato-production/cron-refresh-bi-mvs \
//        --task-def cato-production-cron-refresh-bi-mvs \
//        --schedule-group cato-production-cron --schedule cato-production-scrape-volume-monitor \
//        --function cato-production-cron-scrape-volume-monitor
//
// ATTENZIONE, RI-REGISTRANDO: una fixture può restare valida e perdere il suo SENSO. La pagina vuota
// di FilterLogEvents dipende da come AWS alloca lo scan in quel momento: con la stessa finestra, a
// distanza di ore, la prima pagina può tornare piena — e il test di contratto continuerebbe a passare
// senza provare più niente. Per questo `test/fixtures-sanitized.test.js` PRETENDE le forme che sono il
// motivo delle fixture: se una ri-registrazione le perde, i test cadono a voce alta. In quel caso non
// si allenta il test: si ripristina la registrazione buona (è in git) o si trova una finestra che
// riproduce la forma.
//
// SANIFICAZIONE: le fixture finiscono in un repo PUBBLICO. Prima di scrivere, ogni payload passa da
// `sanitize()`: id account, ARN, nomi di risorsa e token diventano segnaposto stabili. Cio' che si
// conserva e' la FORMA (campi, tipi, presenza/assenza, paginazione) — l'unica cosa che serve al test.
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CloudWatchLogsClient, FilterLogEventsCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { ECSClient, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs'
import { SchedulerClient, GetScheduleCommand } from '@aws-sdk/client-scheduler'
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}
const OUT = 'test/fixtures/aws'
const region = arg('region', 'eu-central-1')
// Nessun `credentials`: catena di default dell'SDK (env → profilo → ruolo). Il registratore non
// decide COME ci si autentica, e non gli serve saperlo.
const opts = { region }

// --- sanificazione: la forma resta, l'identita' va via ---------------------------------------------
const RE = [
  [/\b\d{12}\b/g, '111122223333'], // account id
  [/\/cato\//g, '/acme/'], // path SSM/param: /cato/<env>/...
  [/AWSReservedSSO_[^/"\s]+\/[^/"\s]+/g, 'AWSReservedSSO_Ruolo_0000/persona'], // sessione SSO = una PERSONA
  [/\/ecs\/[^"\s]+/g, '/ecs/acme-production/cron-example'], // log group
  [/[0-9a-f]{32}/g, 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebf'], // task id / uuid compatti
  [/cato-production/g, 'acme-production'],
  [/cato-staging/g, 'acme-staging'],
  [/cato-/g, 'acme-'],
  [/get-cato\.com/g, 'example.com'],
  [/refresh-bi-mvs/g, 'cron-example'],
  [/scrape-volume-monitor/g, 'cron-weekday'],
]
// Campi che contengono IDENTITÀ o SEGRETI: non si prova a ripulirli con una regex, si sostituiscono
// interi. La forma (il campo c'è, è una stringa) è tutto ciò che serve al test.
const CAMPI_DA_SOSTITUIRE = {
  registeredBy: 'arn:aws:sts::111122223333:assumed-role/Ruolo/persona',
  deployedBy: 'persona@example.com',
  valueFrom: 'arn:aws:ssm:eu-central-1:111122223333:parameter/acme/esempio',
}

function sanitize(value, chiave = null) {
  if (chiave && chiave in CAMPI_DA_SOSTITUIRE) return CAMPI_DA_SOSTITUIRE[chiave]
  // I Date dell'SDK vanno serializzati come ISO: senza questo diventano `{}` (nessuna chiave
  // enumerabile) e la fixture perde proprio i timestamp, che sono metà della forma.
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return RE.reduce((s, [re, to]) => s.replace(re, to), value)
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    // `{name, value}` di una env var: il nome descrive la forma, il valore può essere qualunque cosa
    if (typeof value.name === 'string' && 'value' in value && Object.keys(value).length === 2) {
      return { name: sanitize(value.name), value: 'VALORE-SANIFICATO' }
    }
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'nextToken' || k === 'NextToken') {
        out[k] = v ? 'TOKEN-PAGINA-SUCCESSIVA' : v // il VALORE non conta, la presenza si'
        continue
      }
      if (k === '$metadata') continue // rumore SDK
      out[k] = sanitize(v, k)
    }
    return out
  }
  return value
}

async function salva(nome, payload, note, richiesta = null) {
  await mkdir(OUT, { recursive: true })
  // `_richiesta`: i parametri con cui la risposta è stata ottenuta. Una risposta senza la sua domanda
  // non è un contratto — il periodo di aggregazione, per esempio, spiega perché i timestamp sono
  // inizi di secchio e non istanti di esecuzione.
  const body = {
    _nota: note,
    _registrato: 'una volta, con scripts/record-aws-fixtures.mjs (sanificato)',
    ...(richiesta ? { _richiesta: sanitize(richiesta) } : {}),
    payload: sanitize(payload),
  }
  await writeFile(join(OUT, `${nome}.json`), JSON.stringify(body, null, 2) + '\n', 'utf8')
  console.log(`✓ ${OUT}/${nome}.json`)
}

const logGroup = arg('log-group')
const taskDef = arg('task-def')
const schedGroup = arg('schedule-group')
const schedName = arg('schedule')
const fn = arg('function')
const windowMin = Number(arg('window-min', '2880')) // 48h: abbastanza per contenere l'errore da cercare
const startTime = Date.now() - windowMin * 60 * 1000

if (logGroup) {
  const logs = new CloudWatchLogsClient(opts)
  // (1) LA pagina vuota con nextToken: il caso che faceva passare per verde un cron fallito.
  const pagina = await logs.send(
    new FilterLogEventsCommand({ logGroupName: logGroup, startTime, filterPattern: '?Traceback ?"ERROR:" ?"CRITICAL:"', limit: 1 }),
  )
  const richiestaLog = { limit: 1, filterPattern: '?Traceback ?"ERROR:" ?"CRITICAL:"', windowMinutes: windowMin }
  await salva(
    'filter-log-events-page1',
    pagina,
    'FilterLogEvents(limit:1) su tutto il log group: può tornare events:[] CON nextToken pur essendoci i match',
    richiestaLog,
  )
  if (pagina.nextToken) {
    const pagina2 = await logs.send(
      new FilterLogEventsCommand({ logGroupName: logGroup, startTime, filterPattern: '?Traceback ?"ERROR:" ?"CRITICAL:"', limit: 1, nextToken: pagina.nextToken }),
    )
    await salva(
      'filter-log-events-page2',
      pagina2,
      'la pagina successiva: qui il match c’è. Chi si ferma alla prima pagina legge "nessun errore"',
      { ...richiestaLog, nextToken: '(quello di page1)' },
    )
  }
  // (2) uno stream per esecuzione: la base di "com’è andata l’ULTIMA run"
  const streams = await logs.send(
    new DescribeLogStreamsCommand({ logGroupName: logGroup, orderBy: 'LastEventTime', descending: true, limit: 5 }),
  )
  await salva(
    'describe-log-streams',
    streams,
    'su ECS RunTask ogni esecuzione ha il suo stream; il più recente è l’ultima run',
    { orderBy: 'LastEventTime', descending: true, limit: 5 },
  )
}

if (taskDef) {
  const ecs = new ECSClient(opts)
  const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDef }))
  await salva('describe-task-definition', td, 'log group reale nel primo container + image taggata con lo sha del commit (40 cifre)')
}

if (schedGroup && schedName) {
  const sc = new SchedulerClient(opts)
  const sched = await sc.send(new GetScheduleCommand({ GroupName: schedGroup, Name: schedName }))
  await salva('get-schedule-timezone', sched, 'ScheduleExpressionTimezone: il cron NON è in UTC (qui Europe/Rome)')
}

if (fn) {
  const cw = new CloudWatchClient(opts)
  const m = await cw.send(
    new GetMetricDataCommand({
      StartTime: new Date(Date.now() - 7 * 24 * 3600 * 1000),
      EndTime: new Date(),
      ScanBy: 'TimestampAscending',
      MetricDataQueries: [
        {
          Id: 'inv',
          ReturnData: true,
          MetricStat: {
            Metric: { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: fn }] },
            // Secchi da 5 minuti, non da un'ora: con Period 3600 il timestamp restituito è l'inizio
            // del secchio (allineato alla finestra della query, non all'orologio) e la fixture perde
            // l'istante vero della run — cioè proprio il dato su cui si ragiona.
            Period: Number(arg('period', '300')),
            Stat: 'Sum',
          },
        },
      ],
    }),
  )
  await salva(
    'get-metric-data-weekday-cron',
    m,
    'invocazioni di un cron lun-ven: buchi nel fine settimana — la cadenza NON è costante. I Timestamps sono INIZI DI SECCHIO (allineati alla finestra della query), non istanti di esecuzione: la run vera cade in [t, t+periodSeconds).',
    { periodSeconds: Number(arg('period', '300')), namespace: 'AWS/Lambda', metricName: 'Invocations', stat: 'Sum' },
  )
}

console.log('\nFatto. Le fixture sono sanificate: controllale prima di committarle.')
