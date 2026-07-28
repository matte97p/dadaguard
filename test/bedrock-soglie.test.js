import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bedrockRuntime } from '../server/runtime/bedrock.js'

// Le soglie di Bedrock esistono per una ragione precisa, vista dal vivo: 358 invocazioni con UN errore
// client hanno prodotto un allarme rosso con `<!channel>` in produzione. Un errore isolato non è la
// piattaforma giù, e un allarme che suona per il rumore normale insegna alla squadra a ignorarlo.

// Finta lettura CloudWatch: `bedrockRuntime` accetta `opts.metricValues`, così le soglie si provano
// senza rete (stessa convenzione dei `deps` di runOnce).
const metriche = (v) => async () => ({ inv: 0, cerr: 0, serr: 0, thr: 0, lat: 0, tin: 0, tout: 0, ...v })
const stato = async (v) => (await bedrockRuntime({ model: 'test-model' }, {}, { metricValues: metriche(v) })).status

test('il caso reale: 1 errore client su 358 invocazioni NON è un guasto', async () => {
  assert.equal(await stato({ inv: 358, cerr: 1, lat: 3700 }), 'up')
})

test('nessun traffico: idle, non guasto (nessuno ha chiamato il modello)', async () => {
  assert.equal(await stato({}), 'idle')
})

test('zero errori: up', async () => {
  assert.equal(await stato({ inv: 1000 }), 'up')
})

// --- 4xx: serve una vera ondata (>=5% E >=5) ---
test('4xx: sotto la percentuale non allarma, anche con molti errori in assoluto', async () => {
  // 10 errori sono >= 5, ma su 10000 invocazioni sono lo 0,1%: è rumore di chiamanti, non un guasto.
  assert.equal(await stato({ inv: 10000, cerr: 10 }), 'up')
})

test('4xx: sopra la percentuale ma pochissimi in assoluto non allarma', async () => {
  // 2 su 4 è il 50%, ma su 4 invocazioni non si conclude niente: senza il minimo assoluto
  // basterebbe un modello chiamato due volte per far suonare la sirena.
  assert.equal(await stato({ inv: 4, cerr: 2 }), 'up')
})

test('4xx: ondata vera (>=5% e >=5 errori) → degraded', async () => {
  assert.equal(await stato({ inv: 100, cerr: 8 }), 'degraded')
})

// --- 5xx: è Bedrock che rompe → basta UNA delle due condizioni ---
test('5xx: 2 errori server allarmano anche su volumi alti (OR, non AND)', async () => {
  assert.equal(await stato({ inv: 10000, serr: 2 }), 'degraded')
})

test('5xx: 1 solo errore server su volumi alti non allarma', async () => {
  assert.equal(await stato({ inv: 10000, serr: 1 }), 'up')
})

test('5xx: 1 errore server su volumi bassi allarma per percentuale (1 su 20 = 5%)', async () => {
  assert.equal(await stato({ inv: 20, serr: 1 }), 'degraded')
})

// --- throttling: capacità che finisce, soglia più bassa del 4xx ---
test('throttling: 3 su 100 (3%) → degraded', async () => {
  assert.equal(await stato({ inv: 100, thr: 3 }), 'degraded')
})

test('throttling: 2 su 100 resta sotto il minimo assoluto', async () => {
  assert.equal(await stato({ inv: 100, thr: 2 }), 'up')
})

// --- niente divisioni per zero ---
test('errori senza invocazioni: la percentuale non esplode', async () => {
  const s = await stato({ inv: 0, serr: 3 })
  assert.equal(s, 'degraded', 'errori senza invocazioni contano come guasto, non come NaN')
})

// --- la card mostra comunque l'errore: soglia != visibilità ---
test('sotto soglia lo stato è up MA il tile dell errore resta visibile sulla card', async () => {
  const r = await bedrockRuntime({ model: 'test-model' }, {}, { metricValues: metriche({ inv: 358, cerr: 1 }) })
  assert.equal(r.status, 'up', 'non allarma')
  assert.equal(r.clientErrors, 1, 'ma il conteggio resta esposto')
  const label = JSON.stringify(r.metrics)
  assert.ok(label.includes('errClient'), 'e il tile 4xx c-è: sulla card lo vuoi vedere')
})
