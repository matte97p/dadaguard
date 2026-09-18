import { metricValues } from './cw.js'
import { identityT } from '../i18n.js'
import { fmtMs, fmtCount } from '../util/format.js'

// RuntimeProvider Amazon Bedrock. Serverless: guardiamo le metriche d'uso su una finestra (CloudWatch
// AWS/Bedrock, via il batcher condiviso): invocazioni, errori client/server, throttling, latenza.
//  - `aws: { type: bedrock, model: '<modelId>' }` (consigliato) → metriche del singolo modello.
//  - senza `model` → nessuna dimension (aggregato, se l'account pubblica metriche a quel livello).
//
// DUE finestre, non una. L'ora dice se il problema è REALE (denominatore grande: il singolo 503 non
// muove la percentuale); i 15 minuti dicono se sta ANCORA succedendo. Insieme separano le tre
// situazioni che in chat si vogliono distinguere, invece dell'unico rosso di prima:
//
//   ora sopra soglia + 15m sopra soglia → down       persiste, e sta succedendo adesso
//   ora sopra soglia + 15m puliti       → degraded   errori nell'ora ma non negli ultimi 15 minuti:
//                                                    probabile rientro, non ancora confermato
//   ora pulita       + 15m sopra soglia → degraded   appena cominciato, non è ancora un'ora
//
// Asimmetrica di proposito: si sale in fretta (basta la finestra corta) e si scende piano (il verde
// arriva solo quando è pulita l'ORA). La finestra corta apre e chiude in un attimo; la lunga è
// l'unica che può dire "è finita" senza smentirsi dieci minuti dopo.
const DEFAULT_WINDOW_MIN = 60
const ACUTE_WINDOW_MIN = 15

// Quando un errore diventa un GUASTO. Un errore isolato non è la piattaforma giù: 358 invocazioni con
// 1 errore client è rumore normale, e allarmare lì (Bedrock in prod è roba
// seria) è il modo più rapido per far ignorare gli allarmi veri.
//
// Ogni segnale ha DUE condizioni, percentuale E minimo assoluto, perché una sola non basta:
// solo la percentuale fa scattare "1 errore su 2 invocazioni"; solo il minimo assoluto fa scattare
// 5 errori su un milione. L'eccezione è il 5xx (vedi sotto).
const SOGLIE = {
  // 4xx: spesso colpa del chiamante (richiesta malformata, quota, token troppo lunghi) → serve una
  // vera ondata, non il singolo caso.
  cerr: { min: 5, rate: 0.05 },
  // Throttling: non è un bug, è capacità che finisce. Più serio di un 4xx → soglia più bassa.
  thr: { min: 3, rate: 0.01 },
  // 5xx: è Bedrock che rompe, non noi, quindi basta UNA delle due condizioni (`or`). Ma 2 errori / 1%
  // era troppo basso in ENTRAMBI i rami: con ~80 invocazioni l'ora, l'1% vuol dire che un SOLO 503
  // (rumore noto di Bedrock) suonava — ed è quello che è successo. 5 e 10% alzano tutti e due i rami:
  // alzare solo la percentuale avrebbe lasciato il ramo assoluto a suonare alla prossima coppia.
  // Il ramo percentuale vuole anche un campione minimo (vedi `CAMPIONE_MINIMO`): è l'unico che può
  // decidere da solo, e su una finestra corta lo farebbe con un denominatore da niente.
  //
  // 18/09/2026, quarto falso positivo: 12 errori su 300 invocazioni (il 4%, cioè sotto al ramo
  // percentuale) sono usciti come rosso di produzione dal solo ramo assoluto, e i chiamanti non se
  // ne erano accorti perché il retry li aveva recuperati tutti. È il punto: su Bedrock un 503
  // ripreso dal retry NON è un disservizio, e le metriche non lo distinguono da uno che ha rotto la
  // risposta, perché ogni tentativo conta come una invocazione a sé. Quindi si alza di brutto
  // (50 e 25%) invece di limare: sotto quei numeri il retry copre, sopra no. E si aggiunge la
  // CONSECUTIVITÀ (`raffica`), che è la cosa più vicina a «errori consecutivi» che le metriche
  // permettano: un picco isolato non suona nemmeno se è grosso.
  serr: { min: 50, rate: 0.25, or: true, raffica: true },
}

// Quanto grande deve essere il campione perché la PERCENTUALE possa decidere da sola. Riguarda solo
// il 5xx, l'unico con `or`: dove le condizioni sono in `and` la percentuale non decide mai da sola,
// perché a fare da guardia c'è già il minimo assoluto, e un pavimento anche lì toglierebbe solo veri
// positivi (5 errori su 6 invocazioni è l'83%, ed è un guasto).
//
// Il caso reale del 23/08, terzo falso positivo in cinque giorni: UN 503 su 57 invocazioni nell'ora
// (1,75%, pulita) ma su 8 invocazioni nei 15 minuti, cioè il 12,5%, che sfonda il 10% e in
// produzione esce come rosso. La finestra corta ha un denominatore quattro volte più piccolo
// di quella lunga: le soglie alzate nel #92 guardavano l'ora e hanno lasciato scoperta la finestra
// che decide da sola. Senza pavimento, con `rate: 0.1`, QUALSIASI errore singolo sfonda finché le
// invocazioni della finestra sono <= 10, che con questo traffico è la norma, non il caso raro.
//
// 20 è il più piccolo campione che regge la regola documentata: 1 errore su 20 è il 5% e resta
// sotto, 2 su 20 sono il 10% e allarmano.
const CAMPIONE_MINIMO = 20

// Quanto deve DURARE un guasto per suonare, sul solo 5xx. Non basta contare gli errori della
// finestra: dieci 503 tutti nello stesso minuto sono un singolo scossone di Bedrock, che il retry
// assorbe, mentre gli stessi dieci spalmati su minuti attaccati sono il modello che non risponde.
// Le metriche non sanno se un retry è andato a buon fine (ogni tentativo è una invocazione a sé),
// quindi la durata è il migliore sostituto della domanda vera, «l'utente se n'è accorto?».
//
// Due condizioni insieme, perché la larghezza del bucket cambia con la finestra (60s sui 15 minuti,
// 180s sull'ora, vedi `cw.js`): almeno due bucket ATTACCATI, e almeno 3 minuti coperti. Sui 15
// minuti vuol dire 3 bucket, sull'ora 2: in entrambi i casi un buco solo non passa.
const RAFFICA_BUCKET = 2
const RAFFICA_MINUTI = 3

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
function rafficaBasta(run, periodSec, minuti) {
  return run >= RAFFICA_BUCKET && (run * periodSec) / 60 >= minuti
}

// Un numero dichiarato in config, o il default. Un valore che numero non è (una stringa, un `null`,
// un NaN) NON spegne la soglia e non fa cadere il check: si tiene il default. Una config sbagliata
// deve costare la modifica che non ha effetto, non la sorveglianza che sparisce senza dirlo.
function numero(valore, base, { min = 0, max = Infinity } = {}) {
  const n = typeof valore === 'number' ? valore : Number.NaN
  return Number.isFinite(n) && n >= min && n <= max ? n : base
}

// Le soglie che valgono per QUESTO servizio: i default qui sopra, sotto a quelle dichiarate in
// config per tipo (`soglie: { bedrock: … }`, da `server/config.js`), sotto a quelle del singolo
// servizio (`aws.soglie`). Tre livelli perché i modelli Bedrock sono AUTOSCOPERTI: senza il livello
// per tipo, un modello che non ha una riga sua in `services.yaml` non avrebbe nessun posto dove
// essere tarato, e tarare vorrebbe dire di nuovo un rilascio.
export function risolviSoglie(cfg = {}, globali = null) {
  const fuse = { ...(globali ?? {}), ...(cfg?.soglie ?? {}) }
  const soglie = {}
  for (const key of ORDINE) {
    const base = SOGLIE[key]
    const d = fuse[key] ?? {}
    soglie[key] = {
      ...base,
      min: numero(d.min, base.min),
      rate: numero(d.rate, base.rate, { max: 1 }),
    }
  }
  return { ...soglie, rafficaMinuti: numero(fuse.rafficaMinuti, RAFFICA_MINUTI) }
}

// Il contratto del check, nella forma dello standard dei messaggi (§8.2): cosa misura, dove legge,
// su che finestra, con quali soglie e cosa fare quando è rosso. Si COMPONE dalle soglie risolte
// invece di essere scritto a mano: un contratto ricopiato è un contratto che mente il giorno in cui
// qualcuno cambia un numero, ed è esattamente la cosa che questo blocco serve a impedire.
export function contratto(cfg = {}, globali = null, { windowMin = DEFAULT_WINDOW_MIN, acutaMin = ACUTE_WINDOW_MIN } = {}) {
  const s = risolviSoglie(cfg, globali)
  const pct = (r) => `${Math.round(r * 100)}%`
  return {
    misura: `invocazioni, errori server (5xx), errori client (4xx), throttling e latenza del modello ${cfg.model ?? '(aggregato)'}`,
    fonte: `CloudWatch AWS/Bedrock${cfg.model ? `, dimension ModelId=${cfg.model}` : ', senza dimension'}`,
    finestra: `${windowMin}m per dire se è reale, ${acutaMin}m per dire se sta ancora succedendo`,
    soglia: {
      guasto: `5xx ≥${s.serr.min} o ≥${pct(s.serr.rate)} su ≥${CAMPIONE_MINIMO} invocazioni, per ≥${s.rafficaMinuti} minuti di fila, su ENTRAMBE le finestre`,
      degradato: `le stesse condizioni su UNA sola delle due finestre, oppure throttling ≥${s.thr.min} e ≥${pct(s.thr.rate)}, oppure 4xx ≥${s.cerr.min} e ≥${pct(s.cerr.rate)}`,
      ok: 'nessun segnale sopra soglia su nessuna delle due finestre',
    },
    rimedio: 'controllare il throttling per modello e la regione del profilo di inferenza; un 5xx di Bedrock non si ripara da qui, si misura e si aspetta',
  }
}

// Se più segnali sfondano insieme, il messaggio nomina il più grave: prima il 5xx (è la piattaforma),
// poi il throttling (capacità), infine il 4xx (chiamante).
const ORDINE = ['serr', 'thr', 'cerr']
const SEGNALE = { serr: 'm.errServer', thr: 'm.throttle', cerr: 'm.errClient' }

// Un segnale sopra soglia, coi numeri che ce l'hanno portato; `null` se è sotto.
// Denominatore: le invocazioni della finestra, ma mai meno del numero di errori — se CloudWatch
// pubblica errori senza invocazioni (richieste respinte prima di contare) la percentuale resterebbe
// divisa per zero.
function sforo(key, n, inv, s) {
  const base = Math.max(inv, n, 1)
  const perMin = n >= s.min
  // Il campione basta se è abbastanza grande, oppure se non serve (il ramo percentuale non decide
  // da solo). L'eccezione sono gli errori che superano le invocazioni contate, cioè le richieste
  // respinte prima del conteggio: lì il campione non c'è, ma il guasto sì, e sopprimerlo
  // vorrebbe dire tacere proprio quando non passa niente.
  const campione = !s.or || base >= CAMPIONE_MINIMO || n > inv
  const perRate = campione && n >= s.rate * base
  if (!(s.or ? perMin || perRate : perMin && perRate)) return null
  return { key, n, inv, pct: Math.round((n / base) * 1000) / 10, min: s.min, rate: s.rate, or: Boolean(s.or) }
}

// I segnali sopra soglia di una finestra, dal più grave al meno grave. Chi ha `raffica` passa anche
// dalla durata: il conteggio dice QUANTI, la raffica dice se sono stati di fila.
function sfori(m, soglie) {
  const inv = Math.round(m.inv)
  return ORDINE.map((k) => {
    const s = sforo(k, Math.round(m[k]), inv, soglie[k])
    if (!s || !soglie[k].raffica) return s
    const run = raffica(m.times?.[k], m.series?.[k], m.period)
    if (run === null) return s
    return rafficaBasta(run, m.period, soglie.rafficaMinuti) ? { ...s, run, periodSec: m.period } : null
  }).filter(Boolean)
}

// Il "perché" in chiaro dentro al messaggio. Senza, l'allarme dice che qualcosa è rotto ma non a che
// soglia, e la taratura si discute a memoria: è già successo di proporre «alziamo la percentuale»
// senza sapere che a far scattare l'allarme era stato il ramo assoluto — cioè che alzare la
// percentuale non avrebbe cambiato niente.
// La finestra va NOMINATA: i tile davanti mostrano sempre l'ora, ma lo sforamento può venire dai
// soli 15 minuti. Senza l'etichetta la stessa riga porterebbe due conteggi diversi senza dire di
// cosa parla il secondo («4 err. server (60m) · oltre soglia: 6 su 40»), che si legge come un errore.
function perche(s, finestra, t, rafficaMinuti) {
  const rate = Math.round(s.rate * 100)
  // Il pavimento sul campione fa parte della regola, quindi si stampa: è la condizione che il
  // 23/08 ha deciso l'allarme, e una regola scritta a metà è esattamente ciò che porta a tarare
  // il ramo sbagliato leggendo la chat.
  const regola = s.or
    ? t('bedrock.regola.o', { min: s.min, rate, campione: CAMPIONE_MINIMO }) +
      (SOGLIE[s.key]?.raffica ? t('bedrock.regola.raffica', { minuti: rafficaMinuti }) : '')
    : t('bedrock.regola.e', { min: s.min, rate })
  return t('bedrock.sopraSoglia', { segnale: t(SEGNALE[s.key]), finestra, n: s.n, inv: s.inv, pct: s.pct, regola })
}

export async function bedrockRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? identityT
  // Iniettabile come `deps` in runOnce: le soglie sono la parte che si sbaglia, e va testata senza rete.
  const leggiMetriche = opts.metricValues ?? metricValues
  const soglie = risolviSoglie(cfg, opts.soglie)
  const windowMin = cfg.windowMinutes ?? DEFAULT_WINDOW_MIN
  // Mai più lunga della finestra di fondo: una "acuta" larga quanto l'ora non distinguerebbe niente,
  // e in quel caso si degrada a una lettura sola (nessuna chiamata CloudWatch in più).
  const acutaMin = Math.min(cfg.acuteWindowMinutes ?? ACUTE_WINDOW_MIN, windowMin)
  const dims = cfg.model ? [{ Name: 'ModelId', Value: cfg.model }] : []
  const [m, acuta] = await Promise.all([
    leggiMetriche(
      aws,
      'AWS/Bedrock',
      dims,
      [
        ['inv', 'Invocations', 'Sum'],
        ['cerr', 'InvocationClientErrors', 'Sum'],
        ['serr', 'InvocationServerErrors', 'Sum'],
        ['thr', 'InvocationThrottles', 'Sum'],
        ['lat', 'InvocationLatency', 'Average'],
        ['tin', 'InputTokenCount', 'Sum'],
        ['tout', 'OutputTokenCount', 'Sum'],
      ],
      windowMin,
    ),
    // Solo i contatori che decidono lo stato: latenza, token e sparkline restano alla finestra di
    // fondo, che è quella mostrata sulla card. Meno metriche = meno costo, perché GetMetricData si
    // paga a metrica richiesta e qui i modelli sono autoscoperti (il loro numero cresce da solo).
    acutaMin < windowMin
      ? leggiMetriche(
          aws,
          'AWS/Bedrock',
          dims,
          [
            ['inv', 'Invocations', 'Sum'],
            ['cerr', 'InvocationClientErrors', 'Sum'],
            ['serr', 'InvocationServerErrors', 'Sum'],
            ['thr', 'InvocationThrottles', 'Sum'],
          ],
          acutaMin,
        )
      : null,
  ])
  const winL = `${windowMin}m`
  const acuL = `${acutaMin}m`
  if (!m.inv && !m.cerr && !m.serr && !m.thr) {
    return {
      status: 'idle',
      summary: t('bedrock.idle', { window: winL }),
      contratto: contratto(cfg, opts.soglie, { windowMin, acutaMin }),
    }
  }
  const cerr = Math.round(m.cerr)
  const serr = Math.round(m.serr)
  const throttles = Math.round(m.thr)
  const inv = Math.round(m.inv)
  const nellOra = sfori(m, soglie)
  const adesso = acuta ? sfori(acuta, soglie) : nellOra
  // Tre stati invece di due: `down` = conclamato (persiste E in corso), `degraded` = da guardare (uno
  // dei due), `up` = pulito su entrambe le finestre.
  const status = nellOra.length && adesso.length ? 'down' : nellOra.length || adesso.length ? 'degraded' : 'up'
  // Stat tile strutturati (label + valore + tono di stato). Errori: client (4xx, richieste/quota) e
  // server (5xx, colpa di Bedrock) = cause diverse → tile distinti; puliti → "0" verde.
  // NB i tile mostrano gli errori anche SOTTO soglia: sulla card li vuoi vedere, è l'allarme che non
  // deve suonare. Soglia e visibilità sono due cose diverse.
  const metrics = [{ label: t('m.inv', { n: inv }), value: fmtCount(inv), spark: m.series?.inv }]
  if (serr > 0) metrics.push({ label: t('m.errServer'), value: String(serr), tone: 'critical' })
  if (cerr > 0) metrics.push({ label: t('m.errClient'), value: String(cerr), tone: 'warning' })
  if (serr === 0 && cerr === 0) metrics.push({ label: t('m.errors', { n: 0 }), value: '0', tone: 'good' })
  if (throttles > 0) metrics.push({ label: t('m.throttle'), value: String(throttles), tone: 'warning' })
  if (m.lat > 0) metrics.push({ label: t('m.latency'), value: `~${fmtMs(Math.round(m.lat))}`, kind: 'latency', ms: Math.round(m.lat), spark: m.series?.lat, sparkUnit: 'ms' })
  if (m.tin > 0 || m.tout > 0) metrics.push({ label: t('m.tokens'), value: `${fmtCount(Math.round(m.tin))} → ${fmtCount(Math.round(m.tout))}` })
  // La coda del summary è quella che finisce in chat: prima QUALE soglia è stata superata e con che
  // numeri, poi cosa dicono le due finestre messe insieme.
  //
  // La REGOLA va per ULTIMA, e non è cosmesi: in chat il dettaglio si taglia a 160 caratteri e
  // `notify/slack.js` salva l'ultimo pezzo separato da «·» (`cleanDetail`). Con la regola in mezzo
  // il taglio la mangiava, e il 18/09/2026 in canale è arrivato «oltre soglia err. server (5xx)… ·
  // ancora sopra soglia negli ultimi 15m», cioè la metà che non dice a che soglia: la domanda che
  // ne è seguita è stata «non so bene su cosa sia costruito questo alert».
  const colpevole = nellOra[0] ?? adesso[0] ?? null
  const coda = []
  if (nellOra.length && adesso.length) coda.push(t('bedrock.ancora', { window: acuL }))
  else if (nellOra.length) coda.push(t('bedrock.rientro', { window: acuL, conferma: winL }))
  else if (adesso.length) coda.push(t('bedrock.appena', { window: acuL, conferma: winL }))
  if (colpevole) coda.push(perche(colpevole, nellOra.length ? winL : acuL, t, soglie.rafficaMinuti))
  const summary = [`${metrics.map((x) => `${x.value} ${x.label}`).join(' · ')} (${winL})`, ...coda].join(' · ')
  return {
    status,
    summary,
    metrics,
    window: winL,
    acuteWindow: acuL,
    // Il contratto viaggia col risultato: le soglie che hanno deciso QUESTO stato, non quelle che
    // qualcuno ha scritto in un documento mesi fa.
    contratto: contratto(cfg, opts.soglie, { windowMin, acutaMin }),
    clientErrors: cerr,
    serverErrors: serr,
    throttles,
    over: nellOra.map((s) => s.key),
    overAcute: adesso.map((s) => s.key),
    // Lo sforamento viene SOLO dalla finestra corta: è cominciato adesso e non è ancora confermato
    // dall'ora, che è l'unica che può dirlo senza smentirsi dieci minuti dopo. Il messaggio già lo
    // scrive («non è ancora una finestra da 60m»), e `notify/slack.js` lo usa per non chiamare il
    // canale su un allarme che si annuncia da sé come provvisorio.
    provisional: !nellOra.length && adesso.length > 0,
  }
}
