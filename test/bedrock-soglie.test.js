import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bedrockRuntime } from '../server/runtime/bedrock.js'
import { makeT } from '../server/i18n.js'

// Le soglie di Bedrock esistono per una ragione precisa, vista dal vivo: 358 invocazioni con UN errore
// client hanno prodotto un allarme rosso con `<!channel>` in produzione, più tardi 78 invocazioni con
// UN errore server hanno fatto lo stesso, e il 23/08 ci è riuscito UN 503 su 57 invocazioni, passando
// dalla finestra corta. Un errore isolato non è la piattaforma giù, e un allarme che suona per il
// rumore normale insegna alla squadra a ignorarlo.
//
// Il provider legge DUE finestre: l'ora (il problema è reale?) e gli ultimi 15 minuti (sta ancora
// succedendo?). Da qui i tre stati: `down` se sfondano entrambe, `degraded` se ne sfonda una sola,
// `up` se nessuna.

// Finta lettura CloudWatch: `bedrockRuntime` accetta `opts.metricValues`, così le soglie si provano
// senza rete (stessa convenzione dei `deps` di runOnce). Il quinto argomento è la finestra in minuti:
// è quello che distingue la lettura dell'ora da quella dei 15 minuti.
const VUOTO = { inv: 0, cerr: 0, serr: 0, thr: 0, lat: 0, tin: 0, tout: 0 }
const metriche =
  (ora, adesso = ora) =>
  async (_aws, _ns, _dims, _q, windowMin) => ({ ...VUOTO, ...(windowMin >= 60 ? ora : adesso) })

// Lingua vera e non `identityT`: metà di questi test guarda il TESTO del messaggio, che è il posto
// dove finisce la spiegazione dell'allarme.
const leggi = (ora, adesso) =>
  bedrockRuntime({ model: 'test-model' }, {}, { metricValues: metriche(ora, adesso), t: makeT('it') })
const stato = async (ora, adesso) => (await leggi(ora, adesso)).status

test('il caso reale #1: 1 errore client su 358 invocazioni NON è un guasto', async () => {
  assert.equal(await stato({ inv: 358, cerr: 1, lat: 3700 }), 'up')
})

test('il caso reale #2: 1 errore server su 78 invocazioni NON è un guasto', async () => {
  // È l'allarme del 06/08 in canale. Con la coppia vecchia (min 2 / rate 1%) l'1% di 78 valeva 0,78:
  // bastava UN 503, cioè il rumore normale di Bedrock, per svegliare tutti con un `<!channel>`.
  assert.equal(await stato({ inv: 78, serr: 1, lat: 15000 }), 'up')
})

test('due 503 nell ora restano rumore (era il caso che scattava col minimo assoluto a 2)', async () => {
  assert.equal(await stato({ inv: 78, serr: 2 }), 'up')
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

test('4xx: ondata vera (>=5% e >=5 errori), e in corso adesso → down', async () => {
  assert.equal(await stato({ inv: 100, cerr: 8 }, { inv: 25, cerr: 5 }), 'down')
})

// --- 5xx: è Bedrock che rompe → basta UNA delle due condizioni ---
test('5xx: 5 errori server allarmano anche su volumi alti (OR, non AND)', async () => {
  assert.equal(await stato({ inv: 10000, serr: 5 }), 'down')
})

test('5xx: 4 errori server su volumi alti non allarmano (sotto il minimo assoluto)', async () => {
  assert.equal(await stato({ inv: 10000, serr: 4 }), 'up')
})

test('5xx: 2 errori su 20 invocazioni allarmano per percentuale (10%)', async () => {
  assert.equal(await stato({ inv: 20, serr: 2 }), 'down')
})

test('5xx: 1 errore su 20 invocazioni (5%) resta sotto entrambi i rami', async () => {
  assert.equal(await stato({ inv: 20, serr: 1 }), 'up')
})

// --- 5xx: la percentuale non decide su un campione da niente ------------------------------------
// Il caso reale #3, 23/08 in canale. Il ramo percentuale del 5xx decide DA SOLO (`or`), e sui 15
// minuti il denominatore è quattro volte più piccolo che sull'ora: senza un campione minimo,
// QUALSIASI errore singolo sfonda il 10% finché le invocazioni della finestra sono <= 10.
test('il caso reale #3: 1 errore server su 57 invocazioni l ora e 8 nei 15 minuti NON è un guasto', async () => {
  const r = await leggi({ inv: 57, serr: 1, lat: 32000 }, { inv: 8, serr: 1 })
  assert.equal(r.status, 'up', 'un 503 isolato non è la piattaforma giù, su nessuna delle due finestre')
  assert.doesNotMatch(r.summary, /soglia/, 'e il messaggio non parla di soglie: non ce n è una superata')
})

test('5xx: 1 errore su 8 invocazioni è il 12,5% ma il campione non basta per concludere', async () => {
  assert.equal(await stato({ inv: 8, serr: 1 }), 'up')
})

test('5xx: al campione minimo la percentuale torna a contare (2 su 20 = 10%)', async () => {
  assert.equal(await stato({ inv: 20, serr: 2 }), 'down')
})

test('5xx: appena sotto il campione minimo la stessa coppia di errori non allarma', async () => {
  // 2 su 19 è il 10,5%, più dei 2 su 20 che allarmano: è il campione a mancare, non la percentuale.
  assert.equal(await stato({ inv: 19, serr: 2 }), 'up')
})

test('5xx: il minimo assoluto resta indipendente dal campione (5 errori su 6 invocazioni)', async () => {
  // Il pavimento vale sul ramo percentuale, non su quello assoluto: 5 errori sono 5 errori.
  assert.equal(await stato({ inv: 6, serr: 5 }), 'down')
})

test('5xx: più errori che invocazioni contate allarma comunque (richieste respinte prima del conteggio)', async () => {
  // Campione minuscolo, ma non passa niente: sopprimere qui vorrebbe dire tacere sul guasto vero.
  assert.equal(await stato({ inv: 2, serr: 3 }), 'down')
})

test('il campione minimo non tocca i segnali in `and`: la percentuale lì non decide da sola', async () => {
  // 5 errori client su 6 invocazioni è l'83%: campione piccolo, ma il minimo assoluto è già la
  // guardia, e mettere un pavimento anche qui toglierebbe solo veri positivi.
  assert.equal(await stato({ inv: 6, cerr: 5 }), 'down')
})

// --- throttling: capacità che finisce, soglia più bassa del 4xx ---
test('throttling: 3 su 100 (3%), e ancora in corso → down', async () => {
  assert.equal(await stato({ inv: 100, thr: 3 }, { inv: 25, thr: 3 }), 'down')
})

test('throttling: 2 su 100 resta sotto il minimo assoluto', async () => {
  assert.equal(await stato({ inv: 100, thr: 2 }), 'up')
})

// --- le due finestre: la parte che distingue "rotto" da "sta rientrando" ------------------------
test('sopra soglia nell ora ma ultimi 15 minuti puliti → degraded, non down (probabile rientro)', async () => {
  const r = await leggi({ inv: 200, serr: 8 }, { inv: 50, serr: 0 })
  assert.equal(r.status, 'degraded', 'gli errori sono nell ora, ma non stanno più succedendo')
  assert.match(r.summary, /probabile rientro/, 'e il messaggio lo dice, invece di lasciarlo dedurre')
})

test('sopra soglia solo negli ultimi 15 minuti → degraded (appena cominciato, non è ancora un ora)', async () => {
  const r = await leggi({ inv: 2000, serr: 4 }, { inv: 40, serr: 6 })
  assert.equal(r.status, 'degraded')
  assert.match(r.summary, /non è ancora una finestra da 60m/)
  // I tile davanti mostrano l'ora (4 errori su 2000), lo sforamento viene dai 15 minuti (6 su 40):
  // la riga deve dire di quale finestra parla, o i due conteggi si leggono come un errore di conto.
  assert.match(r.summary, /oltre soglia err\. server \(5xx\) su 15m: 6 su 40/)
})

test('lo sforo visto dalla sola finestra corta si DICHIARA provvisorio', async () => {
  const r = await leggi({ inv: 2000, serr: 4 }, { inv: 40, serr: 6 })
  assert.equal(r.status, 'degraded')
  assert.equal(r.provisional, true, 'l ora non l ha ancora confermato, e in chat non si chiama il canale')
})

test('lo sforo che passa dall ora non è provvisorio, né da conclamato né in rientro', async () => {
  assert.equal((await leggi({ inv: 200, serr: 20 }, { inv: 50, serr: 8 })).provisional, false, 'down')
  assert.equal((await leggi({ inv: 200, serr: 8 }, { inv: 50, serr: 0 })).provisional, false, 'probabile rientro')
})

test('sopra soglia su entrambe → down, e il messaggio dice che è ancora in corso', async () => {
  const r = await leggi({ inv: 200, serr: 20 }, { inv: 50, serr: 8 })
  assert.equal(r.status, 'down')
  assert.match(r.summary, /ancora sopra soglia negli ultimi 15m/)
})

test('finestra acuta larga quanto quella di fondo: una lettura sola, nessuna chiamata in più', async () => {
  let letture = 0
  const spia = async (_aws, _ns, _dims, _q, windowMin) => {
    letture++
    assert.equal(windowMin, 60, 'niente seconda finestra da chiedere a CloudWatch')
    return { ...VUOTO, inv: 100, serr: 20 }
  }
  const r = await bedrockRuntime({ model: 'test-model', acuteWindowMinutes: 90 }, {}, { metricValues: spia })
  assert.equal(letture, 1)
  assert.equal(r.status, 'down', 'con una finestra sola le due condizioni coincidono')
})

// --- il perché dentro al messaggio -------------------------------------------------------------
// Senza, in canale si discute la taratura a memoria: il 06/08 la proposta era «alziamo al 10%» mentre
// a scattare era stato il ramo assoluto, che il 10% non avrebbe toccato.
test('il messaggio dice QUALE soglia è stata superata, con i numeri e la regola', async () => {
  const r = await leggi({ inv: 200, serr: 20 })
  assert.match(r.summary, /oltre soglia/, 'nomina lo sforamento')
  assert.match(r.summary, /su 60m: 20 su 200 \(10%\)/, 'coi numeri che l hanno prodotto, e la finestra da cui vengono')
  assert.match(
    r.summary,
    /≥5 o ≥10% su almeno 20 invocazioni/,
    'e con la regola INTERA, campione minimo compreso: è la condizione che il 23/08 ha deciso l allarme',
  )
})

test('il messaggio nomina il segnale più grave quando ne sfondano più di uno', async () => {
  const r = await leggi({ inv: 100, serr: 10, cerr: 20, thr: 10 })
  assert.match(r.summary, /oltre soglia err\. server \(5xx\)/, 'il 5xx viene prima: è la piattaforma')
})

test('quando è tutto a posto il messaggio non parla di soglie', async () => {
  const r = await leggi({ inv: 358, cerr: 1 })
  assert.doesNotMatch(r.summary, /soglia/)
})

// --- niente divisioni per zero ---
test('errori senza invocazioni: la percentuale non esplode', async () => {
  const s = await stato({ inv: 0, serr: 3 })
  assert.equal(s, 'down', 'errori senza invocazioni contano come guasto, non come NaN')
})

// --- la card mostra comunque l'errore: soglia != visibilità ---
test('sotto soglia lo stato è up MA il tile dell errore resta visibile sulla card', async () => {
  const r = await leggi({ inv: 358, cerr: 1 })
  assert.equal(r.status, 'up', 'non allarma')
  assert.equal(r.clientErrors, 1, 'ma il conteggio resta esposto')
  const label = JSON.stringify(r.metrics)
  assert.ok(label.includes('err. client (4xx)'), 'e il tile 4xx c-è: sulla card lo vuoi vedere')
})
