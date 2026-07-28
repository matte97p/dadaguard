// La colonna Latenza ha due fonti possibili e non devono mescolarsi in silenzio: la metrica che il
// servizio misura di suo (CloudWatch) e il giro della sonda HTTP, che include rete e Cloudflare ed è
// più grande per costruzione. Qui si fissa la precedenza e che la fonte sia sempre dichiarata.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latencyOf, latencyMetric } from '../web/format.js'

const withMetric = (ms) => ({ checks: { runtime: { metrics: [{ kind: 'latency', ms }] } } })
const withProbe = (latencyMs) => ({ checks: { liveness: { latencyMs } } })

test('la metrica del servizio batte la sonda: la sua parola vale più della nostra', () => {
  const s = { checks: { runtime: { metrics: [{ kind: 'latency', ms: 42 }] }, liveness: { latencyMs: 179 } } }
  assert.deepEqual(latencyOf(s), { ms: 42, source: 'metric', metric: { kind: 'latency', ms: 42 } })
})

test('senza metrica si usa la sonda, DICHIARANDO che è la sonda', () => {
  assert.deepEqual(latencyOf(withProbe(179)), { ms: 179, source: 'probe' })
})

test('senza nessuna delle due: null (la colonna mostra —, non finge uno zero)', () => {
  assert.equal(latencyOf({ checks: {} }), null)
  assert.equal(latencyOf({}), null)
  assert.equal(latencyOf(undefined), null)
})

test('metrica presente ma senza numero: si scende alla sonda', () => {
  // Succede con una metrica che ha solo il testo (es. "nessun dato nella finestra"): non è un numero
  // su cui ordinare, e lasciare la colonna vuota quando la sonda ha misurato è dato perso.
  const s = { checks: { runtime: { metrics: [{ kind: 'latency' }] }, liveness: { latencyMs: 179 } } }
  assert.deepEqual(latencyOf(s), { ms: 179, source: 'probe' })
})

test('metrica senza numero e senza sonda: null, non NaN', () => {
  const s = { checks: { runtime: { metrics: [{ kind: 'latency', ms: 'lento' }] } } }
  assert.equal(latencyOf(s), null)
})

test('latencyMetric guarda `kind`, non l’unità', () => {
  const runtime = { metrics: [{ kind: 'count', ms: 5 }, { kind: 'latency', ms: 7 }] }
  assert.equal(latencyMetric(runtime)?.ms, 7)
  assert.equal(latencyMetric({ metrics: [] }), null)
  assert.equal(latencyMetric(null), null)
})

test('ordinamento: metrica e sonda finiscono sullo stesso numero confrontabile', () => {
  const rows = [withProbe(179), withMetric(42), { checks: {} }]
  const ms = (x) => latencyOf(x)?.ms
  const sorted = [...rows].sort((a, b) => {
    const va = ms(a)
    const vb = ms(b)
    if (va == null && vb == null) return 0
    if (va == null) return 1 // chi non ha latenza resta in fondo, non finge di essere 0
    if (vb == null) return -1
    return vb - va
  })
  assert.deepEqual(sorted.map(ms), [179, 42, undefined])
})
