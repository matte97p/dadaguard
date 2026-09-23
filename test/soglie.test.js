import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROFILI, risolviProfilo, valuta, testoRegola, raffica, rafficaBasta, soglieDiTipo } from '../server/runtime/soglie.js'
import { makeT } from '../server/i18n.js'

// Le soglie stanno in un posto solo, per TIPOLOGIA di segnale, dal 22/09/2026. Prima ogni provider
// aveva la sua regola scritta in casa: Bedrock una coppia minimo+percentuale, le lambda un
// `errors > 0`, API Gateway un `e5 > 0`, SES due percentuali cablate. Quattro grafie per la stessa
// domanda, quindi quattro tarature indipendenti e nessun posto dove leggere la regola di tutto.
//
// Questi test guardano la REGOLA, non un servizio: se cadono, è cambiato il significato di una
// tipologia, e quel cambio vale per tutti i check che la usano.

const t = makeT('it')
const sopra = (n, tot, profilo) => Boolean(valuta(n, tot, risolviProfilo(profilo)))

// --- `ritentati`: dove il chiamante ritenta da sé, decide la sola percentuale -------------------
// I numeri di questi test sono ore VERE del modello Haiku in produzione, prese dal backtest sui 30
// giorni fino al 21/09/2026. Sono il motivo per cui il minimo assoluto è uscito dal profilo.
test('ritentati: il conteggio assoluto non conta più, perché non scala col traffico', () => {
  // 130 errori sono tanti in assoluto, ma su 3.686 invocazioni sono il 3,5%: il retry li ha coperti
  // e nessuno se n'era accorto. Con il vecchio `≥50` questa era un'ora di rosso in produzione.
  assert.equal(sopra(130, 3686, 'ritentati'), false)
  // Gli stessi 130 errori su un traffico dieci volte più piccolo sono il 35%, e lì è un guasto.
  assert.equal(sopra(130, 370, 'ritentati'), true)
})

test('ritentati: al 25% la prima ora tace, e l allarme arriva a picco iniziato', () => {
  // Il 21/09/2026: alle 16 il 15,3%, alle 17 il 38,9%. Con la taratura al 10% suonavano tutte e due,
  // col 25% (scelta del 23/09/2026) la prima tace. È il prezzo della soglia più alta, misurato su
  // un'ora vera: se un giorno si torna indietro, questi sono i numeri da guardare.
  assert.equal(sopra(306, 1997, 'ritentati'), false, '15,3% alle 16:00: sotto al 25%, nessun allarme')
  assert.equal(sopra(981, 2521, 'ritentati'), true, '38,9% alle 17:00')
})

test('ritentati: sotto il campione minimo la percentuale non decide da sola', () => {
  // Il caso reale del 23/08/2026 con i numeri di oggi: 3 su 8 nei 15 minuti sono il 37,5%, cioè
  // sopra al 25%, ma otto invocazioni non concludono niente.
  assert.equal(sopra(3, 8, 'ritentati'), false)
  assert.equal(sopra(5, 20, 'ritentati'), true, 'al campione minimo la stessa percentuale conta')
  assert.equal(sopra(4, 20, 'ritentati'), false, 'il 20% resta sotto: la soglia è 25%')
})

test('ritentati: più errori che invocazioni contate allarmano lo stesso', () => {
  // Richieste respinte prima del conteggio: il campione non c'è, ma il guasto sì, e sopprimerlo
  // vorrebbe dire tacere proprio quando non passa niente.
  assert.equal(sopra(3, 0, 'ritentati'), true)
})

test('ritentati: tutto fallito su un campione piccolo NON allarma, perché il retry è già lì', () => {
  // Differenza voluta rispetto a `utente`: ogni tentativo dell'SDK conta come una invocazione a sé,
  // quindi «3 su 3» qui vuol dire tre tentativi della stessa chiamata, non tre persone servite male.
  assert.equal(sopra(3, 3, 'ritentati'), false)
})

// --- `utente`: l'errore lo vede una persona, e non lo ritenta nessuno ---------------------------
test('utente: basta l 1% delle richieste, dieci volte meno di dove c è il retry', () => {
  assert.equal(sopra(3, 300, 'utente'), true, 'l 1% con qualcuno che aspetta è già un guasto')
  assert.equal(sopra(3, 300, 'ritentati'), false, 'la stessa quota, dove si ritenta, è rumore')
})

test('utente: sotto il campione la percentuale tace, ma «sono fallite tutte» no', () => {
  assert.equal(sopra(1, 5, 'utente'), false, '1 su 5 non conclude niente')
  assert.equal(sopra(5, 5, 'utente'), true, 'cinque su cinque è una API giù, anche se le richieste erano cinque')
})

// --- `esecuzioni`: il denominatore sono tre run, dove una percentuale non dice niente -----------
test('esecuzioni: un errore solo basta, e non c è nessuna percentuale da superare', () => {
  assert.equal(sopra(1, 3, 'esecuzioni'), true)
  assert.equal(sopra(1, 1000, 'esecuzioni'), true, 'il profilo è per i cron: qui non esiste il volume che diluisce')
})

test('esecuzioni: `tuttoFallito` distingue il giallo dal rosso', () => {
  assert.equal(valuta(1, 3, risolviProfilo('esecuzioni')).tuttoFallito, false, 'una run su tre: attenzione')
  assert.equal(valuta(3, 3, risolviProfilo('esecuzioni')).tuttoFallito, true, 'tutte e tre: giù')
})

// --- `capacita` e `chiamante`: due condizioni insieme, perché una sola direbbe una bugia --------
test('capacita: il conteggio da solo non basta (tre throttle su un milione non sono un guasto)', () => {
  assert.equal(sopra(3, 1000000, 'capacita'), false)
  assert.equal(sopra(3, 100, 'capacita'), true, 'gli stessi tre su cento sono il 3%')
})

test('chiamante: 4xx, serve una vera ondata e non il singolo caso', () => {
  assert.equal(sopra(10, 10000, 'chiamante'), false, 'lo 0,1% è rumore di chiamanti')
  assert.equal(sopra(2, 4, 'chiamante'), false, 'il 50% di quattro chiamate non conclude niente')
  assert.equal(sopra(8, 100, 'chiamante'), true)
})

test('chiamante: il campione minimo vale anche qui, dove le condizioni si combinano in «e»', () => {
  // Il caso del 23/09/2026: 10 errori client su 108 invocazioni di un modello di staging hanno
  // chiamato il canale. La coppia «≥5 e ≥5%» sembra due guardie e su un denominatore piccolo ne è
  // una sola, perché cinque richieste sbagliate sono una manciata: da qui il pavimento a 20.
  assert.equal(sopra(5, 6, 'chiamante'), false, '83%, ma sei chiamate non concludono niente')
  assert.equal(sopra(5, 20, 'chiamante'), true, 'al campione minimo il 25% torna a contare')
  assert.equal(sopra(3, 1000000, 'capacita'), false, 'e il throttling, che ha campione 0, non è cambiato')
  assert.equal(sopra(3, 100, 'capacita'), true)
})

test('la regola stampata dice il campione anche nel ramo «e», o tace la condizione che l ha fermata', () => {
  assert.match(testoRegola(risolviProfilo('chiamante'), t, 'invocazioni'), /≥5 e ≥5% su almeno 20 invocazioni/)
  assert.match(testoRegola(risolviProfilo('capacita'), t, 'invocazioni'), /^≥3 e ≥1%$/, 'dove il campione non c è, non si inventa')
})

// --- le soglie per ACCOUNT ----------------------------------------------------------------------
// Lo stesso segnale vuol dire due cose diverse nei due ambienti: un 4xx in produzione è un cliente
// servito male, su staging è quasi sempre il nostro codice a metà di una modifica.
test('perAccount: l override di un ambiente si fonde per SEGNALE su quelle per tipo', () => {
  const cfg = { bedrock: { serr: { rate: 0.3 }, cerr: { min: 5, rate: 0.05 } }, perAccount: { staging: { bedrock: { cerr: { min: 50 } } } } }
  const stg = soglieDiTipo(cfg, 'bedrock', 'staging')
  assert.equal(stg.cerr.min, 50, 'staging alza il minimo del 4xx')
  assert.equal(stg.cerr.rate, 0.05, 'e la percentuale resta quella per tipo, senza ricopiarla')
  assert.equal(stg.serr.rate, 0.3, 'i segnali che l ambiente non nomina restano intatti')
  assert.equal(soglieDiTipo(cfg, 'bedrock', 'production').cerr.min, 5, 'e la produzione non è stata toccata')
})

test('perAccount: senza config, o senza account, non inventa niente', () => {
  assert.equal(soglieDiTipo(null, 'bedrock', 'staging'), null)
  assert.equal(soglieDiTipo({ bedrock: { cerr: { min: 7 } } }, 'bedrock', undefined).cerr.min, 7)
  assert.equal(soglieDiTipo({ perAccount: { staging: { bedrock: { cerr: { min: 9 } } } } }, 'bedrock', 'staging').cerr.min, 9, 'un ambiente può tarare anche dove non c è un livello per tipo')
  assert.equal(soglieDiTipo({ bedrock: { cerr: { min: 7 } } }, 'lambda', 'staging'), null, 'un tipo che nessuno nomina resta ai default del provider')
})

// --- gli override di config --------------------------------------------------------------------
// Tararle è una decisione di chi guarda il canale, non un rilascio: in cloud la config arriva da
// SSM, quindi una soglia si cambia con un parametro e un riavvio.
test('config: si può RIMETTERE un minimo assoluto dove il profilo non ce l ha', () => {
  const p = risolviProfilo('ritentati', { min: 10 })
  assert.equal(p.min, 10)
  assert.equal(p.combina, 'o', 'e si combina in `o`, che è il significato storico di quella coppia')
  assert.equal(Boolean(valuta(12, 300, p)), true, '12 errori sul 4% adesso allarmano, perché qualcuno l ha chiesto')
})

test('config: la regola stampata cambia insieme alla soglia, o mentirebbe', () => {
  assert.match(testoRegola(risolviProfilo('ritentati'), t, 'invocazioni'), /≥25% su almeno 20 invocazioni/)
  assert.match(testoRegola(risolviProfilo('ritentati', { min: 10 }), t, 'invocazioni'), /≥10 o ≥25%/)
  assert.match(testoRegola(risolviProfilo('esecuzioni'), t), /≥1 errori nella finestra/)
})

test('config: un valore che numero non è tiene il default invece di spegnere la soglia', () => {
  assert.equal(risolviProfilo('chiamante', { min: 'tanti' }).min, 5)
  assert.equal(risolviProfilo('chiamante', { rate: 7 }).rate, 0.05, 'una percentuale > 1 non è una percentuale')
})

test('config: zero vale SPENTA, e spegnerle tutte lascia quelle del profilo', () => {
  assert.equal(risolviProfilo('chiamante', { rate: 0 }).rate, null, 'zero non è una soglia bassa: `n >= 0` è sempre vero')
  assert.equal(risolviProfilo('chiamante', { rate: 0 }).min, 5, 'e l altra condizione resta')
  const spente = risolviProfilo('chiamante', { rate: 0, min: 0 })
  assert.equal(spente.min, 5, 'cancellare la sorveglianza non deve essere un effetto collaterale')
  assert.equal(spente.rate, 0.05)
})

test('config: il campione minimo non si eredita fra profili diversi', () => {
  assert.equal(risolviProfilo('esecuzioni').campione, 0, 'su tre run non esiste un campione da aspettare')
  assert.equal(risolviProfilo('utente').campione, 20)
})

test('un profilo che non esiste è un errore del codice, e si vede subito', () => {
  assert.throws(() => risolviProfilo('inventato'), /profilo soglie sconosciuto/)
})

// --- la consecutività --------------------------------------------------------------------------
test('raffica: conta i bucket ATTACCATI, sui timestamp e non sulle posizioni', () => {
  const t0 = 1_700_000_000_000
  const p = 60
  assert.equal(raffica([t0, t0 + 60000, t0 + 120000], [1, 1, 1], p), 3)
  assert.equal(raffica([t0, t0 + 600000], [1, 1], p), 1, 'due valori vicini nell array possono essere lontani nel tempo')
  assert.equal(raffica(null, null, p), null, 'senza serie non si decide: e allora il conteggio resta padrone')
})

test('rafficaBasta: due bucket E tre minuti, perché la larghezza del bucket cambia con la finestra', () => {
  assert.equal(rafficaBasta(2, 60, 3), false, 'due minuti sui bucket da 60s non fanno tre minuti')
  assert.equal(rafficaBasta(3, 60, 3), true)
  assert.equal(rafficaBasta(2, 180, 3), true, 'due bucket da 180s sono sei minuti')
  assert.equal(rafficaBasta(1, 3600, 3), false, 'un bucket solo non è mai una raffica, per quanto sia largo')
})

// --- la tassonomia, guardata da fuori -----------------------------------------------------------
test('ogni profilo dichiara almeno una condizione: un profilo muto non sorveglia niente', () => {
  for (const [nome, p] of Object.entries(PROFILI)) {
    assert.ok(p.min !== null || p.rate !== null, `il profilo ${nome} non ha nessuna condizione`)
  }
})

test('dove la percentuale decide da sola c è sempre un campione minimo', () => {
  for (const [nome, p] of Object.entries(PROFILI)) {
    if (p.min === null) assert.ok(p.campione > 0, `${nome} lascia decidere la percentuale su un denominatore da niente`)
  }
})
