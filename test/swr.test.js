import { test } from 'node:test'
import assert from 'node:assert/strict'
import { swrCache } from '../server/util/swr.js'

// La cache che non fa aspettare. Il tempo è iniettato: una prova che dorme è una prova che un giorno
// diventa intermittente, e queste sono asserzioni su SOGLIE di età, cioè proprio dove servirebbe.
function conOrologio(compute, ttlMs = 1000) {
  let adesso = 0
  const cache = swrCache({ ttlMs, compute, now: () => adesso })
  return { cache, avanza: (ms) => (adesso += ms), quando: () => adesso }
}

test('swr: il primo giro si aspetta, perché una dashboard vuota sembra un guasto', async () => {
  let giri = 0
  const { cache } = conOrologio(async () => `giro-${++giri}`)
  const out = await cache.get('it')
  assert.deepEqual({ value: out.value, stale: out.stale, computed: out.computed }, { value: 'giro-1', stale: false, computed: true })
})

test('swr: dentro il TTL non ricalcola niente', async () => {
  let giri = 0
  const { cache, avanza } = conOrologio(async () => `giro-${++giri}`)
  await cache.get('it')
  avanza(999)
  const out = await cache.get('it')
  assert.equal(out.value, 'giro-1')
  assert.equal(out.computed, false)
  assert.equal(giri, 1)
})

test('swr: scaduto consegna SUBITO il vecchio e rinfresca dietro', async () => {
  let giri = 0
  let sbloccaSecondo
  const { cache, avanza } = conOrologio(async () => {
    giri += 1
    if (giri === 2) await new Promise((r) => (sbloccaSecondo = r))
    return `giro-${giri}`
  })
  await cache.get('it')
  avanza(1500)
  const out = await cache.get('it')
  // Il punto di tutto il modulo: la risposta arriva mentre il ricalcolo e ancora in volo.
  assert.equal(out.value, 'giro-1')
  assert.equal(out.stale, true)
  assert.equal(out.at, 0) // l'eta e quella del CALCOLO, non della richiesta
  assert.equal(giri, 2)
  sbloccaSecondo()
  await new Promise((r) => setImmediate(r))
  const dopo = await cache.get('it')
  assert.equal(dopo.value, 'giro-2')
  assert.equal(dopo.stale, false)
})

test('swr: due richieste insieme su un dato scaduto fanno UN ricalcolo, non due', async () => {
  let giri = 0
  let sblocca
  const { cache, avanza } = conOrologio(async () => {
    giri += 1
    if (giri > 1) await new Promise((r) => (sblocca = r))
    return `giro-${giri}`
  })
  await cache.get('it')
  avanza(2000)
  await Promise.all([cache.get('it'), cache.get('it'), cache.get('it')])
  assert.equal(giri, 2)
  sblocca()
})

test('swr: fresh aspetta il giro nuovo, perché «Aggiorna» deve dire la verita', async () => {
  let giri = 0
  const { cache } = conOrologio(async () => `giro-${++giri}`)
  await cache.get('it')
  const out = await cache.get('it', { fresh: true })
  assert.equal(out.value, 'giro-2')
  assert.equal(out.computed, true)
  assert.equal(out.stale, false)
})

// ⚠️ Un ricalcolo che fallisce non deve buttare il dato buono: sarebbe uno schianto della pagina per
// un errore transitorio di AWS, cioè il contrario del motivo per cui la cache esiste.
test('swr: se il ricalcolo dietro fallisce, il dato vecchio resta e l errore si annuncia', async () => {
  let giri = 0
  const visti = []
  let adesso = 0
  const cache = swrCache({
    ttlMs: 1000,
    now: () => adesso,
    onError: (err, key) => visti.push(`${key}:${err.message}`),
    compute: async () => {
      giri += 1
      if (giri === 2) throw new Error('AWS ha detto no')
      return `giro-${giri}`
    },
  })
  await cache.get('it')
  adesso += 1500
  const out = await cache.get('it')
  assert.equal(out.value, 'giro-1')
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(visti, ['it:AWS ha detto no'])
  // E il giro dopo RIPROVA (l'errore non e' rimasto in cache), sempre senza far aspettare: consegna
  // ancora il vecchio e rinfresca dietro, e il dato nuovo si vede alla lettura successiva.
  const ancora = await cache.get('it')
  assert.equal(ancora.value, 'giro-1')
  assert.equal(ancora.stale, true)
  await new Promise((r) => setImmediate(r))
  assert.equal((await cache.get('it')).value, 'giro-3')
})

test('swr: il primo giro che fallisce lo vede chi ha chiesto, non un dato inventato', async () => {
  const { cache } = conOrologio(async () => {
    throw new Error('AWS ha detto no')
  })
  await assert.rejects(() => cache.get('it'), /AWS ha detto no/)
})

test('swr: publish riempie la cache senza calcolare, ed e come il watchdog regala il suo giro', async () => {
  let giri = 0
  const { cache, avanza } = conOrologio(async () => `giro-${++giri}`)
  cache.publish('it', 'dal-watchdog')
  const out = await cache.get('it')
  assert.equal(out.value, 'dal-watchdog')
  assert.equal(giri, 0) // nessuno ha aspettato e nessuno ha calcolato
  avanza(500)
  assert.equal(cache.age('it'), 500)
})

test('swr: le chiavi non si mescolano (una lingua per chiave)', async () => {
  const { cache } = conOrologio(async (key) => `stato-${key}`)
  assert.equal((await cache.get('it')).value, 'stato-it')
  assert.equal((await cache.get('en')).value, 'stato-en')
})
