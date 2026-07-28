import { metricValues } from './cw.js'
import { identityT } from '../i18n.js'
import { fmtMs, fmtCount } from '../util/format.js'

// RuntimeProvider Amazon Bedrock. Serverless: guardiamo le metriche d'uso su una finestra (CloudWatch
// AWS/Bedrock, via il batcher condiviso): invocazioni, errori client/server, throttling, latenza.
//  - `aws: { type: bedrock, model: '<modelId>' }` (consigliato) → metriche del singolo modello.
//  - senza `model` → nessuna dimension (aggregato, se l'account pubblica metriche a quel livello).
const DEFAULT_WINDOW_MIN = 60

// Quando un errore diventa un GUASTO. Un errore isolato non è la piattaforma giù: 358 invocazioni con
// 1 errore client è rumore normale, e allarmare lì (con `<!channel>`, perché Bedrock in prod è roba
// seria) è il modo più rapido per far ignorare gli allarmi veri.
//
// Ogni segnale ha DUE condizioni, percentuale E minimo assoluto, perché una sola non basta:
// solo la percentuale fa scattare "1 errore su 2 invocazioni"; solo il minimo assoluto fa scattare
// 5 errori su un milione. L'eccezione è il 5xx (vedi sotto).
const SOGLIE = {
  // 4xx: spesso colpa del chiamante (richiesta malformata, quota, token troppo lunghi) → serve una
  // vera ondata, non il singolo caso.
  cerr: { min: 5, rate: 0.05 },
  // Throttling: non è un bug, è capacità che finisce. Più serio di un 4xx → soglia più bassa.
  thr: { min: 3, rate: 0.01 },
  // 5xx: è Bedrock che rompe, non noi. Qui basta UNA delle due condizioni (OR, non AND): due errori
  // in assoluto bastano anche su volumi alti, e su volumi bassi basta l'1%.
  serr: { min: 2, rate: 0.01 },
}

export async function bedrockRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? identityT
  // Iniettabile come `deps` in runOnce: le soglie sono la parte che si sbaglia, e va testata senza rete.
  const leggiMetriche = opts.metricValues ?? metricValues
  const windowMin = cfg.windowMinutes ?? DEFAULT_WINDOW_MIN
  const dims = cfg.model ? [{ Name: 'ModelId', Value: cfg.model }] : []
  const m = await leggiMetriche(
    aws,
    'AWS/Bedrock',
    dims,
    [
      ['inv', 'Invocations', 'Sum'],
      ['cerr', 'InvocationClientErrors', 'Sum'],
      ['serr', 'InvocationServerErrors', 'Sum'],
      ['thr', 'InvocationThrottles', 'Sum'],
      ['lat', 'InvocationLatency', 'Average'],
      ['tin', 'InputTokenCount', 'Sum'],
      ['tout', 'OutputTokenCount', 'Sum'],
    ],
    windowMin,
  )
  const winL = `${windowMin}m`
  if (!m.inv && !m.cerr && !m.serr && !m.thr) return { status: 'idle', summary: t('bedrock.idle', { window: winL }) }
  const cerr = Math.round(m.cerr)
  const serr = Math.round(m.serr)
  const throttles = Math.round(m.thr)
  const inv = Math.round(m.inv)
  // Denominatore: le invocazioni della finestra, ma mai meno del numero di errori — se CloudWatch
  // pubblica errori senza invocazioni (richieste respinte prima di contare) la percentuale resterebbe
  // divisa per zero.
  const base = (n) => Math.max(inv, n, 1)
  const oltre = (n, s) => n >= s.min && n >= s.rate * base(n)
  // 5xx: OR invece di AND, vedi SOGLIE.
  const serverGiu = serr >= SOGLIE.serr.min || serr >= SOGLIE.serr.rate * base(serr)
  const status = serverGiu || oltre(cerr, SOGLIE.cerr) || oltre(throttles, SOGLIE.thr) ? 'degraded' : 'up'
  // Stat tile strutturati (label + valore + tono di stato). Errori: client (4xx, richieste/quota) e
  // server (5xx, colpa di Bedrock) = cause diverse → tile distinti; puliti → "0" verde.
  // NB i tile mostrano gli errori anche SOTTO soglia: sulla card li vuoi vedere, è l'allarme che non
  // deve suonare. Soglia e visibilità sono due cose diverse.
  const metrics = [{ label: t('m.inv', { n: inv }), value: fmtCount(inv), spark: m.series?.inv }]
  if (serr > 0) metrics.push({ label: t('m.errServer'), value: String(serr), tone: 'critical' })
  if (cerr > 0) metrics.push({ label: t('m.errClient'), value: String(cerr), tone: 'warning' })
  if (serr === 0 && cerr === 0) metrics.push({ label: t('m.errors', { n: 0 }), value: '0', tone: 'good' })
  if (throttles > 0) metrics.push({ label: t('m.throttle'), value: String(throttles), tone: 'warning' })
  if (m.lat > 0) metrics.push({ label: t('m.latency'), value: `~${fmtMs(Math.round(m.lat))}`, kind: 'latency', ms: Math.round(m.lat), spark: m.series?.lat, sparkUnit: 'ms' })
  if (m.tin > 0 || m.tout > 0) metrics.push({ label: t('m.tokens'), value: `${fmtCount(Math.round(m.tin))} → ${fmtCount(Math.round(m.tout))}` })
  const summary = `${metrics.map((x) => `${x.value} ${x.label}`).join(' · ')} (${winL})`
  return { status, summary, metrics, window: winL, clientErrors: cerr, serverErrors: serr, throttles }
}
