// La vista «esecuzioni»: il registro dei cron (server/crons.js) più le run di ognuno (server/runs.js),
// più le run dell'orchestratore se configurato (server/prefect.js). È l'unico posto che mette insieme
// le tre sorgenti, e lo fa con un vocabolario solo — `outcome` ∈ running|ok|failed|cancelled|unknown —
// perché chi guarda ha una domanda sola e non gliene importa da quale API arriva la risposta.
//
// Costo tenuto a bada, che qui è la differenza fra una vista utile e una che nessuno apre:
//  · TTL breve sulla risposta intera: tre persone che guardano la pagina insieme fanno UN giro di
//    chiamate, non tre;
//  · poche run per cron nella vista d'insieme (`limit`), storico profondo solo quando apri UN cron;
//  · la scansione degli errori nei log è per le run in cima, non per tutte (vedi `scanFailures`).
import { listCrons } from './crons.js'
import { cronRuns } from './runs.js'
import { prefectRuns } from './prefect.js'
import { cleanAwsReason } from './runtime/awsClient.js'
import { cached } from './util/ttlcache.js'
import { mapLimit } from './util/pool.js'

const TTL_MS = Number(process.env.DADAGUARD_RUNS_TTL_MS) || 45_000
const MAX_CRONS = 40 // oltre, non è una pagina: è una scansione. Si dice che è troncata.

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

export async function runsOverview(accounts, { minutes = 1440, limit = 6, only = null, t = (k) => k } = {}) {
  const key = `runs:${only ?? 'all'}:${minutes}:${limit}`
  return cached(key, TTL_MS, async () => {
    const { crons, problems } = await listCrons(accounts, { t })
    const wanted = only ? crons.filter((c) => c.key === only) : crons
    const troncata = wanted.length > MAX_CRONS
    const lista = wanted.slice(0, MAX_CRONS)

    // Concorrenza 6, non 8: la quota di CloudWatch Logs è ~10 richieste al secondo per account, e sopra
    // quel tetto ogni chiamata in più non è più veloce — è un retry con attesa (misurato: la stessa query
    // passa da 600ms a 4,8s con ventisei richieste insieme).
    const righe = await mapLimit(lista, 6, async (cron) => {
      const a = accounts[cron.account] ?? {}
      const aws = { profile: a.profile, roleArn: a.roleArn, externalId: a.externalId, region: cron.region ?? a.region }
      const label = a.label ?? cron.account
      try {
        // Uno schedule DISABLED non si interroga: le sue run sono finite quando è stato spento, e
        // chiedere i log di un cron fermo è un giro di chiamate per una lista vuota. Resta in elenco,
        // marcato spento — sapere che esiste ed è fermo è metà della risposta.
        if (!cron.enabled) return summarize({ ...cron, accountLabel: label, color: a.color ?? null }, [])
        // Vista di UN cron: si è chiesto uno storico profondo, quindi budget di scavo più alto e
        // scansione dell'esito su tutte le run mostrate. Nella vista d'insieme sarebbe lo stesso
        // scavo × trenta cron, per righe che nessuno ha chiesto.
        const out = await cronRuns(cron, aws, {
          minutes,
          limit,
          scanFailures: only ? limit : 4,
          ...(only ? { maxPages: 120 } : {}),
          t,
        })
        return {
          ...summarize({ ...cron, accountLabel: label, color: a.color ?? null }, out.runs ?? []),
          logGroup: out.logGroup ?? null,
          streamPrefix: out.streamPrefix ?? null,
          container: out.container ?? null,
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
      crons: righe.sort(sortCrons),
      problems,
      // Sorgente non configurata → `null`, e la UI non mostra la sezione (non è un errore: è spenta).
      prefect: await prefectRuns({ minutes }),
      generatedAt: Date.now(),
    }
  })
}
