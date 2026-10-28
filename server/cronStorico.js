// Lo STORICO dei cron per la vista «Andamento» della pagina Cron: per ogni cron e ogni fascia (un giorno,
// o sei ore sulla settimana) quante corse, quante fallite, quante saltate e quanto ci hanno messo di
// solito. Read-only, zero storage come tutto il resto: si rilegge da AWS, con una cache di dieci minuti.
//
// Perche' NON si leggono i log come fa la lista delle corse (server/runs.js): trenta giorni di righe di
// log sono la lettura piu' cara che c'e'. `FilterLogEvents` scansiona tutto quello che il cron ha
// scritto, a pagine, sotto una quota di ~10 richieste al secondo per account: per settantacinque cron e
// un mese sarebbero migliaia di pagine, cioe' minuti di attesa e la quota tolta alla pagina che qualcuno
// sta guardando. Qui due sorgenti che costano una frazione:
//
//  · Lambda: le METRICHE di AWS/Lambda con `GetMetricData`, gia' aggregate da CloudWatch per fascia:
//    `Invocations` e `Errors` (somma), `Duration` di solito e nei giorni lenti (p50 e p90) per fascia, e
//    le stesse due sulla finestra intera (per la tabella: la mediana delle mediane non e' la mediana).
//    Sei metriche a funzione, fino a 500 in una chiamata sola.
//  · ECS RunTask: un task = un log stream, e `DescribeLogStreams` ne da' inizio e fine senza leggere una
//    riga (`firstEventTimestamp`, `lastEventTimestamp`). Dal piu' recente, a pagine da 50, finche' si
//    resta nella finestra, con un tetto per cron. L'exit code sta nell'API ECS, che dimentica i task dopo
//    un'ora: l'esito si legge dal LOG della corsa, con la stessa ricerca di un errore che usa l'elenco
//    delle corse (`anyFailure`, `FilterLogEvents` con `limit: 1` sullo stream di quella corsa). Una
//    corsa finita non cambia piu': il suo esito si tiene in memoria e non si rilegge. Prima del log
//    vale il codice d'uscita, quando l'API ECS l'ha dato a qualcuno nella prima ora (la lista delle
//    corse e il giro del canvas Slack lo annotano in `esitiEcs`): e' l'unico modo di vedere un container
//    ucciso per memoria finita, che non scrive errori. Quella memoria si svuota a ogni riavvio: fra il
//    codice d'uscita e il log vale il BATTITO, la metrica di successo che il cron scrive da se' e che il
//    suo allarme guarda (server/battitoCron.js), e che un riavvio non cancella. Senza nessuno dei due,
//    «nessun errore nel log» vale riuscita. Al piu'
//    `SCANSIONI_PER_CRON` corse nuove a cron per giro, dalla piu' recente: le altre restano «esito non
//    letto» (MAI riuscite per omissione) fino ai giri dopo.
//
// COSTO DI UN GIRO (prezzi CloudWatch di listino, ottobre 2026):
//  · `GetMetricData` si paga a metrica chiesta, $0,01 ogni 1.000: con 40 Lambda sono 240 metriche, una
//    chiamata per account, $0,0024 a giro. Con la cache di dieci minuti e la pagina aperta tutto il
//    giorno (il polling si ferma a scheda nascosta) sono al massimo 144 giri, $0,35 al giorno per
//    account; aperta un'ora al giorno, un paio di centesimi al mese.
//  · `DescribeLogStreams` e `DescribeLogGroups` non si pagano a metrica: al piu' rientrano nelle «altre
//    richieste API» ($0,01 ogni 1.000, il primo milione al mese gratis), cioe' zero. Un job giornaliero
//    costa una pagina sola; uno orario su trenta giorni quindici, e sopra il tetto ci si ferma.
//  · Task definition e retention dei log group stanno in cache per un'ora: non cambiano a ogni giro.
//  · `FilterLogEvents` per l'esito delle corse ECS non si paga a dato letto (lo fa Logs Insights, non
//    questa API): una chiamata o poche pagine per corsa, una volta sola per corsa grazie alla memoria.
// Il vincolo vero degli stream non e' il prezzo, e' la quota (25 richieste al secondo per account, 5 per
// `FilterLogEvents`): per questo si leggono quattro cron alla volta e c'e' il tetto di scansioni.
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { CloudWatchLogsClient, DescribeLogStreamsCommand, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'
import { listCrons } from './crons.js'
import { anyFailure, esitiEcs, leggiTaskDef, runsFromStreams } from './runs.js'
import { esitiDaBattito, leggiBattiti } from './battitoCron.js'
import { awslogsFromTaskDef } from './logs.js'
import { espandiCron, cadenzaRate, safeTz, zoneFields } from './util/nextrun.js'
import { griglia, quantile, riassunto } from '../shared/tempiSerie.js'
import { quantilePesato } from '../shared/cronSerie.js'
import { swrMemo } from './util/swr.js'
import { cached } from './util/ttlcache.js'
import { mapLimit } from './util/pool.js'
import { log } from './log.js'

const MIN = 60_000
const ORA = 60 * MIN
const GIORNO = 24 * ORA

export const GIORNI_STORICO_CRON = [7, 30]
// Uno scatto conta come «saltato» solo dopo questa grazia: la metrica di Lambda arriva in un paio di
// minuti, e il primo rigo di log di un task ECS dopo il pull dell'immagine. Prima, non e' ancora tardi.
const GRAZIA_MS = 15 * MIN
// Un task ECS che parte un po' prima dello scatto (orologi, avvio anticipato) e' ancora quella corsa.
const ANTICIPO_MS = 2 * MIN
// Pagine di stream per cron (50 l'una): 500 corse. Copre un job orario per tre settimane; oltre si dice
// fin dove arriva lo storico, e le fasce piu' vecchie restano vuote invece di dire «nessuna corsa».
const MAX_PAGINE_STREAM = 10
const METRICHE_PER_CHIAMATA = 500

// Le fasce della finestra nel FUSO di chi guarda: il grafico dice «martedi'», e martedi' e' quello del
// browser, non quello del server (in un container e' UTC). Stessa regola di `griglia` in
// shared/tempiSerie.js (mezzanotte, o multipli di sei ore sulla settimana; l'ultima fascia contiene
// adesso), calcolata con i campi dell'orologio locale invece che con l'ora del processo. Senza un fuso
// valido si ricade su `griglia`, cioe' sull'ora del server. Pura.
export function grigliaFuso({ giorni = 7, ora = Date.now(), tz = null } = {}) {
  const z = safeTz(tz)
  if (!z) return griglia({ giorni, ora })
  const passoMs = giorni <= 7 ? 6 * ORA : GIORNO
  const f = zoneFields(new Date(ora), z)
  const dallaMezzanotte = (f.hour * 60 + f.minute) * MIN + (ora % MIN)
  const fine = ora - (dallaMezzanotte % passoMs) + passoMs
  const punti = Math.round((giorni * GIORNO) / passoMs)
  return { inizio: fine - punti * passoMs, passoMs, punti }
}

const vuote = (g, v = null) => Array.from({ length: g.punti }, () => v)
const fasciaDi = (t, g) => Math.floor((t - g.inizio) / g.passoMs)

// Le sei metriche di ogni funzione, come query di `GetMetricData`. L'Id deve iniziare con una lettera
// minuscola e restare unico nella chiamata: `f<indice><metrica>`. Pura.
export const METRICHE_LAMBDA = [
  { id: 'n', nome: 'Invocations', stat: 'Sum' },
  { id: 'e', nome: 'Errors', stat: 'Sum' },
  { id: 'm', nome: 'Duration', stat: 'p50' },
  { id: 's', nome: 'Duration', stat: 'p90' },
  // Sulla finestra intera: un periodo solo, lungo quanto la finestra.
  { id: 'w', nome: 'Duration', stat: 'p50', finestra: true },
  { id: 'x', nome: 'Duration', stat: 'p90', finestra: true },
]

export function queryLambda(funzioni = [], g, { finestra = true } = {}) {
  return funzioni.flatMap((fn, i) =>
    METRICHE_LAMBDA.filter((m) => finestra || !m.finestra).map((m) => ({
      Id: `f${i}${m.id}`,
      ReturnData: true,
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: m.nome, Dimensions: [{ Name: 'FunctionName', Value: fn }] },
        // La fascia e' un multiplo di 300 secondi, e la finestra (7 o 30 giorni) di 3600: sono le
        // granularita' che CloudWatch pretende per dati vecchi di 15 e 63 giorni. Un periodo che non le
        // rispetta non da' errore, torna vuoto (vedi `periodFor` in runtime/cw.js).
        Period: Math.round((m.finestra ? g.punti * g.passoMs : g.passoMs) / 1000),
        Stat: m.stat,
      },
    })),
  )
}

// I risultati di `GetMetricData` (anche di piu' chiamate, concatenati) → una serie per funzione, nelle
// fasce di `g`. Una fascia senza punti di `Invocations` e' zero corse (Lambda non pubblica lo zero);
// una senza `Duration` e' una durata che non si sa, null. Pura.
export function serieLambda(risultati = [], n, g) {
  const fuori = Array.from({ length: n }, () => ({ corse: vuote(g, 0), fallite: vuote(g, 0), p50: vuote(g), p90: vuote(g), finestra: { p50: null, p90: null } }))
  const CAMPO = { n: 'corse', e: 'fallite', m: 'p50', s: 'p90' }
  for (const r of risultati) {
    const m = /^f(\d+)([a-z])$/.exec(r.Id ?? '')
    if (!m || !fuori[m[1]]) continue
    const s = fuori[m[1]]
    const valori = r.Values ?? []
    ;(r.Timestamps ?? []).forEach((ts, k) => {
      const v = valori[k]
      if (!Number.isFinite(v)) return
      if (m[2] === 'w') s.finestra.p50 = Math.round(v)
      else if (m[2] === 'x') s.finestra.p90 = Math.round(v)
      else {
        // Un secondo di margine: il timestamp di un punto e' l'inizio della sua fascia.
        const i = fasciaDi(new Date(ts).getTime() + 1000, g)
        if (i < 0 || i >= g.punti || !CAMPO[m[2]]) return
        s[CAMPO[m[2]]][i] = Math.round(v)
      }
    })
  }
  return fuori
}

// Le corse ATTESE per fascia, dallo schedule. `null` dove non si sa: uno schedule che non si espande
// (L/W/#), una fascia che un `rate(...)` non divide esatta, la fascia in corso per un rate (non si sa
// dove cade il prossimo scatto). Uno zero vuol dire «non doveva partire», ed e' un'altra cosa. Pura.
export function attesePerFascia(cron, g, { ora = Date.now() } = {}) {
  const rate = cadenzaRate(cron.scheduleExpr)
  if (rate) {
    if (g.passoMs % rate) return { attese: vuote(g), scatti: null }
    return { attese: vuote(g, g.passoMs / rate).map((v, i) => (g.inizio + (i + 1) * g.passoMs > ora - GRAZIA_MS ? null : v)), scatti: null }
  }
  const scatti = espandiCron(cron.scheduleExpr, g.inizio, Math.min(ora - GRAZIA_MS, g.inizio + g.punti * g.passoMs), cron.scheduleTz)
  if (!scatti) return { attese: vuote(g), scatti: null }
  const attese = vuote(g, 0)
  for (const t of scatti) attese[fasciaDi(t, g)] += 1
  return { attese, scatti }
}

// Da dove in poi si contano le saltate: dalla fascia della prima corsa vista. Lo schedule non dice
// quando il cron e' stato creato, e un cron nato la settimana scorsa avrebbe tre settimane di «saltate»
// che non sono mai state dovute. Un cron senza nemmeno una corsa nella finestra invece le conta tutte:
// non e' mai partito, ed e' proprio la risposta che si cerca. Pura.
const primaFascia = (corse) => {
  const i = corse.findIndex((v) => v > 0)
  return i < 0 ? 0 : i
}

// Saltate per CONTEGGIO: attese meno fatte, fascia per fascia. Per Lambda e per i `rate(...)`, dove si
// sa quante corse ci sono state ma non quando. Le ripetizioni di un'invocazione fallita (EventBridge
// ritenta due volte) contano come corse: in una fascia con un fallimento ritentato una saltata si puo'
// nascondere, mai inventare. Pura.
export function saltatePerConteggio(attese, corse) {
  const da = primaFascia(corse)
  return attese.map((a, i) => (a == null || corse[i] == null || i < da ? null : Math.max(0, a - corse[i])))
}

// Saltate per SCATTO: ogni scatto atteso e' coperto se una corsa e' partita fra lui (meno l'anticipo) e
// lo scatto dopo. Per ECS, dove l'inizio di ogni corsa si sa: contare per fascia sbaglierebbe ogni volta
// che uno scatto delle 23:59 parte alle 00:01, una saltata ieri e una corsa in piu' oggi. `inizi` in
// ordine crescente. Pura.
export function saltatePerScatto(scatti, inizi, corse, g, { coperto = vuote(g, true) } = {}) {
  const da = primaFascia(corse)
  const fuori = corse.map((c, i) => (c == null || !coperto[i] || i < da ? null : 0))
  let j = 0
  scatti.forEach((t, k) => {
    const fino = (scatti[k + 1] ?? t + 6 * ORA) - ANTICIPO_MS
    while (j < inizi.length && inizi[j] < t - ANTICIPO_MS) j++
    if (j < inizi.length && inizi[j] < fino) return void j++
    const i = fasciaDi(t, g)
    if (fuori[i] != null) fuori[i] += 1
  })
  return fuori
}

// La riga di un cron Lambda, dalle sue serie. Pura: la usa anche la demo.
export function rigaLambda(cron, s, g, { ora = Date.now(), rilascio = null } = {}) {
  const { attese } = cron.enabled ? attesePerFascia(cron, g, { ora }) : { attese: vuote(g) }
  const ultima = s.corse.reduce((u, v, i) => (v > 0 ? i : u), -1)
  const riuscite = s.corse.map((c, i) => Math.max(0, c - s.fallite[i]))
  // Le metriche dicono la fascia, non l'istante: il fallimento si mette alla FINE della sua fascia e la
  // riuscita all'INIZIO della sua, cosi' un rilascio dentro la stessa fascia non passa per una correzione.
  const ultimaKo = s.fallite.reduce((u, v, i) => (v > 0 ? i : u), -1)
  const ultimaOk = riuscite.reduce((u, v, i) => (v > 0 ? i : u), -1)
  const n = s.corse.reduce((a, b) => a + b, 0)
  // Senza le metriche sulla finestra, la stima dalle fasce: ogni fascia pesa quante corse ha avuto.
  const pesata = (valori, q) => quantilePesato(valori.map((v, i) => ({ v, w: s.corse[i] })), q)
  const finestra = s.finestra.p50 != null ? { ...s.finestra, n } : s.p50.some(Number.isFinite) ? { p50: pesata(s.p50, 0.5), p90: pesata(s.p90, 0.9), n } : null
  return {
    ...base(cron),
    fonte: 'metriche',
    esitoLetto: true,
    corse: s.corse,
    riuscite,
    fallite: s.fallite,
    nonLette: vuote(g, 0),
    saltate: saltatePerConteggio(attese, s.corse),
    p50: s.p50,
    p90: s.p90,
    finestra,
    // Dalle metriche si sa la FASCIA dell'ultima corsa, non l'ora: si dice la fascia.
    ultima: ultima >= 0 ? { t: g.inizio + ultima * g.passoMs, esatta: false } : null,
    rilascio,
    ultimaFallita: ultimaKo >= 0 ? Math.min(ora, g.inizio + (ultimaKo + 1) * g.passoMs) : null,
    ultimaRiuscita: ultimaOk >= 0 ? g.inizio + ultimaOk * g.passoMs : null,
  }
}

// La riga di un cron ECS, dagli stream letti. `copertoDa` = da quando in poi lo storico e' completo
// (retention dei log, o tetto di pagine): le fasce che cominciano prima restano null. Pura.
// Ogni corsa puo' portare `esito` ('ok' | 'ko', dal suo log): senza, e' «esito non letto».
export function rigaEcs(cron, corseLette, g, { ora = Date.now(), copertoDa = null, troncato = false, rilascio = null } = {}) {
  const coperto = Array.from({ length: g.punti }, (_, i) => copertoDa == null || g.inizio + i * g.passoMs >= copertoDa)
  const fasce = Array.from({ length: g.punti }, () => [])
  for (const r of corseLette) {
    const i = fasciaDi(r.startedAt, g)
    if (i >= 0 && i < g.punti) fasce[i].push(r)
  }
  const durate = (f) => f.map((r) => (r.endedAt != null ? r.endedAt - r.startedAt : null))
  const corse = fasce.map((f, i) => (coperto[i] ? f.length : null))
  const nelleFasce = fasce.filter((_, i) => coperto[i]).flat()
  let saltate = vuote(g)
  if (cron.enabled) {
    const { attese, scatti } = attesePerFascia(cron, g, { ora })
    saltate = scatti
      ? saltatePerScatto(scatti, nelleFasce.map((r) => r.startedAt).sort((a, b) => a - b), corse, g, { coperto })
      : saltatePerConteggio(attese, corse)
  }
  const ultima = nelleFasce.reduce((u, r) => Math.max(u, r.startedAt), -Infinity)
  const tutte = riassunto(durate(nelleFasce))
  const conta = (esito) => fasce.map((f, i) => (coperto[i] ? f.filter((r) => (esito ? r.esito === esito : r.esito !== 'ok' && r.esito !== 'ko')).length : null))
  const riuscite = conta('ok')
  const fallite = conta('ko')
  const ultimaCon = (esito, campo) => nelleFasce.filter((r) => r.esito === esito).reduce((u, r) => Math.max(u, campo(r)), -Infinity)
  // Il fallimento conta da quando la corsa e' FINITA, la riuscita da quando e' PARTITA: una corsa partita
  // prima del rilascio non prova la versione nuova.
  const ultimaKo = ultimaCon('ko', (r) => r.endedAt ?? r.startedAt)
  const ultimaOk = ultimaCon('ok', (r) => r.startedAt)
  return {
    ...base(cron),
    fonte: 'log',
    // L'esito viene dal log della corsa; una corsa che non si e' ancora potuta leggere e' «non letta»,
    // ne' riuscita ne' fallita: grigia nel grafico, fuori dalla percentuale delle riuscite.
    esitoLetto: nelleFasce.some((r) => r.esito === 'ok' || r.esito === 'ko'),
    corse,
    riuscite,
    fallite,
    nonLette: conta(null),
    saltate,
    p50: fasce.map((f, i) => (coperto[i] ? quantile(durate(f), 0.5) : null)),
    p90: fasce.map((f, i) => (coperto[i] ? quantile(durate(f), 0.9) : null)),
    finestra: tutte,
    ultima: Number.isFinite(ultima) ? { t: ultima, esatta: true } : null,
    copertoDa: copertoDa != null && copertoDa > g.inizio ? copertoDa : null,
    troncato,
    rilascio,
    ultimaFallita: Number.isFinite(ultimaKo) ? ultimaKo : null,
    ultimaRiuscita: Number.isFinite(ultimaOk) ? ultimaOk : null,
  }
}

function base(cron) {
  return { k: cron.key, nome: cron.name, account: cron.account, tipo: cron.type === 'lambda' ? 'lambda' : 'ecs', acceso: cron.enabled !== false, errore: null }
}

// Una riga che non si e' potuta leggere: le serie vuote (null, non zero) e il motivo. Pura.
export function rigaIllegibile(cron, g, errore) {
  const n = vuote(g)
  return { ...base(cron), fonte: cron.type === 'lambda' ? 'metriche' : 'log', esitoLetto: cron.type === 'lambda', corse: n, riuscite: n, fallite: n, nonLette: n, saltate: n, p50: n, p90: n, finestra: null, ultima: null, errore }
}

// La risposta intera, dalle righe. Un cron spento e senza corse nella finestra non ha niente da
// raccontare, e una riga di zeri in tabella si leggerebbe come un guasto. Pura.
export function rispostaStorico({ giorni, g, righe, account }) {
  const conCorse = (r) => r.corse.some((v) => v > 0)
  return {
    giorni,
    inizio: g.inizio,
    passoMs: g.passoMs,
    punti: g.punti,
    account,
    crons: righe.filter((r) => r.acceso || conCorse(r) || r.errore).sort((a, b) => a.nome.localeCompare(b.nome) || String(a.account).localeCompare(String(b.account))),
    generatedAt: Date.now(),
  }
}

// ── Letture AWS ──────────────────────────────────────────────────────────────────────────────────

// Le metriche di tutte le Lambda di un account, a blocchi da 500 query, seguendo `NextToken`.
// Le due metriche sulla finestra intera hanno un periodo di 7 o 30 giorni: se CloudWatch lo rifiutasse,
// si rilegge senza, e la durata della finestra la stima `rigaLambda` dalle fasce. Meglio una stima che
// un account intero senza storico.
async function metricheLambda(aws, funzioni, g) {
  try {
    return await leggiMetriche(aws, funzioni, g, { finestra: true })
  } catch (err) {
    if (!/Validation|InvalidParameter/i.test(`${err?.name ?? ''} ${err?.Code ?? ''}`)) throw err
    log.warn('storico cron: metriche sulla finestra rifiutate, rilette senza', { err: err.message })
    return leggiMetriche(aws, funzioni, g, { finestra: false })
  }
}

async function leggiMetriche(aws, funzioni, g, { finestra }) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const query = queryLambda(funzioni, g, { finestra })
  const risultati = []
  for (let i = 0; i < query.length; i += METRICHE_PER_CHIAMATA) {
    let NextToken
    do {
      const r = await cw.send(
        new GetMetricDataCommand({
          MetricDataQueries: query.slice(i, i + METRICHE_PER_CHIAMATA),
          StartTime: new Date(g.inizio),
          EndTime: new Date(g.inizio + g.punti * g.passoMs),
          NextToken,
        }),
      )
      // Con piu' pagine la stessa query torna a pezzi: si uniscono i punti per Id.
      risultati.push(...(r.MetricDataResults ?? []))
      NextToken = r.NextToken
    } while (NextToken)
  }
  return serieLambda(risultati, funzioni.length, g)
}

// La retention del log group, in cache: le fasce piu' vecchie non hanno piu' stream, e senza saperlo
// si leggerebbero come «nessuna corsa» e quindi come saltate.
function retentionGiorni(logs, aws, logGroup) {
  return cached(`retention:${aws?.roleArn ?? aws?.profile ?? 'default'}:${logGroup}`, ORA, async () => {
    const r = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroup, limit: 5 }))
    return (r.logGroups ?? []).find((x) => x.logGroupName === logGroup)?.retentionInDays ?? null
  })
}

// Gli stream di un job ECS dal piu' recente, finche' si resta nella finestra. Pagina dopo pagina perche'
// l'ordine per ultimo evento garantisce una cosa sola: tutto quello che ha scritto DOPO l'ultimo stream
// letto e' gia' arrivato. Col tetto, `copertoDa` e' quell'istante. Esportata per i test.
export async function streamDelJob(logs, logGroup, { da, maxPagine = MAX_PAGINE_STREAM } = {}) {
  const streams = []
  let nextToken
  let pagine = 0
  let piuVecchio = Infinity
  do {
    const r = await logs.send(new DescribeLogStreamsCommand({ logGroupName: logGroup, orderBy: 'LastEventTime', descending: true, limit: 50, nextToken }))
    const pagina = r.logStreams ?? []
    streams.push(...pagina)
    pagine++
    for (const s of pagina) if (Number.isFinite(s.lastEventTimestamp)) piuVecchio = Math.min(piuVecchio, s.lastEventTimestamp)
    nextToken = r.nextToken
    if (!pagina.length || piuVecchio < da) return { streams, copertoDa: null, troncato: false, pagine }
  } while (nextToken && pagine < maxPagine)
  return { streams, copertoDa: nextToken ? piuVecchio : null, troncato: Boolean(nextToken), pagine }
}

// L'esito delle corse ECS, dal loro log. In memoria per sempre (con un tetto), perche' una corsa finita
// non cambia: dopo il primo giro si leggono solo le corse nuove.
const esitiCorse = new Map()
const MAX_ESITI = 20_000
export const SCANSIONI_PER_CRON = 30
// Una corsa finita da poco puo' ancora scrivere l'ultima riga di un traceback: si aspetta prima di
// deciderne l'esito, altrimenti resterebbe «riuscita» in memoria per sempre.
const ASSESTAMENTO_MS = 5 * 60_000

// `noti` = gli esiti dal battito del cron (server/battitoCron.js), per stream: vengono dopo il codice
// d'uscita, che e' certo, e prima del log, che e' una deduzione. Non si tengono in memoria come quelli
// del log: l'ultima corsa puo' passare da «non si sa» a riuscita al giro dopo.
export async function conEsito(logs, logGroup, corse, ora = Date.now(), { cerca = anyFailure, tetto = SCANSIONI_PER_CRON, noti = null } = {}) {
  let letti = 0
  const out = []
  for (const r of corse) {
    const k = `${logGroup}|${r.stream}`
    // Prima l'esito certo dell'API ECS (codice d'uscita, OOM), se qualcuno l'ha letto mentre il task
    // c'era: vince anche su un esito dal log gia' in memoria, che senza errori diceva «riuscita».
    if (esitiEcs.has(k)) {
      out.push({ ...r, esito: esitiEcs.get(k), fonteEsito: 'ecs' })
      continue
    }
    if (noti?.has(r.stream)) {
      out.push({ ...r, esito: noti.get(r.stream), fonteEsito: 'battito' })
      continue
    }
    if (esitiCorse.has(k)) {
      out.push({ ...r, esito: esitiCorse.get(k) })
      continue
    }
    const finita = r.endedAt != null && ora - r.endedAt > ASSESTAMENTO_MS
    if (!r.stream || !finita || letti >= tetto) {
      out.push(r)
      continue
    }
    letti++
    try {
      const fallita = await cerca(logs, { logGroupName: logGroup, logStreamNames: [r.stream], startTime: r.startedAt, endTime: r.endedAt + 60_000 })
      const esito = fallita ? 'ko' : 'ok'
      esitiCorse.set(k, esito)
      if (esitiCorse.size > MAX_ESITI) esitiCorse.delete(esitiCorse.keys().next().value)
      out.push({ ...r, esito })
    } catch {
      // Quota o permesso: la corsa resta «non letta», e il giro dopo ci riprova.
      out.push(r)
    }
  }
  return out
}

async function rigaDaLog(cron, aws, g, ora, battito = null) {
  const { td } = await leggiTaskDef(aws, cron.taskDefinition)
  const { logGroup, streamPrefix, container } = awslogsFromTaskDef(td, cron.container)
  if (!logGroup) return rigaIllegibile(cron, g, 'senza log group')
  const logs = new CloudWatchLogsClient(clientOpts(aws))
  const [letti, retention] = await Promise.all([streamDelJob(logs, logGroup, { da: g.inizio }), retentionGiorni(logs, aws, logGroup).catch(() => null)])
  const lette = runsFromStreams(letti.streams, { streamPrefix, container, since: g.inizio })
  const noti = battito ? esitiDaBattito(lette, battito, { ora, cadenzaMs: (cron.scheduleMinutes ?? 0) * MIN }) : null
  const corse = await conEsito(logs, logGroup, lette, ora, { noti })
  const daRetention = retention ? ora - retention * GIORNO : null
  const copertoDa = Math.max(letti.copertoDa ?? -Infinity, daRetention ?? -Infinity)
  // La revision della task definition e' il rilascio: la registra ogni deploy del job.
  const rilascio = td?.registeredAt ? new Date(td.registeredAt).getTime() : null
  return rigaEcs(cron, corse, g, { ora, copertoDa: Number.isFinite(copertoDa) ? copertoDa : null, troncato: letti.troncato, rilascio })
}

// Quando e' stata rilasciata l'ultima volta ogni Lambda: `LastModified` di `ListFunctions`, una pagina
// ogni cinquanta funzioni per account. Serve solo a dire «rilasciato dopo il guasto», quindi un errore
// (permesso, quota) non toglie lo storico: toglie quello stato, e la riga resta rossa.
function rilasciLambda(aws) {
  return cached(`rilasci-lambda:${aws?.roleArn ?? aws?.profile ?? 'default'}:${aws?.region ?? ''}`, 5 * MIN, async () => {
    const client = new LambdaClient(clientOpts(aws))
    const fuori = new Map()
    let Marker
    do {
      const r = await client.send(new ListFunctionsCommand({ Marker, MaxItems: 50 }))
      for (const f of r.Functions ?? []) {
        const t = f.LastModified ? new Date(f.LastModified).getTime() : NaN
        if (Number.isFinite(t)) fuori.set(f.FunctionName, t)
      }
      Marker = r.NextMarker
    } while (Marker)
    return fuori
  }).catch((err) => {
    log.warn('storico cron: rilasci delle Lambda non letti', { err: err.message })
    return new Map()
  })
}

// Lo storico di tutti gli account. Non lancia per un account o un cron: lo dice nella sua riga.
// `leggiCron` e' il registro dei cron (server/crons.js, dalla sua cache): i test ne passano uno finto.
export async function leggiStoricoCron(accounts, { giorni = 7, tz = null, t = (k) => k, ora = Date.now(), leggiCron = listCrons } = {}) {
  const g = grigliaFuso({ giorni, ora, tz })
  const { crons, problems } = await leggiCron(accounts, { t })
  const account = {}
  for (const [k, a] of Object.entries(accounts ?? {})) account[k] = { label: a.label ?? k }
  for (const p of problems) account[p.account] = { ...(account[p.account] ?? { label: p.account }), error: p.error }

  const perGruppo = new Map()
  for (const c of crons) {
    const a = accounts[c.account] ?? {}
    const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: c.region ?? a.region }
    const k = `${c.account}|${aws.region ?? ''}`
    if (!perGruppo.has(k)) perGruppo.set(k, { aws, account: c.account, lambda: [], ecs: [] })
    perGruppo.get(k)[c.type === 'lambda' ? 'lambda' : 'ecs'].push(c)
  }

  const righe = []
  await Promise.all(
    [...perGruppo.values()].map(async ({ aws, account: acc, lambda, ecs }) => {
      if (lambda.length) {
        try {
          const [serie, rilasci] = await Promise.all([metricheLambda(aws, lambda.map((c) => c.function), g), rilasciLambda(aws)])
          lambda.forEach((c, i) => righe.push(rigaLambda(c, serie[i], g, { ora, rilascio: rilasci.get(c.function) ?? null })))
        } catch (err) {
          const errore = cleanAwsReason(err, t)
          account[acc] = { ...(account[acc] ?? { label: acc }), error: errore }
          for (const c of lambda) righe.push(rigaIllegibile(c, g, errore))
        }
      }
      // I battiti dei cron ECS dell'account, in una chiamata: l'esito che un riavvio non cancella.
      const battiti = ecs.length ? await leggiBattiti(aws, ecs, { da: g.inizio, a: ora }) : new Map()
      righe.push(
        ...(await mapLimit(ecs, 4, async (c) => {
          try {
            return await rigaDaLog(c, aws, g, ora, battiti.get(c.key) ?? null)
          } catch (err) {
            return rigaIllegibile(c, g, cleanAwsReason(err, t))
          }
        })),
      )
    }),
  )
  return rispostaStorico({ giorni, g, righe, account })
}

// Dieci minuti: e' uno storico per giorno, e un giro in piu' non cambia una colonna. La chiave porta il
// fuso, perche' le fasce si allineano alla mezzanotte di chi guarda.
const memo = swrMemo({
  ttlMs: Number(process.env.DADAGUARD_CRON_STORICO_TTL_MS) || 10 * MIN,
  onError: (err, key) => log.error('storico cron: rinfresco in background fallito', { key, err: err.message }),
})

export const giorniStorico = (v) => (GIORNI_STORICO_CRON.includes(Number(v)) ? Number(v) : 7)

// La lingua sta nella chiave perche' i motivi degli errori sono gia' tradotti (`cleanAwsReason`).
export function storicoCron(accounts, { giorni, tz, t, lang = '' } = {}) {
  const z = safeTz(tz)
  return memo(`cron-storico:${giorni}:${z ?? ''}:${lang}`, () => leggiStoricoCron(accounts, { giorni, tz: z, t }))
}
