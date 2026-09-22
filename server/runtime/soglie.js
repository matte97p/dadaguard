// Le soglie degli allarmi, per TIPOLOGIA di segnale e non per servizio AWS.
//
// Prima del 22/09/2026 ogni provider aveva la sua regola scritta in casa: Bedrock una coppia
// minimo+percentuale con campione minimo e consecutività, le lambda un `errors > 0`, API Gateway un
// `e5 > 0`, SES due percentuali cablate. Quattro grafie per la stessa domanda («quando un errore
// diventa un guasto?»), quindi quattro tarature indipendenti e nessun posto dove leggere la regola
// di tutto. Il risultato misurato: il ramo assoluto di Bedrock (≥50) su un modello da 2.300
// invocazioni l'ora valeva il 2,2%, cioè decideva sempre lui e la percentuale non entrava mai in
// gioco.
//
// Qui la tipologia è decisa da DUE domande, non dal servizio che emette la metrica:
//   1. chi SUBISCE l'errore: un chiamante che ritenta da sé, o l'utente finale?
//   2. quanto è grande il DENOMINATORE: migliaia di chiamate l'ora, o le tre esecuzioni di un cron?
// Due servizi diversi con le stesse risposte prendono lo stesso profilo, ed è il punto.

// Quanto grande deve essere il campione perché la PERCENTUALE possa decidere da sola. Riguarda i
// profili dove la percentuale è l'unica condizione: su una finestra corta un denominatore da niente
// la farebbe sfondare a qualsiasi errore singolo (il caso reale del 23/08/2026: UN 503 su 8
// invocazioni nei 15 minuti è il 12,5%).
//
// 20 è il più piccolo campione che regge la regola documentata: 1 errore su 20 è il 5% e resta
// sotto al profilo `ritentati`, 2 su 20 sono il 10% e allarmano.
export const CAMPIONE_MINIMO = 20

// Quanto deve DURARE un guasto per suonare, dove il profilo chiede la consecutività. Non basta
// contare gli errori della finestra: dieci 503 tutti nello stesso minuto sono un singolo scossone,
// che il retry assorbe, mentre gli stessi dieci spalmati su minuti attaccati sono il servizio che
// non risponde. Le metriche non sanno se un retry è andato a buon fine (ogni tentativo è una
// invocazione a sé), quindi la durata è il migliore sostituto della domanda vera, «l'utente se n'è
// accorto?».
//
// Due condizioni insieme, perché la larghezza del bucket cambia con la finestra (60s sui 15 minuti,
// 180s sull'ora, vedi `cw.js`): almeno due bucket ATTACCATI, e almeno 3 minuti coperti.
export const RAFFICA_BUCKET = 2
export const RAFFICA_MINUTI = 3

// I profili. `min` è un conteggio assoluto, `rate` una frazione (0..1), `combina` dice cosa fare
// quando ci sono tutti e due: `'e'` vuole entrambe le condizioni, `'o'` una sola. `null` vuol dire
// che quella condizione NON esiste per questa tipologia, ed è diverso da 0: zero scatterebbe sempre.
export const PROFILI = {
  // Errori che il chiamante RITENTA da sé (l'SDK AWS ritenta i 5xx in automatico, e ogni tentativo
  // conta come una invocazione a sé). Finché sono pochi l'utente non li vede: il retry copre, e
  // allarmare lì insegna alla squadra a ignorare il canale. Quindi decide la sola PERCENTUALE, con
  // campione minimo e consecutività.
  //
  // ⚠️ Niente minimo assoluto, ed è la lezione del 22/09/2026: un tetto in valore assoluto non scala
  // col traffico, quindi su un servizio che cresce diventa una percentuale sempre più piccola senza
  // che nessuno lo decida. Backtest su 30 giorni del modello Haiku in produzione: il ramo ≥50 ha
  // suonato DA SOLO 10 volte, e 7 erano ore ad alto traffico con l'1-3,5% di errori, cioè proprio i
  // casi che il retry aveva già assorbito. Il 10% tiene gli stessi 6 giorni veri del 25% e avvisa
  // prima (il 21/09 alle 16:00, un'ora prima del picco).
  ritentati: { min: null, rate: 0.1, campione: CAMPIONE_MINIMO, raffica: true },

  // Errori che arrivano DRITTI all'utente: un 5xx HTTP di una API pubblica non lo ritenta nessuno,
  // il browser mostra la pagina rotta. Stessa forma del profilo sopra ma soglia dieci volte più
  // bassa, perché qui la percentuale è la quota di persone a cui è andata male.
  // ⚠️ `tuttoFallitoAllarma`: sotto al campione minimo la percentuale non decide, ma «tutte e cinque
  // le richieste sono andate male» è un guasto anche se le richieste erano cinque. Senza questa
  // scappatoia il campione minimo diventerebbe un modo per tacere sui servizi poco chiamati, che
  // sono anche quelli dove nessuno si accorge da solo che sono giù.
  utente: { min: null, rate: 0.01, campione: CAMPIONE_MINIMO, raffica: false, tuttoFallitoAllarma: true },

  // Esecuzioni schedulate (cron): il denominatore sono una o tre run, dove la percentuale non
  // significa niente (1 errore su 1 run è il 100%, e 1 su 3 è il 33%: due numeri che dicono la
  // stessa cosa, «è fallita una run»). Quindi conta il CONTEGGIO e basta.
  //
  // Zero tolleranza, e il backtest dice che è giusto: in 30 giorni la produzione ha avuto 4 lambda
  // con errori e 11 ore di allarme, e in 8 di quelle ore falliva il 100% delle esecuzioni. Qui non
  // c'è rumore da filtrare, c'è un cron che non ha fatto il suo lavoro.
  esecuzioni: { min: 1, rate: null, campione: 0, raffica: false, tuttoFallitoAllarma: true },

  // Capacità finita (throttling). Non è un bug, è la quota che si esaurisce: più serio di un errore
  // del chiamante, meno di un 5xx. Entrambe le condizioni, perché qui il conteggio da solo direbbe
  // «tre richieste rallentate su un milione».
  capacita: { min: 3, rate: 0.01, combina: 'e', campione: 0, raffica: false },

  // Errori del CHIAMANTE (4xx): spesso colpa di chi chiama (richiesta malformata, token troppo
  // lungo, quota). Serve una vera ondata, non il singolo caso, quindi entrambe le condizioni.
  chiamante: { min: 5, rate: 0.05, combina: 'e', campione: 0, raffica: false },

  // Reputazione imposta da un FORNITORE: non la scegliamo noi, la sceglie chi può sospenderci
  // l'account (SES sospende sopra ~5% di bounce e ~0,1% di complaint). La percentuale è l'unica
  // condizione e il numero va tenuto sotto quello del fornitore, non tarato a gusto.
  reputazione: { min: null, rate: 0.05, campione: CAMPIONE_MINIMO, raffica: false, tuttoFallitoAllarma: true },
}

// Un numero dichiarato in config, o il default. Un valore che numero non è (una stringa, un `null`,
// un NaN) NON spegne la soglia e non fa cadere il check: si tiene il default. Una config sbagliata
// deve costare la modifica che non ha effetto, non la sorveglianza che sparisce senza dirlo.
//
// ⚠️ `null` in config vale «non c'è questa condizione» SOLO se il profilo la dichiara già assente:
// sennò sarebbe un modo silenzioso di spegnere una soglia scrivendo una parola sbagliata.
export function numero(valore, base, { min = 0, max = Infinity } = {}) {
  const n = typeof valore === 'number' ? valore : Number.NaN
  return Number.isFinite(n) && n >= min && n <= max ? n : base
}

// Il profilo di una tipologia, con sopra gli override di config. `nome` è una chiave di `PROFILI`;
// un nome che non esiste è un errore del codice, non della config, e va visto subito.
export function risolviProfilo(nome, override = null) {
  const base = PROFILI[nome]
  if (!base) throw new Error(`profilo soglie sconosciuto: ${nome}`)
  const d = override ?? {}
  // Una condizione che il profilo non ha si PUÒ aggiungere da config, perché tarare è una decisione
  // di chi guarda il canale e non un rilascio: chi conosce il suo servizio può rimettere un minimo
  // assoluto sopra a un profilo che non ce l'ha. Quando succede le due condizioni si combinano in
  // `o`, che è il significato storico di quella coppia, e la regola stampata nell'allarme lo dice:
  // una soglia aggiunta di nascosto sarebbe di nuovo il difetto da cui siamo partiti.
  const min = spenta(numero(d.min, base.min ?? Number.NaN))
  const rate = spenta(numero(d.rate, base.rate ?? Number.NaN, { max: 1 }))
  // Tutte e due spente vorrebbe dire sorveglianza cancellata scrivendo due zeri: lì vince il
  // profilo, perché non sapere non è un permesso a tacere.
  const vuoto = min === null && rate === null
  return {
    ...base,
    min: vuoto ? base.min : min,
    rate: vuoto ? base.rate : rate,
    combina: base.min === null && min !== null ? 'o' : base.combina,
    campione: numero(d.campione, base.campione),
    rafficaMinuti: numero(d.rafficaMinuti, RAFFICA_MINUTI),
  }
}

// Una soglia a zero (o negativa, o assente) non è una soglia bassa, è una soglia SPENTA: `n >= 0` è
// sempre vero e farebbe suonare l'allarme a ogni finestra. Si legge come «questa condizione non
// esiste», che è anche l'unico modo esplicito per toglierne una da config.
function spenta(n) {
  return Number.isFinite(n) && n > 0 ? n : null
}

// Il segnale è sopra soglia? `null` se è sotto, altrimenti i numeri che ce l'hanno portato.
//
// Denominatore: il totale della finestra, ma mai meno del numero di errori — se CloudWatch pubblica
// errori senza invocazioni (richieste respinte prima di contare) la percentuale resterebbe divisa
// per zero.
export function valuta(n, totale, profilo) {
  const errori = Math.round(n)
  const tot = Math.round(totale)
  if (errori <= 0) return null
  const base = Math.max(tot, errori, 1)
  const pct = Math.round((errori / base) * 1000) / 10
  // Più errori che invocazioni contate: sono le richieste respinte prima del conteggio. Lì il
  // campione non c'è, ma il guasto sì, e pretenderlo vorrebbe dire tacere proprio quando non passa
  // niente.
  const campioneOk = base >= profilo.campione || errori > tot
  const perMin = profilo.min !== null && errori >= profilo.min
  const rateDecideDaSola = profilo.min === null || profilo.combina === 'o'
  const perRate = profilo.rate !== null && errori >= profilo.rate * base && (!rateDecideDaSola || campioneOk)
  const tuttoFallito = tot > 0 && errori >= tot
  const sopra =
    (profilo.tuttoFallitoAllarma && tuttoFallito) ||
    (profilo.min === null ? perRate : profilo.rate === null ? perMin : profilo.combina === 'o' ? perMin || perRate : perMin && perRate)
  if (!sopra) return null
  // `tuttoFallito` non decide se suonare, decide QUANTO forte: chi la usa (le esecuzioni
  // schedulate) la legge per passare da «attenzione» a «giù». Tenerla qui e non nel chiamante
  // serve a non avere due definizioni di «è fallito tutto» che un giorno divergono.
  return { n: errori, totale: tot, pct, tuttoFallito, profilo }
}

// Il più lungo tratto di bucket CONSECUTIVI con errori, contato sui timestamp e non sulle posizioni
// nell'array: CloudWatch omette i periodi senza dati, quindi due valori vicini nell'array possono
// essere lontani nel tempo. `null` quando la serie non c'è (letture finte nei test, o una risposta
// senza timestamp): lì la consecutività non si può decidere, e si lascia passare il conteggio da
// solo: tacere su un guasto vero è peggio di un allarme in più.
export function raffica(times, vals, periodSec) {
  if (!Array.isArray(times) || !Array.isArray(vals) || !periodSec || times.length !== vals.length) return null
  const passo = periodSec * 1000
  const caldi = times
    .map((t, i) => [Number(t), vals[i]])
    .filter(([t, v]) => Number.isFinite(t) && v > 0)
    .map(([t]) => t)
    .sort((a, b) => a - b)
  let best = 0
  let run = 0
  let prev = null
  for (const t of caldi) {
    run = prev !== null && t - prev === passo ? run + 1 : 1
    if (run > best) best = run
    prev = t
  }
  return best
}

// La raffica è abbastanza lunga da chiamarla guasto?
export function rafficaBasta(run, periodSec, minuti) {
  return run >= RAFFICA_BUCKET && (run * periodSec) / 60 >= minuti
}

// La regola in chiaro, per il messaggio. Va SEMPRE stampata accanto ai numeri: senza, l'allarme dice
// che qualcosa è rotto ma non a che soglia, e la taratura si discute a memoria. È già successo di
// proporre «alziamo la percentuale» senza sapere che a far scattare l'allarme era stato il ramo
// assoluto, cioè che alzare la percentuale non avrebbe cambiato niente.
// `unita` è il nome di quello che sta al denominatore, e lo porta il chiamante: invocazioni per un
// modello, richieste per una API, esecuzioni per un cron. Scriverne uno solo qui dentro vorrebbe
// dire far dire «invocazioni» all'allarme di un cron che ne fa tre al giorno.
export function testoRegola(profilo, t, unita = t('soglia.unita.chiamate')) {
  const rate = profilo.rate === null ? null : Math.round(profilo.rate * 1000) / 10
  const coda = profilo.raffica ? t('soglia.regola.raffica', { minuti: profilo.rafficaMinuti }) : ''
  if (profilo.min === null) return t('soglia.regola.rate', { rate, campione: profilo.campione, unita }) + coda
  if (profilo.rate === null) return t('soglia.regola.min', { min: profilo.min }) + coda
  const chiave = profilo.combina === 'o' ? 'soglia.regola.o' : 'soglia.regola.e'
  return t(chiave, { min: profilo.min, rate, campione: profilo.campione, unita }) + coda
}
