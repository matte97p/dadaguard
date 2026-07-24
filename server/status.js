import { loadConfig } from './config.js'
import { autoDiscoverServices, mergeServices } from './autodiscover.js'
import { resolveOrgAccounts } from './org.js'
import { discoverProfileAccounts } from './awsProfiles.js'
import { cloudflareWorkersStatus, CF_COLOR, shortId } from './cloudflare.js'
import { consoleUrl } from './console.js'
import { MODE, capabilities, autoDiscover, isLocal } from './mode.js'
import { makeT, fmtAgo } from './i18n.js'
import { mapLimit } from './util/pool.js'
import { log } from './log.js'
import { managedResources } from './terraform/state.js'
import { loadSecretsIndex } from './secrets/ssmIndex.js'
import * as liveness from './checks/liveness.js'
import * as version from './checks/version.js'
import * as runtime from './checks/runtime.js'
import * as drift from './checks/drift.js'
import * as secrets from './checks/secrets.js'
import * as security from './checks/security.js'
import * as alarms from './checks/alarms.js'
import * as backups from './checks/backups.js'

// Registro dei check attivi. Aggiungere un segnale = importare il modulo
// e aggiungerlo qui. Ogni modulo espone { key, run(service, ctx) }.
// run() può ritornare null se il segnale non si applica al servizio.
const CHECKS = [liveness, version, runtime, drift, secrets, security, alarms, backups]

// Endpoint pubblico del servizio: l'ORIGINE dell'`healthUrl` dichiarato in config
// (https://api.x.com/health → https://api.x.com). È già in config (il check liveness lo usa) → zero
// chiamate extra. Nessun healthUrl (o URL malformato) → null: l'endpoint si mostra solo "dove possibile".
export function endpointFromHealth(healthUrl) {
  if (!healthUrl) return null
  try {
    return new URL(healthUrl).origin
  } catch {
    return null
  }
}

const SEVERITY = { up: 0, idle: 1, disabled: 1, unknown: 1, degraded: 2, down: 3 }
// Quanti servizi controllare in parallelo: evita di aprire 100+ chiamate AWS insieme (throttling).
const CONCURRENCY = Number(process.env.DADAGUARD_CONCURRENCY) || 8

// A parità di gravità, quale segnale nominare per primo nel badge (dal più "urgente da guardare").
const CAUSE_PRIORITY = ['liveness', 'runtime', 'alarms', 'security', 'secrets', 'drift', 'version', 'backups']
function causeRank(k) {
  const i = CAUSE_PRIORITY.indexOf(k)
  return i === -1 ? CAUSE_PRIORITY.length : i
}

// Semaforo del servizio + PERCHÉ: il check messo peggio determina il colore, e riportiamo QUALI
// check lo causano così il badge non dice solo "ATTENZIONE" ma cosa sta urlando (task giù,
// allarme, drift…). `cause` = il colpevole primario (per priorità), `causes` = tutti allo stesso
// livello. La causa ha senso solo per gli stati "problema"; up/idle/unknown non hanno colpevole.
export function computeOverall(checks) {
  const list = Object.values(checks)
  const overall = list.reduce(
    (worst, c) => (SEVERITY[c.status] > SEVERITY[worst] ? c.status : worst),
    'up',
  )
  const causes =
    overall === 'degraded' || overall === 'down'
      ? list.filter((c) => c.status === overall).map((c) => c.key)
      : []
  const cause = [...causes].sort((a, b) => causeRank(a) - causeRank(b))[0] ?? null
  return { overall, cause, causes }
}

// Risolve la lista EFFETTIVA di account + servizi: config (+ org) e auto-discovery/merge.
// Condivisa tra getStatus e gli endpoint per-servizio (logs/events), così anche i servizi
// SCOPERTI (non in services.yaml) sono risolvibili per nome — altrimenti darebbero 404.
//
// Cache breve: la discovery gira su OGNI endpoint per-servizio (status, logs, events, topology,
// network) → senza cache sono molte chiamate AWS ripetute a ogni refresh (throttling "Rate
// exceeded"). Cachiamo solo QUALI servizi esistono (cambia di rado); i CHECK restano freschi, li
// rifà getStatus a ogni chiamata. Invalidata quando la watchlist viene modificata.
let _resolveCache = null
const RESOLVE_TTL_MS = Number(process.env.DADAGUARD_DISCOVERY_TTL_MS) || 300_000 // 5 min: la lista servizi cambia di rado
export function invalidateServicesCache() {
  _resolveCache = null
}

export async function resolveServices() {
  if (_resolveCache && Date.now() - _resolveCache.at < RESOLVE_TTL_MS) return _resolveCache.value
  const { accounts: declaredAccounts, services: declared, org, discoverAccounts } = loadConfig()
  let accounts = declaredAccounts
  let services = declared

  // #8 AWS Organizations: enumera i membri (ListAccounts) e aggiungili agli account, ciascuno
  // col ruolo read-only assunto cross-account. Se fallisce, logga e prosegue con quelli espliciti.
  if (org) {
    try {
      accounts = { ...accounts, ...(await resolveOrgAccounts(org)) }
    } catch (err) {
      log.error('org: ListAccounts fallita', { err: err.message })
    }
  } else if (isLocal && discoverAccounts !== false) {
    // Zero-config account: in locale (senza `org`) scopri gli account dai profili SSO di `~/.aws/config`.
    // Additiva: i dichiarati vincono (mantengono label/color/region e "coprono" il loro id); i profili
    // restanti diventano account nuovi (es. `security`). Senza account reali dichiarati (path zero-config)
    // la discovery LI SOSTITUISCE al placeholder 'default'. Opt-out: `discoverAccounts: false`.
    try {
      const opts = discoverAccounts && typeof discoverAccounts === 'object' ? discoverAccounts : {}
      const fromProfiles = discoverProfileAccounts(opts)
      const declaredReal = Object.values(declaredAccounts ?? {}).filter((a) => a.accountId || a.profile || a.roleArn)
      if (Object.keys(fromProfiles).length) {
        if (declaredReal.length === 0) {
          accounts = fromProfiles
        } else {
          const declaredIds = new Set(declaredReal.map((a) => String(a.accountId)).filter(Boolean))
          const merged = { ...accounts }
          for (const [k, v] of Object.entries(fromProfiles)) {
            if (declaredIds.has(String(v.accountId)) || merged[k]) continue
            merged[k] = v
          }
          accounts = merged
        }
      }
    } catch (err) {
      log.error('discovery account da profili SSO fallita', { err: err.message })
    }
  }

  // Auto-discovery: nessun servizio dichiarato → scoprili dagli account (read-only, in memoria);
  // con watchlist presente e DADAGUARD_DISCOVER attivo, unisci gli scoperti ai dichiarati (i
  // dichiarati vincono e mantengono gli override).
  let discovered = null
  if (services.length === 0) {
    services = await autoDiscoverServices(accounts)
    if (services.length) discovered = { count: services.length, accounts: Object.keys(accounts) }
  } else if (autoDiscover) {
    const before = services.length
    services = mergeServices(services, await autoDiscoverServices(accounts))
    const added = services.length - before
    if (added > 0) discovered = { count: added, accounts: Object.keys(accounts) }
  }
  const value = { accounts, services, discovered }
  _resolveCache = { at: Date.now(), value }
  return value
}

// Worker Cloudflare → result-servizio nella STESSA forma delle card AWS, ma i check (version+runtime)
// li costruiamo direttamente dai dati CF: NON passa per i check AWS (che assumono un contesto AWS).
export function cfServiceResult(w, t) {
  const checks = {}
  if (w.latest) {
    checks.version = {
      key: 'version',
      status: 'up',
      summary: `${shortId(w.latest.versionId || w.latest.id) ?? '—'} · ${fmtAgo(w.latest.createdOn, t)}`,
    }
  }
  if (w.analytics) {
    const { requests, errorPct, spark, cpuP99Ms } = w.analytics
    const status = requests === 0 ? 'idle' : errorPct >= 5 ? 'degraded' : 'up'
    const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
    let summary = t('cf.runtimeSummary', { req: fmtN(requests), err: errorPct >= 10 ? Math.round(errorPct) : errorPct.toFixed(1) })
    if (cpuP99Ms != null) summary += ` · ${t('cf.cpuP99', { ms: Math.round(cpuP99Ms) })}`
    checks.runtime = { key: 'runtime', status, summary, spark: spark ?? [] }
  }
  const { overall, cause, causes } = computeOverall(checks)
  return {
    name: w.name,
    url: w.deployUrl ?? null, // endpoint pubblico del Worker (workers.dev / rotta) → link sulla card
    links: w.deployUrl ? { Cloudflare: w.deployUrl } : {},
    account: { key: 'cloudflare', label: 'Cloudflare', color: CF_COLOR },
    region: null,
    type: 'cloudflare-worker',
    description: null,
    managed: null,
    dependsOn: [],
    overall,
    cause,
    causes,
    checks,
  }
}

export async function getStatus(lang) {
  const t = makeT(lang) // lingua dei summary: passata dal FE via /api/status?lang=
  const { accounts, services, discovered } = await resolveServices()
  if (discovered) log.info('auto-discovery', discovered)

  // Pre-carica lo state Terraform per ogni account usato (una sola volta per richiesta),
  // così il drift non rilegge S3 per ogni servizio.
  const usedAccounts = [...new Set(services.map((s) => s.account).filter(Boolean))]
  const tfByAccount = {}
  await Promise.all(
    usedAccounts.map(async (k) => {
      const a = accounts[k]
      if (!a?.terraform?.stateBucket) return
      try {
        tfByAccount[k] = await managedResources({
          profile: a.profile,
          roleArn: a.roleArn,
          externalId: a.externalId,
          region: a.region,
          stateBucket: a.terraform.stateBucket,
        })
      } catch (err) {
        // Non nascondere: logga e marca l'errore (il drift dirà "unknown", non sparirà).
        log.error('state TF non leggibile', { account: k, err: err.message })
        tfByAccount[k] = {
          error: err.message,
          managed: { lambda: new Set(), ecs: new Set(), asg: new Set() },
          attrs: { lambda: {} },
          schedules: {},
        }
      }
    }),
  )

  // Pre-carica gli allarmi CloudWatch ATTIVI per account (una volta), così il check alarms
  // li correla senza una chiamata per servizio.
  const alarmsByAccount = {}
  await Promise.all(
    usedAccounts.map(async (k) => {
      const a = accounts[k]
      if (!a) return
      try {
        alarmsByAccount[k] = await alarms.fetchFiringAlarms({
          profile: a.profile,
          roleArn: a.roleArn,
          externalId: a.externalId,
          region: a.region,
        })
      } catch (err) {
        log.error('allarmi non leggibili', { account: k, err: err.message })
        alarmsByAccount[k] = []
      }
    }),
  )

  // Pre-carica l'indice dei secret per account (una volta): elenca /cato/<env>/ e conta i parametri
  // per componente → il check "secrets" mappa da sé ogni servizio scoperto sulla convenzione Cato
  // /cato/<env>/<servizio>, SENZA dichiarare ssm.path a mano e senza una chiamata per servizio.
  // Solo NOMI (WithDecryption=false → niente kms:Decrypt).
  const secretsByAccount = {}
  await Promise.all(
    usedAccounts.map(async (k) => {
      const a = accounts[k]
      if (!a) return
      const env = a.env ?? a.terraform?.env ?? k // convenzione: la chiave account È l'ambiente (staging/production)
      try {
        secretsByAccount[k] = await loadSecretsIndex({
          profile: a.profile,
          roleArn: a.roleArn,
          externalId: a.externalId,
          region: a.region,
          env,
        })
      } catch (err) {
        // null = "non ho potuto guardare" (≠ zero secret): il check resta muto, non inventa.
        log.error('indice secret non leggibile', { account: k, err: err.message })
        secretsByAccount[k] = null
      }
    }),
  )

  // cap di concorrenza sui servizi (ogni servizio fa già più chiamate AWS in parallelo per i check)
  const results = await mapLimit(services, CONCURRENCY, async (service) => {
      const acct = service.account ? accounts[service.account] : null
      const ctx = {
        profile: acct?.profile,
        roleArn: acct?.roleArn,
        externalId: acct?.externalId,
        region: acct?.region,
        tf: service.account ? tfByAccount[service.account] : null,
        alarms: service.account ? alarmsByAccount[service.account] : undefined,
        env: acct ? (acct.env ?? acct.terraform?.env ?? service.account) : undefined,
        secretsIndex: service.account ? secretsByAccount[service.account] : undefined,
        t, // traduttore dei summary (i check lo usano per parlare nella lingua scelta)
      }

      const checkResults = (await Promise.all(CHECKS.map((c) => c.run(service, ctx)))).filter(
        Boolean,
      )
      const checks = Object.fromEntries(checkResults.map((r) => [r.key, r]))

      const cu = consoleUrl(service, acct?.region) // #5 deep-link alla risorsa AWS esatta (region dal servizio o, in fallback, dall'account)
      // Endpoint pubblico del servizio (link sulla card), in ordine di precedenza:
      //  1. `url` dichiarato in config (universale, e per i servizi dietro Cloudflare è il dominio VERO);
      //  2. dominio ricavato dal check runtime (es. CloudFront, dalla GetDistribution già fatta);
      //  3. origine dell'healthUrl. Nessuna delle tre → niente endpoint.
      const endpoint = service.url ?? checks.runtime?.url ?? endpointFromHealth(service.healthUrl)
      const { overall, cause, causes } = computeOverall(checks)
      return {
        name: service.name,
        url: endpoint, // endpoint pubblico del servizio (config url / CloudFront / healthUrl); null se ignoto
        links: {
          ...(service.links ?? {}),
          ...(endpoint ? { [t('link.endpoint')]: endpoint } : {}),
          ...(cu ? { [t('link.console')]: cu } : {}),
        },
        account: acct
          ? { key: service.account, label: acct.label ?? service.account, color: acct.color ?? null }
          : null,
        region: service.aws?.region ?? acct?.region ?? null,
        type: service.aws?.type ?? null,
        description: service.description ?? null, // dedotta dalla risorsa (es. Lambda Description) → card auto-esplicativa

        managed: service.managed ?? null, // #7 gestito da Terraform (se noto) → filtro FE
        dependsOn: service.dependsOn ?? [], // relazioni dichiarate (grafo dipendenze)
        overall, // semaforo (colore)
        cause, // check colpevole primario → testo del badge (es. "ALLARME", "TASK GIÙ")
        causes, // tutti i check allo stesso livello del peggiore
        checks,
      }
  })

  // Cloudflare Worker come card-servizio (version + runtime). Se non c'è token → [] (nessuna card).
  // Costruiti a parte e appesi: NON entrano nella discovery AWS (costi/topologia/deploys restano intatti).
  let cfResults = []
  try {
    cfResults = (await cloudflareWorkersStatus()).map((w) => cfServiceResult(w, t))
  } catch (err) {
    log.error('cloudflare: stato Worker non leggibile', { err: err.message })
  }

  return {
    generatedAt: new Date().toISOString(),
    // mode + capabilities da ./mode.js (unica fonte): il frontend mostra/nasconde i pulsanti
    // in base a `capabilities`, non a un controllo dell'env duplicato lato client.
    mode: MODE,
    capabilities,
    discovered, // != null quando i servizi sono stati auto-scoperti (nessun services.yaml)
    services: [...results, ...cfResults],
  }
}
