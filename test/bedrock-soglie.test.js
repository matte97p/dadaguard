import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bedrockRuntime, raffica, risolviSoglie, contratto } from '../server/runtime/bedrock.js'
import { makeT } from '../server/i18n.js'
import { cleanDetail } from '../server/notify/slack.js'

// Le soglie di Bedrock esistono per una ragione precisa, vista dal vivo: 358 invocazioni con UN errore
// client hanno prodotto un allarme rosso in produzione, più tardi 78 invocazioni con
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
  // bastava UN 503, cioè il rumore normale di Bedrock, per far uscire un rosso di produzione.
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

// --- 5xx: profilo `ritentati`, cioè la sola PERCENTUALE (vedi server/runtime/soglie.js) ---
// Il conteggio assoluto è uscito dalla regola il 22/09/2026: un tetto in valore assoluto non scala
// col traffico, e su questo modello (2.300 invocazioni l'ora) il vecchio ≥50 valeva il 2,2%.
test('5xx: un conteggio alto su un volume alto NON basta più (50 su 10.000 è lo 0,5%)', async () => {
  assert.equal(await stato({ inv: 10000, serr: 50 }), 'up')
})

test('5xx: lo stesso conteggio su un volume piccolo allarma, perché lì è il 10%', async () => {
  assert.equal(await stato({ inv: 500, serr: 50 }), 'down')
})

test('5xx: 5 errori su 20 invocazioni allarmano per percentuale (25%)', async () => {
  assert.equal(await stato({ inv: 20, serr: 5 }), 'down')
})

test('5xx: 1 errore su 20 invocazioni (5%) resta sotto la soglia', async () => {
  assert.equal(await stato({ inv: 20, serr: 1 }), 'up')
})

// Il caso vero del 21/09/2026, l'ora prima del picco: col vecchio ≥25% questa finestra taceva e
// l'allarme arrivava un'ora dopo. È il guadagno della taratura al 10%, non un effetto collaterale.
test('5xx: 306 errori su 1.997 invocazioni (15,3%) allarmano un ora prima del picco', async () => {
  assert.equal(await stato({ inv: 1997, serr: 306 }), 'down')
})

// Il caso reale #4, 18/09/2026 in canale: 12 errori server su 300 invocazioni, cioè il 4%, e in
// canale è uscito un rosso di produzione. A farlo scattare era il solo ramo assoluto (12 >= 5),
// mentre i chiamanti non se ne erano accorti: il retry aveva recuperato tutto. È la ragione per cui
// i due rami salgono a 50 e 25%: sotto quei numeri il retry copre.
test('il caso reale #4: 12 errori server su 300 invocazioni NON sono un guasto', async () => {
  const r = await leggi({ inv: 300, serr: 12, lat: 2700 }, { inv: 75, serr: 3 })
  assert.equal(r.status, 'up', 'il 4% con i retry davanti non è la piattaforma giù')
  assert.doesNotMatch(r.summary, /soglia/, 'e il messaggio non parla di soglie: non ce n è una superata')
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

test('5xx: 3 errori su 8 invocazioni è il 37,5% ma il campione non basta per concludere', async () => {
  assert.equal(await stato({ inv: 8, serr: 3 }), 'up')
})

test('5xx: al campione minimo la percentuale torna a contare (5 su 20 = 25%)', async () => {
  assert.equal(await stato({ inv: 20, serr: 5 }), 'down')
})

test('5xx: appena sotto il campione minimo la stessa manciata di errori non allarma', async () => {
  // 5 su 19 è il 26,3%, più dei 5 su 20 che allarmano: è il campione a mancare, non la percentuale.
  assert.equal(await stato({ inv: 19, serr: 5 }), 'up')
})

test('5xx: il minimo assoluto resta indipendente dal campione (50 errori su 60 invocazioni)', async () => {
  // Il pavimento vale sul ramo percentuale, non su quello assoluto: 50 errori sono 50 errori.
  assert.equal(await stato({ inv: 60, serr: 50 }), 'down')
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
  const r = await leggi({ inv: 200, serr: 60 }, { inv: 50, serr: 0 })
  assert.equal(r.status, 'degraded', 'gli errori sono nell ora, ma non stanno più succedendo')
  assert.match(r.summary, /probabile rientro/, 'e il messaggio lo dice, invece di lasciarlo dedurre')
})

test('sopra soglia solo negli ultimi 15 minuti → degraded (appena cominciato, non è ancora un ora)', async () => {
  const r = await leggi({ inv: 2000, serr: 4 }, { inv: 40, serr: 12 })
  assert.equal(r.status, 'degraded')
  assert.match(r.summary, /non è ancora una finestra da 60m/)
  // I tile davanti mostrano l'ora (4 errori su 2000), lo sforamento viene dai 15 minuti (12 su 40):
  // la riga deve dire di quale finestra parla, o i due conteggi si leggono come un errore di conto.
  assert.match(r.summary, /oltre soglia err\. server \(5xx\) su 15m: 12 su 40/)
})

test('lo sforo visto dalla sola finestra corta si DICHIARA provvisorio', async () => {
  const r = await leggi({ inv: 2000, serr: 4 }, { inv: 40, serr: 12 })
  assert.equal(r.status, 'degraded')
  assert.equal(r.provisional, true, 'l ora non l ha ancora confermato, e in chat non si chiama il canale')
})

test('lo sforo che passa dall ora non è provvisorio, né da conclamato né in rientro', async () => {
  assert.equal((await leggi({ inv: 200, serr: 60 }, { inv: 50, serr: 20 })).provisional, false, 'down')
  assert.equal((await leggi({ inv: 200, serr: 60 }, { inv: 50, serr: 0 })).provisional, false, 'probabile rientro')
})

test('sopra soglia su entrambe → down, e il messaggio dice che è ancora in corso', async () => {
  const r = await leggi({ inv: 200, serr: 60 }, { inv: 50, serr: 20 })
  assert.equal(r.status, 'down')
  assert.match(r.summary, /ancora sopra soglia negli ultimi 15m/)
})

test('finestra acuta larga quanto quella di fondo: una lettura sola, nessuna chiamata in più', async () => {
  let letture = 0
  const spia = async (_aws, _ns, _dims, _q, windowMin) => {
    letture++
    assert.equal(windowMin, 60, 'niente seconda finestra da chiedere a CloudWatch')
    return { ...VUOTO, inv: 100, serr: 30 }
  }
  const r = await bedrockRuntime({ model: 'test-model', acuteWindowMinutes: 90 }, {}, { metricValues: spia })
  assert.equal(letture, 1)
  assert.equal(r.status, 'down', 'con una finestra sola le due condizioni coincidono')
})

// --- il perché dentro al messaggio -------------------------------------------------------------
// Senza, in canale si discute la taratura a memoria: il 06/08 la proposta era «alziamo al 10%» mentre
// a scattare era stato il ramo assoluto, che il 10% non avrebbe toccato.
test('il messaggio dice QUALE soglia è stata superata, con i numeri e la regola', async () => {
  const r = await leggi({ inv: 200, serr: 60 })
  assert.match(r.summary, /oltre soglia/, 'nomina lo sforamento')
  assert.match(r.summary, /su 60m: 60 su 200 \(30%\)/, 'coi numeri che l hanno prodotto, e la finestra da cui vengono')
  assert.match(
    r.summary,
    /≥10% su almeno 20 invocazioni, e con errori per almeno 3 minuti di fila/,
    'e con la regola INTERA, campione minimo e consecutività compresi: sono le condizioni che hanno deciso la taratura',
  )
})

test('il messaggio nomina il segnale più grave quando ne sfondano più di uno', async () => {
  const r = await leggi({ inv: 100, serr: 30, cerr: 20, thr: 10 })
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

// --- consecutività: il conteggio dice QUANTI, la raffica dice se erano di fila ------------------
// Chiesto in canale il 18/09/2026: «idealmente dovrebbero essere errori consecutivi». Le metriche
// non sanno se un retry ha rimediato (ogni tentativo è una invocazione a sé), quindi la durata è il
// sostituto più onesto della domanda vera: uno scossone dentro un minuto solo il retry lo copre,
// tre minuti attaccati di 503 no.
const bucket = (periodSec, serie, t0 = Date.UTC(2026, 8, 18, 14, 0, 0)) => ({
  times: { serr: serie.map((_, i) => t0 + i * periodSec * 1000) },
  series: { serr: serie.slice() },
  period: periodSec,
})

// Come `metriche`, ma ogni finestra porta anche la sua serie per bucket.
const conSerie = (ora, adesso) => async (_aws, _ns, _dims, _q, windowMin) => ({
  ...VUOTO,
  ...(windowMin >= 60 ? ora : adesso),
})
const statoConSerie = async (ora, adesso) =>
  (await bedrockRuntime({ model: 'test-model' }, {}, { metricValues: conSerie(ora, adesso), t: makeT('it') })).status

test('raffica: conta i bucket ATTACCATI, non le posizioni nell array', () => {
  const t0 = Date.UTC(2026, 8, 18, 14, 0, 0)
  // CloudWatch omette i periodi senza dati: questi tre punti sono a 0, 5 e 10 minuti, cioè lontani,
  // e nell'array sono vicini. Contare le posizioni direbbe 3, che è la bugia da evitare.
  assert.equal(raffica([t0, t0 + 300000, t0 + 600000], [4, 4, 4], 60), 1)
  assert.equal(raffica([t0, t0 + 60000, t0 + 120000], [4, 4, 4], 60), 3)
  // Un buco in mezzo spezza la raffica: il tratto più lungo sono due bucket, non tre.
  assert.equal(raffica([t0, t0 + 60000, t0 + 180000], [4, 4, 4], 60), 2)
  assert.equal(raffica([t0, t0 + 60000], [0, 4], 60), 1, 'i bucket a zero non entrano nella raffica')
})

test('raffica: senza serie non si decide, e il conteggio resta padrone (mai un allarme muto)', () => {
  assert.equal(raffica(undefined, undefined, 60), null)
  assert.equal(raffica([1, 2], [1], 60), null, 'array spaiati: non si conclude')
  assert.equal(raffica([1, 2], [1, 1], 0), null, 'senza il passo, adiacente non vuol dire niente')
})

test('5xx: un picco tutto dentro un bucket solo NON allarma, per quanti errori siano', async () => {
  // 60 errori su 200 invocazioni è il 30%, cioè sopra entrambi i rami: a tenerlo giù è la durata.
  const ora = { inv: 200, serr: 60, ...bucket(180, [60, 0, 0, 0]) }
  const adesso = { inv: 50, serr: 20, ...bucket(60, [20, 0, 0]) }
  assert.equal(await statoConSerie(ora, adesso), 'up')
})

test('5xx: gli stessi errori spalmati su minuti attaccati sono un guasto → down', async () => {
  const ora = { inv: 200, serr: 60, ...bucket(180, [30, 30, 0, 0]) }
  const adesso = { inv: 50, serr: 20, ...bucket(60, [7, 7, 6]) }
  assert.equal(await statoConSerie(ora, adesso), 'down')
})

test('5xx: due minuti di fila sui 15m non bastano, tre sì (il pavimento è in minuti)', async () => {
  const ora = { inv: 2000, serr: 4 }
  assert.equal(await statoConSerie(ora, { inv: 50, serr: 20, ...bucket(60, [10, 10, 0]) }), 'up')
  assert.equal(await statoConSerie(ora, { inv: 50, serr: 20, ...bucket(60, [7, 7, 6]) }), 'degraded')
})

test('la consecutività vale sul 5xx, non sul 4xx (lì la guardia è già il minimo assoluto)', async () => {
  const ora = { inv: 100, cerr: 8, ...bucket(180, [8, 0, 0, 0]) }
  const adesso = { inv: 25, cerr: 5, ...bucket(60, [5, 0, 0]) }
  assert.equal(await statoConSerie(ora, adesso), 'down')
})

// --- la regola deve SOPRAVVIVERE al taglio del messaggio in chat -------------------------------
test('in chat resta la regola, non la coda che non dice a che soglia', async () => {
  const r = await leggi({ inv: 200, serr: 60 }, { inv: 50, serr: 20 })
  const inChat = cleanDetail(r.summary)
  assert.match(inChat, /scatta a ≥10% su almeno 20 invocazioni/, 'chi legge deve poter dire perché è uscito questo allarme')
})

// --- le soglie si dichiarano in config, non solo nel codice --------------------------------------
// Tararle e' una decisione di chi guarda il canale: cablate nel codice, ogni cambio e' un rilascio.
const conSoglie = (cfg, globali, ora, adesso = ora) =>
  bedrockRuntime(
    { model: 'test-model', ...cfg },
    {},
    { metricValues: metriche(ora, adesso), t: makeT('it'), soglie: globali },
  )

test('soglie: un servizio può abbassare il minimo assoluto, e allora il caso di oggi allarma', async () => {
  const r = await conSoglie({ soglie: { serr: { min: 10 } } }, null, { inv: 300, serr: 12 })
  assert.equal(r.status, 'down', '12 errori passano il minimo dichiarato a 10')
})

test('soglie: il livello per TIPO copre i modelli autoscoperti, che una riga loro non ce l hanno', async () => {
  const r = await conSoglie({}, { serr: { min: 10 } }, { inv: 300, serr: 12 })
  assert.equal(r.status, 'down')
})

test('soglie: quelle del servizio vincono su quelle per tipo', async () => {
  const r = await conSoglie({ soglie: { serr: { min: 200 } } }, { serr: { min: 10 } }, { inv: 300, serr: 12 })
  assert.equal(r.status, 'up', 'il servizio ha detto 200, e 12 non ci arrivano')
})

test('soglie: un valore che numero non è tiene il default, invece di spegnere la soglia', async () => {
  assert.equal(risolviSoglie({ soglie: { serr: { min: 'tanti' } } }).serr.min, null, 'il profilo `ritentati` non ha un minimo assoluto')
  assert.equal(risolviSoglie({ soglie: { serr: { rate: 7 } } }).serr.rate, 0.1, 'una percentuale > 1 non è una percentuale')
  assert.equal(risolviSoglie({ soglie: { rafficaMinuti: null } }).rafficaMinuti, 3)
})

test('soglie: una config parziale non tocca i segnali che non nomina', async () => {
  const s = risolviSoglie({ soglie: { serr: { min: 10 } } })
  assert.equal(s.serr.min, 10, 'un minimo assoluto si può RIMETTERE da config, e allora vale')
  assert.equal(s.serr.combina, 'o', 'e si combina in `o` con la percentuale, come faceva la regola storica')
  assert.equal(s.serr.rate, 0.1, 'la percentuale resta quella del profilo')
  assert.equal(s.cerr.min, 5, 'e il 4xx non è stato toccato')
})

// Una soglia a zero non è una soglia bassa: `n >= 0` è sempre vero, quindi suonerebbe a ogni
// finestra. Vale come «questa condizione non esiste», ed è l'unico modo esplicito per toglierne una.
test('soglie: una soglia a zero si legge come SPENTA, non come sempre vera', async () => {
  const s = risolviSoglie({ soglie: { cerr: { rate: 0 } } })
  assert.equal(s.cerr.rate, null)
  assert.equal(s.cerr.min, 5, 'e resta l altra condizione')
  const tutte = risolviSoglie({ soglie: { cerr: { rate: 0, min: 0 } } })
  assert.equal(tutte.cerr.min, 5, 'spegnerle tutte e due vorrebbe dire cancellare la sorveglianza: vince il profilo')
  assert.equal(tutte.cerr.rate, 0.05)
})

// --- il contratto del check (standard dei messaggi, §8.2) ---------------------------------------
test('contratto: i cinque campi ci sono, e i numeri vengono dalle soglie vere', () => {
  const c = contratto({ model: 'test-model' })
  for (const campo of ['misura', 'fonte', 'finestra', 'soglia', 'rimedio']) {
    assert.ok(c[campo], `manca il campo ${campo}`)
  }
  assert.match(c.soglia.guasto, /≥10% su almeno 20 invocazioni/, 'le soglie del 5xx')
  assert.match(c.soglia.guasto, /almeno 3 minuti di fila/, 'e la durata')
  assert.match(c.fonte, /AWS\/Bedrock/)
  assert.match(c.fonte, /ModelId=test-model/, 'la fonte dice con quale dimension legge')
})

test('contratto: cambiando la soglia in config cambia il contratto, che non si riscrive a mano', () => {
  const c = contratto({ model: 'test-model', soglie: { serr: { min: 10, rate: 0.5 }, rafficaMinuti: 9 } })
  assert.match(c.soglia.guasto, /≥10 o ≥50%/)
  assert.match(c.soglia.guasto, /almeno 9 minuti di fila/)
})

test('contratto: viaggia col risultato, anche quando il modello non è stato chiamato', async () => {
  const vivo = await leggi({ inv: 300, serr: 12 })
  assert.match(vivo.contratto.soglia.guasto, /≥10% su almeno 20 invocazioni/)
  const fermo = await leggi({})
  assert.equal(fermo.status, 'idle')
  assert.ok(fermo.contratto, 'un check fermo deve dire lo stesso a che soglie guardava')
})
