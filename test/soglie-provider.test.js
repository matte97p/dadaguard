import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lambdaRuntime } from '../server/runtime/lambda.js'
import { valutaApigw } from '../server/runtime/apigateway.js'
import { sesRuntime } from '../server/runtime/ses.js'
import { risolviProfilo } from '../server/runtime/soglie.js'
import { makeT } from '../server/i18n.js'

// I profili di `soglie.js` hanno le loro prove; questi test guardano il PUNTO DI SALDATURA fra il
// profilo e il provider, che è dove i difetti si nascondono: la config che non arriva, un
// numeratore che non appartiene al denominatore, un tile che dice una cosa e lo stato un'altra.
// Tutti e quattro sono stati trovati in review sulla PR #175, e nessuno lo vedevano i test di prima.

const t = makeT('it')
const VUOTO = { inv: 0, err: 0, thr: 0, dur: 0 }
const metriche = (m) => async () => ({ ...VUOTO, ...m })
const cron = (m, opts = {}) =>
  lambdaRuntime(
    { function: 'f', schedule: '1h', scheduleExpr: 'cron(0 * * * ? *)' },
    {},
    { metricValues: metriche(m), t, ...opts },
  )

// --- il throttle non appartiene al denominatore delle invocazioni ------------------------------
test('cron: un throttle non fa sembrare fallite le run che sono andate bene', async () => {
  // `Throttles` conta i tentativi RIFIUTATI, che in `Invocations` non compaiono: sommarli agli
  // errori faceva leggere «1 errore + 4 throttle su 5 invocazioni» come «sono fallite tutte».
  const r = await cron({ inv: 5, err: 1, thr: 4 })
  assert.equal(r.status, 'degraded', 'quattro run su cinque sono andate a buon fine: attenzione, non giù')
  assert.equal(r.outcome, 'ok')
})

test('cron: quando falliscono davvero tutte, giù e `outcome: failed`', async () => {
  const r = await cron({ inv: 3, err: 3 })
  assert.equal(r.status, 'down')
  assert.equal(r.outcome, 'failed')
})

// `outcome` non è cosmesi: ci instradano notify/route.js e slack.js, quindi un `down` con
// `outcome: 'ok'` manderebbe l'allarme al destinatario sbagliato.
test('cron: `outcome` segue lo stato, non un conto suo', async () => {
  const solo = await cron({ inv: 3, err: 1 })
  assert.equal(solo.status, 'degraded')
  assert.equal(solo.outcome, 'ok')
})

test('cron: un throttle da solo resta un allarme (una run rifiutata è una run che non è avvenuta)', async () => {
  const r = await cron({ inv: 2, err: 0, thr: 1 })
  assert.equal(r.status, 'degraded')
})

// --- gli override di config devono ARRIVARE ---------------------------------------------------
// `server/checks/runtime.js` passa già `ctx.soglie[cfg.type]`, quindi un secondo livello col nome
// del tipo dentro al provider le faceva cadere tutte in silenzio: la config documentata non aveva
// nessun effetto e niente lo diceva.
test('lambda: le soglie per TIPO arrivano al provider', async () => {
  const r = await cron({ inv: 10, err: 1 }, { soglie: { min: 5 } })
  assert.equal(r.status, 'up', 'un errore solo sta sotto al minimo dichiarato a 5')
})

test('lambda: i due rami hanno override separati, o una `rate` zittisce i cron', async () => {
  // `rate` ha senso sulle on-demand (profilo `utente`); sul cron trasformerebbe la tolleranza zero
  // in una condizione «e», cioè 3 errori su 10 run non allarmerebbero più.
  const condivisa = await cron({ inv: 10, err: 3 }, { soglie: { ondemand: { rate: 0.5 } } })
  assert.equal(condivisa.status, 'degraded', 'la taratura delle on-demand non tocca i cron')
  const suoi = await cron({ inv: 10, err: 3 }, { soglie: { cron: { min: 5 } } })
  assert.equal(suoi.status, 'up', 'e il ramo cron ha i suoi')
})

// --- API Gateway --------------------------------------------------------------------------------
test('apigateway: un 5xx isolato su una API trafficata non è più un allarme', () => {
  assert.equal(valutaApigw(1, 3000).sforo, null, 'uno su tremila è lo 0,03%')
  assert.ok(valutaApigw(30, 3000).sforo, "l'1% sì: è la quota di persone a cui è andata male")
})

test('apigateway: sotto il campione tace, ma «fallite tutte» no', () => {
  assert.equal(valutaApigw(1, 5).sforo, null)
  assert.ok(valutaApigw(5, 5).sforo?.tuttoFallito, 'una API poco chiamata non deve poter stare giù in silenzio')
})

test('apigateway: le soglie per tipo arrivano', () => {
  assert.equal(valutaApigw(30, 3000, { rate: 0.5 }).sforo, null, "chi l'ha tarata al 50% deve vederlo applicato")
})

// --- SES ----------------------------------------------------------------------------------------
const ses = (m, opts = {}) => sesRuntime({}, {}, { metricValues: metriche(m), t, ...opts })

test('ses: i tile dicono la stessa cosa dello stato, non un confronto loro', async () => {
  // 2 bounce su 10 invii sono il 20%, ben oltre il 5% di AWS, ma dieci invii non concludono niente:
  // prima il tile usciva rosso sopra a una card verde, che è il modo più rapido per far perdere
  // fiducia a chi guarda.
  const r = await ses({ send: 10, bounce: 2, complaint: 0 })
  assert.equal(r.status, 'up')
  assert.equal(r.metrics.find((x) => x.label === t('m.bounce')).tone, undefined)
})

test('ses: sopra il campione la soglia di AWS conta, e il tile diventa rosso', async () => {
  const r = await ses({ send: 100, bounce: 8, complaint: 0 })
  assert.equal(r.status, 'degraded')
  assert.equal(r.metrics.find((x) => x.label === t('m.bounce')).tone, 'critical')
})

test('ses: le soglie si dichiarano in PERCENTO, come le pubblica AWS', async () => {
  const r = await ses({ send: 100, bounce: 8, complaint: 0 }, { soglie: { bounce: 10 } })
  assert.equal(r.status, 'up', "l'8% sta sotto al 10% dichiarato")
})

// --- la guardia che vale per tutti i profili ----------------------------------------------------
test('spegnere il minimo di un profilo in «e» non lascia la percentuale sola su due chiamate', () => {
  const p = risolviProfilo('chiamante', { min: 0 })
  assert.equal(p.min, null)
  assert.equal(p.campione, 20, 'senza il minimo assoluto a fare da guardia, il campione ci vuole')
})

test('lambda on-demand: il throttling è capacità, non un errore visto dall utente', async () => {
  // 2 throttle su 100 chiamate sono il 2%: sopra all 1% del profilo `utente`, sotto al `capacita`
  // (che vuole >=3 E >=1%). È il ramo cron a fare eccezione, perché lì una run rifiutata per quota
  // è una run che non è avvenuta.
  const r = await lambdaRuntime({ function: 'f' }, {}, { metricValues: metriche({ inv: 100, thr: 2 }), t })
  assert.equal(r.status, 'up')
  const tanti = await lambdaRuntime({ function: 'f' }, {}, { metricValues: metriche({ inv: 100, thr: 5 }), t })
  assert.equal(tanti.status, 'degraded')
})
