import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitLogLine, parseAlbLogLine, percentile, aggregateByTarget, dayPrefixes } from '../server/albLatency.js'
import { arnParts, mergeLatency } from '../server/taskMetrics.js'

// Riga reale di access log ALB (formato v2): campi separati da spazi, con i campi testuali tra
// virgolette. Il campo 5 è `target:port`, il 7 è `target_processing_time` in secondi.
const LINE =
  'https 2026-07-29T16:40:12.123456Z app/cato-staging-alb/abc123 10.0.1.10:54321 10.0.84.69:8000 0.001 0.243 0.000 200 200 512 1024 "GET https://endpoint.appaltigpt.com:443/api/tenders?q=lavori HTTP/1.1" "Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:eu-central-1:521595303218:targetgroup/cato-staging-backend/aaa "Root=1-abc-def" "endpoint.appaltigpt.com" "arn:aws:acm:eu-central-1:521595303218:certificate/xyz" 0 2026-07-29T16:40:12.100000Z "forward" "-" "-" "10.0.84.69:8000" "200" "-" "-"'

test('splitLogLine: i campi quotati con spazi non spostano gli indici', () => {
  // Uno split(' ') ingenuo spezzerebbe la request-line e lo user-agent, e da lì in poi OGNI indice
  // sarebbe sbagliato: non un errore, ma numeri plausibili e falsi.
  const f = splitLogLine(LINE)
  assert.equal(f[4], '10.0.84.69:8000')
  assert.equal(f[6], '0.243')
  assert.equal(f[12], 'GET https://endpoint.appaltigpt.com:443/api/tenders?q=lavori HTTP/1.1')
})

test('parseAlbLogLine: indirizzo del target e latenza in millisecondi', () => {
  const r = parseAlbLogLine(LINE)
  assert.equal(r.targetIp, '10.0.84.69')
  assert.equal(Math.round(r.ms), 243)
  assert.equal(r.elbStatus, '200')
  assert.equal(r.targetStatus, '200')
})

test('parseAlbLogLine: -1 NON è una latenza e va scartato', () => {
  // `target_processing_time` è -1 quando nessun target ha risposto. Trattarlo come zero abbasserebbe il
  // p50 proprio quando il servizio sta peggio — il grafico migliora mentre gli utenti prendono errori.
  const noTarget = LINE.replace(' 0.001 0.243 0.000 200 200 ', ' 0.001 -1 -1 502 - ')
  assert.equal(parseAlbLogLine(noTarget), null)
})

test('parseAlbLogLine: senza target (`-`) o riga tronca → null', () => {
  assert.equal(parseAlbLogLine(LINE.replace('10.0.84.69:8000', '-')), null)
  assert.equal(parseAlbLogLine('https 2026-07-29T16:40:12Z app/x/y'), null)
  assert.equal(parseAlbLogLine(''), null)
})

test('percentile: p50/p95/p99 su valori ordinati', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.equal(percentile(s, 50), 50)
  assert.equal(percentile(s, 95), 95)
  assert.equal(percentile(s, 99), 99)
})

test('percentile: lista vuota → null, non 0', () => {
  assert.equal(percentile([], 95), null)
})

test('aggregateByTarget: una replica lenta si distingue dalle altre', () => {
  // È il caso per cui esiste tutto questo: la media di servizio direbbe ~120ms e non indicherebbe
  // nessuno; per replica il colpevole è evidente.
  const rows = [
    ...Array.from({ length: 10 }, () => ({ targetIp: '10.0.1.1', ms: 20, targetStatus: '200' })),
    ...Array.from({ length: 10 }, () => ({ targetIp: '10.0.2.2', ms: 300, targetStatus: '200' })),
  ]
  const agg = aggregateByTarget(rows)
  assert.equal(agg['10.0.1.1'].p95, 20)
  assert.equal(agg['10.0.2.2'].p95, 300)
  assert.equal(agg['10.0.1.1'].requests, 10)
})

test('aggregateByTarget: conta i 5xx del TARGET, non quelli dell’ALB', () => {
  // Un 502 generato dall'ALB non è un errore dell'applicazione: contarlo come tale manda a cercare un
  // bug applicativo dove c'è un problema di rete o di health check.
  const agg = aggregateByTarget([
    { targetIp: '10.0.1.1', ms: 10, elbStatus: '502', targetStatus: '200' },
    { targetIp: '10.0.1.1', ms: 10, elbStatus: '500', targetStatus: '500' },
  ])
  assert.equal(agg['10.0.1.1'].errors, 1)
})

test('dayPrefixes: una finestra a cavallo della mezzanotte UTC copre due giorni', () => {
  // Guardarne uno solo darebbe "nessun dato" per qualche minuto ogni notte: un buco che si scopre tardi
  // e si scambia per un guasto.
  const base = 'AWSLogs/521595303218/elasticloadbalancing/eu-central-1/'
  const to = Date.parse('2026-07-30T00:05:00Z')
  const from = to - 15 * 60 * 1000
  assert.deepEqual(dayPrefixes(base, from, to), [`${base}2026/07/29/`, `${base}2026/07/30/`])
})

test('dayPrefixes: dentro lo stesso giorno, un prefisso solo', () => {
  const base = 'x/'
  const to = Date.parse('2026-07-29T12:00:00Z')
  assert.deepEqual(dayPrefixes(base, to - 60_000, to), ['x/2026/07/29/'])
})

test('arnParts: region e account dall’ARN del target group', () => {
  const { region, accountId } = arnParts(
    'arn:aws:elasticloadbalancing:eu-central-1:521595303218:targetgroup/cato-staging-backend/aaa',
  )
  assert.equal(region, 'eu-central-1')
  assert.equal(accountId, '521595303218')
  assert.deepEqual(arnParts(null), { region: null, accountId: null })
})

test('mergeLatency: la latenza si attacca al task per indirizzo', () => {
  const tasks = [
    { taskId: 'a', privateIp: '10.0.1.1' },
    { taskId: 'b', privateIp: '10.0.2.2' },
    { taskId: 'c', privateIp: null },
  ]
  const merged = mergeLatency(tasks, { '10.0.1.1': { p95: 20 }, '10.0.2.2': { p95: 300 } })
  assert.equal(merged[0].latency.p95, 20)
  assert.equal(merged[1].latency.p95, 300)
  assert.equal(merged[2].latency, undefined)
})

test('mergeLatency: senza sorgente i task restano intatti', () => {
  const tasks = [{ taskId: 'a', privateIp: '10.0.1.1' }]
  assert.deepEqual(mergeLatency(tasks, null), tasks)
})
