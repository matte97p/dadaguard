// LATENZA PER SINGOLA REPLICA, dagli access log dell'ALB.
//
// Perché non dalle metriche: `TargetResponseTime` di CloudWatch esiste con dimension TargetGroup e
// AvailabilityZone, mai per singolo target. Su un servizio con tre task la latenza è quindi una media
// che nasconde proprio il task lento — cioè l'unica cosa che si stava cercando. Gli access log hanno
// invece una riga per richiesta, con `target:port` accanto a `target_processing_time`: aggregando per
// indirizzo si ottiene la latenza della replica.
//
// Cosa costa: elencare gli oggetti dell'ultima finestra e scaricarne pochi. Il tetto è esplicito
// (`MAX_OBJECTS`) perché un ALB carico scrive un oggetto ogni ~5 minuti PER NODO, e una finestra larga
// su un bucket vivo diventa in fretta decine di megabyte da decomprimere a ogni apertura del pannello.
//
// Il bucket NON è configurato in dadaguard: si scopre dall'ALB stesso
// (`DescribeLoadBalancerAttributes` → `access_logs.s3.*`). Una config in meno da tenere allineata, e
// nessun modo di puntare al bucket sbagliato.
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import {
  ElasticLoadBalancingV2Client,
  DescribeTargetGroupsCommand,
  DescribeLoadBalancerAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import { gunzipSync } from 'node:zlib'
import { clientOpts } from './runtime/awsClient.js'

const MAX_OBJECTS = 12 // oggetti scaricati per finestra: tetto esplicito, non "tutti quelli che ci sono"

// Spezza una riga di access log ALB rispettando i campi tra virgolette. I campi quotati contengono
// spazi (la request-line, lo user-agent), quindi uno `split(' ')` sposta tutti gli indici successivi e
// il risultato non è un errore ma numeri sbagliati: peggio di un crash, perché sembra funzionare.
export function splitLogLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (const ch of String(line ?? '')) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (ch === ' ' && !quoted) {
      if (cur !== '') out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

// Da riga a { ts, targetIp, ms, elbStatus, targetStatus } | null.
//
// `target_processing_time` vale **-1** quando nessun target ha risposto (connessione rifiutata, target
// tolto dal gruppo, timeout prima dell'inoltro): quelle righe NON sono latenze e vanno escluse, non
// convertite in zero — mediarle abbasserebbe il p50 proprio quando il servizio sta peggio.
export function parseAlbLogLine(line) {
  const f = splitLogLine(line)
  if (f.length < 10) return null
  const target = f[4]
  const ms = Number(f[6]) * 1000
  if (!target || target === '-' || !Number.isFinite(ms) || Number(f[6]) < 0) return null
  return {
    ts: Date.parse(f[1]) || null,
    targetIp: target.split(':')[0],
    ms,
    elbStatus: f[8] ?? null,
    targetStatus: f[9] ?? null,
  }
}

// Percentile su valori già ordinati. Interpolazione no: su poche richieste darebbe una precisione
// finta, e questi numeri servono a confrontare replica tra loro, non a firmare uno SLA.
export function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[i])
}

// Aggrega le righe per indirizzo del target: è la chiave con cui il pannello ritrova il task (con
// target type `ip` il load balancer conosce le replica per indirizzo, non per id).
export function aggregateByTarget(rows) {
  const byIp = new Map()
  for (const r of rows) {
    if (!r) continue
    if (!byIp.has(r.targetIp)) byIp.set(r.targetIp, { times: [], errors: 0, requests: 0 })
    const agg = byIp.get(r.targetIp)
    agg.times.push(r.ms)
    agg.requests += 1
    // 5xx del TARGET, non dell'ALB: un 502 generato dall'ALB non è un errore dell'applicazione, e
    // contarlo come tale manda a cercare un bug dove c'è un problema di rete o di health check.
    if (/^5\d\d$/.test(String(r.targetStatus))) agg.errors += 1
  }
  const out = {}
  for (const [ip, agg] of byIp) {
    const sorted = agg.times.sort((a, b) => a - b)
    out[ip] = {
      requests: agg.requests,
      errors: agg.errors,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: Math.round(sorted[sorted.length - 1]),
    }
  }
  return out
}

// I prefissi giorno da guardare per coprire la finestra. Gli oggetti stanno sotto
// `…/<yyyy>/<mm>/<dd>/`, quindi una finestra a cavallo della mezzanotte UTC tocca due giorni: guardarne
// uno solo darebbe "nessun dato" per qualche minuto ogni notte, che è il tipo di buco che si scopre
// tardi e si scambia per un guasto.
export function dayPrefixes(base, from, to) {
  const days = new Set()
  for (const ms of [from, to]) {
    const d = new Date(ms)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    days.add(`${base}${y}/${m}/${day}/`)
  }
  return [...days]
}

// Bucket/prefisso degli access log di un ALB, letti dall'ALB stesso. `null` = access log spenti, o
// permesso assente: in entrambi i casi la latenza per replica non si può dare, e non si finge.
async function accessLogConfig(elb, targetGroupArn) {
  const tg = (await elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [targetGroupArn] }))).TargetGroups?.[0]
  const lbArn = (tg?.LoadBalancerArns ?? [])[0]
  if (!lbArn) return null
  const attrs = (await elb.send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: lbArn }))).Attributes ?? []
  const get = (key) => attrs.find((a) => a.Key === key)?.Value
  if (get('access_logs.s3.enabled') !== 'true') return null
  const bucket = get('access_logs.s3.bucket')
  if (!bucket) return null
  return { bucket, prefix: get('access_logs.s3.prefix') || '', lbArn }
}

// Ritorna { byIp, objects, window } | { notApplicable } | { error }.
// `objects` = quanti oggetti sono stati letti davvero: serve a capire se un p95 poggia su tre richieste
// o su tremila, e a non far sembrare autorevole un numero che non lo è.
export async function albLatencyByTarget(
  { targetGroupArn, region, accountId },
  aws,
  { minutes = 15, now = Date.now() } = {},
) {
  if (!targetGroupArn) return { notApplicable: true }
  const elb = new ElasticLoadBalancingV2Client(clientOpts(aws))
  let cfg
  try {
    cfg = await accessLogConfig(elb, targetGroupArn)
  } catch {
    return { notApplicable: true }
  }
  if (!cfg) return { notApplicable: true }

  const from = now - Math.max(1, minutes) * 60 * 1000
  const base = `${cfg.prefix ? `${cfg.prefix}/` : ''}AWSLogs/${accountId}/elasticloadbalancing/${region}/`
  const s3 = new S3Client(clientOpts(aws))

  try {
    // Si elenca per giorno e si filtra per `LastModified`: le chiavi contengono un'ora, ma è l'ora di
    // FINE della finestra di raccolta e il formato non è affidabile da parsare per filtrare.
    const keys = []
    for (const prefix of dayPrefixes(base, from, now)) {
      let token
      do {
        const out = await s3.send(
          new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token }),
        )
        for (const o of out.Contents ?? []) {
          const at = o.LastModified ? new Date(o.LastModified).getTime() : 0
          if (at >= from) keys.push({ key: o.Key, at })
        }
        token = out.NextContinuationToken
      } while (token)
    }
    if (!keys.length) return { byIp: {}, objects: 0, window: minutes }

    // I più RECENTI, non i primi trovati: con un tetto sul numero di oggetti, prendere i primi
    // significherebbe descrivere l'inizio della finestra invece di adesso.
    const chosen = keys.sort((a, b) => b.at - a.at).slice(0, MAX_OBJECTS)
    const rows = []
    for (const { key } of chosen) {
      const obj = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }))
      const gz = Buffer.from(await obj.Body.transformToByteArray())
      const text = key.endsWith('.gz') ? gunzipSync(gz).toString('utf8') : gz.toString('utf8')
      for (const line of text.split('\n')) {
        if (!line) continue
        const row = parseAlbLogLine(line)
        if (row && (row.ts == null || row.ts >= from)) rows.push(row)
      }
    }
    return { byIp: aggregateByTarget(rows), objects: chosen.length, window: minutes, truncated: keys.length > chosen.length }
  } catch (err) {
    return { error: err.message }
  }
}
