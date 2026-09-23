import { metricValues } from './cw.js'
import { identityT, makeT } from '../i18n.js'
import { risolviProfilo, valuta, raffica, rafficaBasta, testoRegola } from './soglie.js'
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

// Quando un errore diventa un GUASTO: le regole NON stanno qui, stanno in `soglie.js`, per
// tipologia di segnale. Bedrock ne usa tre, e ognuna risponde a una domanda diversa:
//   5xx → `ritentati`   l'SDK ritenta da sé, l'utente non se ne accorge finché non sono tanti
//   throttling → `capacita`   non è un bug, è la quota che finisce
//   4xx → `chiamante`   di solito è la nostra richiesta a essere sbagliata
//
// Prima del 22/09/2026 i numeri stavano qui dentro e valevano solo per Bedrock. Il 5xx aveva una
// coppia `≥50 o ≥25%`: il ramo assoluto, su un modello da 2.300 invocazioni l'ora, valeva il 2,2% e
// decideva sempre lui. Ora il profilo `ritentati` è percentuale pura al 25%, e la stessa tipologia
// vale per chiunque altro abbia un chiamante che ritenta.
const PROFILO = { serr: 'ritentati', thr: 'capacita', cerr: 'chiamante' }

// Le soglie che valgono per QUESTO servizio: il profilo della tipologia, sotto a quelle dichiarate
// in config per tipo (`soglie: { bedrock: … }`, da `server/config.js`), sotto a quelle del singolo
// servizio (`aws.soglie`). Tre livelli perché i modelli Bedrock sono AUTOSCOPERTI: senza il livello
// per tipo, un modello che non ha una riga sua in `services.yaml` non avrebbe nessun posto dove
// essere tarato, e tarare vorrebbe dire di nuovo un rilascio.
export function risolviSoglie(cfg = {}, globali = null) {
  const fuse = { ...(globali ?? {}), ...(cfg?.soglie ?? {}) }
  const soglie = {}
  for (const key of ORDINE) soglie[key] = risolviProfilo(PROFILO[key], { ...fuse[key], rafficaMinuti: fuse.rafficaMinuti })
  return { ...soglie, rafficaMinuti: soglie.serr.rafficaMinuti }
}

// Il contratto del check, nella forma dello standard dei messaggi (§8.2): cosa misura, dove legge,
// su che finestra, con quali soglie e cosa fare quando è rosso. Si COMPONE dalle soglie risolte
// invece di essere scritto a mano: un contratto ricopiato è un contratto che mente il giorno in cui
// qualcuno cambia un numero, ed è esattamente la cosa che questo blocco serve a impedire.
export function contratto(cfg = {}, globali = null, { windowMin = DEFAULT_WINDOW_MIN, acutaMin = ACUTE_WINDOW_MIN } = {}) {
  const s = risolviSoglie(cfg, globali)
  // Il contratto si legge in italiano anche quando il canale è in inglese: è la scheda del check,
  // non un messaggio. La regola però NON si riscrive a mano qui, si chiede alla stessa funzione che
  // la stampa negli allarmi, o le due grafie divergono al primo cambio di soglia.
  const it = makeT('it')
  const regola = (k) => testoRegola(s[k], it, it('soglia.unita.invocazioni'))
  return {
    misura: `invocazioni, errori server (5xx), errori client (4xx), throttling e latenza del modello ${cfg.model ?? '(aggregato)'}`,
    fonte: `CloudWatch AWS/Bedrock${cfg.model ? `, dimension ModelId=${cfg.model}` : ', senza dimension'}`,
    finestra: `${windowMin}m per dire se è reale, ${acutaMin}m per dire se sta ancora succedendo`,
    soglia: {
      guasto: `5xx ${regola('serr')}, su ENTRAMBE le finestre`,
      degradato: `le stesse condizioni su UNA sola delle due finestre, oppure throttling ${regola('thr')}, oppure 4xx ${regola('cerr')}`,
      ok: 'nessun segnale sopra soglia su nessuna delle due finestre',
    },
    rimedio: 'controllare il throttling per modello e la regione del profilo di inferenza; un 5xx di Bedrock non si ripara da qui, si misura e si aspetta',
  }
}

// Se più segnali sfondano insieme, il messaggio nomina il più grave: prima il 5xx (è la piattaforma),
// poi il throttling (capacità), infine il 4xx (chiamante).
const ORDINE = ['serr', 'thr', 'cerr']
const SEGNALE = { serr: 'm.errServer', thr: 'm.throttle', cerr: 'm.errClient' }

// I segnali sopra soglia di una finestra, dal più grave al meno grave. Chi ha `raffica` passa anche
// dalla durata: il conteggio dice QUANTI, la raffica dice se sono stati di fila.
function sfori(m, soglie) {
  const inv = Math.round(m.inv)
  return ORDINE.map((k) => {
    const s = valuta(m[k], inv, soglie[k])
    if (!s) return null
    const esito = { key: k, n: s.n, inv: s.totale, pct: s.pct, profilo: s.profilo }
    if (!soglie[k].raffica) return esito
    const run = raffica(m.times?.[k], m.series?.[k], m.period)
    if (run === null) return esito
    return rafficaBasta(run, m.period, soglie[k].rafficaMinuti) ? { ...esito, run, periodSec: m.period } : null
  }).filter(Boolean)
}

// Il "perché" in chiaro dentro al messaggio: quale segnale, con che numeri, e a che soglia scatta.
// La finestra va NOMINATA: i tile davanti mostrano sempre l'ora, ma lo sforamento può venire dai
// soli 15 minuti. Senza l'etichetta la stessa riga porterebbe due conteggi diversi senza dire di
// cosa parla il secondo («4 err. server (60m) · oltre soglia: 6 su 40»), che si legge come un errore.
function perche(s, finestra, t) {
  return t('bedrock.sopraSoglia', { segnale: t(SEGNALE[s.key]), finestra, n: s.n, inv: s.inv, pct: s.pct, regola: testoRegola(s.profilo, t, t('soglia.unita.invocazioni')) })
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

// Ri-esportata perché la consecutività è nata qui e da qui la importano i test e chi legge: la
// definizione però è una sola, in `soglie.js`, con le altre regole.
export { raffica }
