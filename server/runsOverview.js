// La vista «esecuzioni»: il registro dei cron (server/crons.js) più le run di ognuno (server/runs.js),
// più le run dell'orchestratore se configurato (server/prefect.js). È l'unico posto che mette insieme
// le tre sorgenti, e lo fa con un vocabolario solo (`outcome` ∈ running|ok|failed|cancelled|unknown),
// perché chi guarda ha una domanda sola e non gliene importa da quale API arriva la risposta.
//
// Costo tenuto a bada, che qui è la differenza fra una vista utile e una che nessuno apre:
//  · TTL breve sulla risposta intera: tre persone che guardano la pagina insieme fanno UN giro di
//    chiamate, non tre. E a scadenza il dato vecchio si consegna subito e si rinfresca dietro
//    (util/swr.js): un giro costa ~21 secondi, e la cache che bloccava li faceva pagare a chi apriva;
//  · poche run per cron nella vista d'insieme (`limit`), storico profondo solo quando apri UN cron;
//  · la scansione degli errori nei log è per le run in cima, non per tutte (vedi `scanFailures`).
import { listCrons } from './crons.js'
import { cronRuns } from './runs.js'
import { prefectRuns } from './prefect.js'
import { cleanAwsReason } from './runtime/awsClient.js'
import { swrMemo } from './util/swr.js'
import { log } from './log.js'
import { mapLimit } from './util/pool.js'

const TTL_MS = Number(process.env.DADAGUARD_RUNS_TTL_MS) || 45_000
const memo = swrMemo({
  ttlMs: TTL_MS,
  onError: (err, key) => log.error('runs: rinfresco in background fallito', { key, err: err.message }),
})
const MAX_CRONS = 40 // oltre, non è una pagina: è una scansione. Si dice che è troncata, e di quanto.

// La ricerca arriva dalla casella della pagina: minuscola, senza spazi ai bordi, e corta. Ogni testo
// diverso è una chiave della cache, quindi una stringa lunga a piacere sarebbe memoria a piacere. Pura.
export function normQuery(q) {
  return String(q ?? '').trim().toLowerCase().slice(0, 64)
}

// QUALI cron leggere in questo giro, prima di spendere una sola chiamata ai log. Pura/testabile.
//
// Il filtro di ricerca sta QUI e non nella pagina: filtrare nel browser cercava solo fra i cron già
// letti, e oltre il tetto un cron vero (girato tre volte al giorno) risultava «Nessuna esecuzione».
// Si cerca anche su chiave, family e funzione, perché il nome che uno conosce è spesso quello del job
// e non quello dello schedule.
//
// Il tetto vale solo per i cron ACCESI: uno spento non costa chiamate (runsOverview non lo interroga),
// quindi tagliarlo non risparmiava niente e toglieva solo una riga vera. Fra gli accesi l'ordine resta
// quello per nome di listCrons: `nextRunAt` è disponibile ma non dice quale conta di più, e ordinare
// per «parte prima» farebbe entrare e uscire cron diversi a ogni giro, con la lista che cambia sotto
// gli occhi di chi la guarda. Un taglio fisso e dichiarato si capisce, uno che ruota no.
export function scegliCron(crons = [], { only = null, q = '', max = MAX_CRONS } = {}) {
  const cerca = normQuery(q)
  const trovato = (c) => !cerca || [c.name, c.key, c.family, c.function].some((v) => String(v ?? '').toLowerCase().includes(cerca))
  const wanted = crons.filter((c) => (!only || c.key === only) && trovato(c))
  const accesi = wanted.filter((c) => c.enabled)
  const spenti = wanted.filter((c) => !c.enabled)
  const lista = [...accesi.slice(0, max), ...spenti]
  return { lista, totale: wanted.length, troncata: accesi.length > max }
}

// Ordine della lista: prima chi sta girando ADESSO, poi chi ha appena fallito, poi per ultima run.
// È l'ordine in cui si cercano le cose in questa pagina. Puro/testabile.
export function sortCrons(a, b) {
  const rank = (c) => (c.running > 0 ? 0 : c.lastOutcome === 'failed' ? 1 : 2)
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  return (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0)
}

// Riassunto per-cron dalle sue run. Puro/testabile: la UI non deve ricontare niente.
export function summarize(cron, runs = []) {
  const last = runs.find((r) => !r.running) ?? null
  return {
    ...cron,
    runs,
    running: runs.filter((r) => r.running).length,
    // NON «fallite nelle 24h»: sono le fallite fra le run MOSTRATE (la finestra letta è
    // dimensionata sulla cadenza del cron, vedi windowForRuns). Un nome che promette di più del dato
    // è il modo più rapido di far leggere un numero come un altro.
    failedShown: runs.filter((r) => r.outcome === 'failed').length,
    lastOutcome: last?.outcome ?? (runs.length ? 'running' : null),
    lastRunAt: runs[0]?.startedAt ?? null,
  }
}

// Le opzioni oltre a quelle della pagina servono al canvas delle corse in Slack (server/notify/corse.js),
// che vuole TUTTI i cron e non i primi 40, ma costando poco:
//   max          il tetto dei cron accesi letti (default `MAX_CRONS`, quello della pagina)
//   scan         per quante corse di ogni cron si cercano gli errori nei log (default 4 nella vista
//                d'insieme): al canvas serve solo l'ultima finita
//   concorrenza  quanti cron si leggono insieme (default 6): il canvas ne usa meno, per lasciare la
//                quota di CloudWatch Logs alla pagina che qualcuno sta guardando
//   fresh        aspetta un giro nuovo invece di servire quello in cache (vedi util/swr.js): il canvas
//                si aggiorna ogni pochi minuti, e con la cache che consegna il dato vecchio sarebbe
//                sempre indietro di un giro
//   prefect      `false` per non leggere l'orchestratore, che il canvas non mostra
// Tutte stanno nella chiave della cache, quindi il giro del canvas non tocca quello della pagina.
export async function runsOverview(
  accounts,
  { minutes = 1440, limit = 6, only = null, q = '', t = (k) => k, max = MAX_CRONS, scan = null, concorrenza = 6, fresh = false, prefect = true } = {},
) {
  const cerca = normQuery(q)
  // La ricerca è nella chiave: due ricerche diverse leggono cron diversi, e la stessa cache le
  // confonderebbe. Senza ricerca la chiave termina con `:` vuoto, la stessa della scaldata all'avvio.
  // Le opzioni del canvas si aggiungono solo quando ci sono: la chiave della pagina resta quella di prima.
  const extra = max !== MAX_CRONS || scan != null || !prefect ? `:${max}:${scan ?? ''}:${prefect ? 1 : 0}` : ''
  const key = `runs:${only ?? 'all'}:${minutes}:${limit}:${cerca}${extra}`
  const { value } = await memo(key, async () => {
    const { crons, problems } = await listCrons(accounts, { t })
    const { lista, totale, troncata } = scegliCron(crons, { only, q: cerca, max })

    // Concorrenza 6, non 8: la quota di CloudWatch Logs è ~10 richieste al secondo per account, e sopra
    // quel tetto ogni chiamata in più non è più veloce: è un retry con attesa (misurato: la stessa query
    // passa da 600ms a 4,8s con ventisei richieste insieme).
    const righe = await mapLimit(lista, concorrenza, async (cron) => {
      const a = accounts[cron.account] ?? {}
      const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: cron.region ?? a.region }
      const label = a.label ?? cron.account
      try {
        // Uno schedule DISABLED non si interroga: le sue run sono finite quando è stato spento, e
        // chiedere i log di un cron fermo è un giro di chiamate per una lista vuota. Resta in elenco,
        // marcato spento: sapere che esiste ed è fermo è metà della risposta.
        if (!cron.enabled) return summarize({ ...cron, accountLabel: label, color: a.color ?? null }, [])
        // Vista di UN cron: si è chiesto uno storico profondo, quindi budget di scavo più alto e
        // scansione dell'esito su tutte le run mostrate. Nella vista d'insieme sarebbe lo stesso
        // scavo × trenta cron, per righe che nessuno ha chiesto.
        const out = await cronRuns(cron, aws, {
          minutes,
          limit,
          scanFailures: scan ?? (only ? limit : 4),
          ...(only ? { maxPages: 120 } : {}),
          t,
        })
        return {
          ...summarize({ ...cron, accountLabel: label, color: a.color ?? null }, out.runs ?? []),
          logGroup: out.logGroup ?? null,
          streamPrefix: out.streamPrefix ?? null,
          container: out.container ?? null,
          // Il repository dell'immagine (solo ECS): serve al canvas delle corse per le squadre.
          immagine: out.immagine ?? null,
          apiOnly: out.apiOnly ?? false,
          truncated: out.truncated ?? false,
          error: out.error ?? null,
        }
      } catch (err) {
        return { ...summarize({ ...cron, accountLabel: label, color: a.color ?? null }, []), error: cleanAwsReason(err, t) }
      }
    })

    return {
      window: minutes,
      truncated: troncata,
      // Quanti cron corrispondono in tutto: la pagina dice «letti X di N», non solo «troncata».
      total: totale,
      query: cerca,
      crons: righe.sort(sortCrons),
      problems,
      // Sorgente non configurata → `null`, e la UI non mostra la sezione (non è un errore: è spenta).
      prefect: prefect ? await prefectRuns({ minutes }) : null,
      generatedAt: Date.now(),
    }
  }, { fresh })
  return value
}
