import { loadConfig } from './config.js'
import { autoDiscoverServices, mergeServices } from './autodiscover.js'
import { resolveOrgAccounts } from './org.js'
import { consoleUrl } from './console.js'
import { MODE, capabilities, autoDiscover } from './mode.js'
import { makeT } from './i18n.js'
import { mapLimit } from './util/pool.js'
import { log } from './log.js'
import { managedResources } from './terraform/state.js'
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

const SEVERITY = { up: 0, idle: 1, disabled: 1, unknown: 1, degraded: 2, down: 3 }
// Quanti servizi controllare in parallelo: evita di aprire 100+ chiamate AWS insieme (throttling).
const CONCURRENCY = Number(process.env.DADAGUARD_CONCURRENCY) || 8

// Semaforo del servizio = il check messo peggio.
function rollup(checks) {
  return Object.values(checks).reduce(
    (worst, c) => (SEVERITY[c.status] > SEVERITY[worst] ? c.status : worst),
    'up',
  )
}

export async function getStatus(lang) {
  const { accounts: declaredAccounts, services: declared, org } = loadConfig()
  let accounts = declaredAccounts
  let services = declared
  const t = makeT(lang) // lingua dei summary: passata dal FE via /api/status?lang=

  // #8 AWS Organizations: enumera i membri (ListAccounts) e aggiungili agli account, ciascuno
  // col ruolo read-only assunto cross-account. Se fallisce, logga e prosegue con quelli espliciti.
  if (org) {
    try {
      accounts = { ...accounts, ...(await resolveOrgAccounts(org)) }
    } catch (err) {
      log.error('org: ListAccounts fallita', { err: err.message })
    }
  }

  // Auto-discovery zero-config: nessun servizio dichiarato → scoprili dagli account
  // (read-only, in memoria). services.yaml resta un override; se c'è, questo non scatta.
  let discovered = null
  if (services.length === 0) {
    services = await autoDiscoverServices(accounts)
    if (services.length) {
      discovered = { count: services.length, accounts: Object.keys(accounts) }
      log.info('auto-discovery', discovered)
    }
  } else if (autoDiscover) {
    // Watchlist presente + DADAGUARD_DISCOVER=1: unisci i servizi scoperti a quelli dichiarati.
    // I dichiarati vincono (mantengono gli override); si aggiungono solo le risorse non in watchlist.
    const before = services.length
    services = mergeServices(services, await autoDiscoverServices(accounts))
    const added = services.length - before
    if (added > 0) {
      discovered = { count: added, accounts: Object.keys(accounts) }
      log.info('auto-discovery (unita alla watchlist)', discovered)
    }
  }

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
        t, // traduttore dei summary (i check lo usano per parlare nella lingua scelta)
      }

      const checkResults = (await Promise.all(CHECKS.map((c) => c.run(service, ctx)))).filter(
        Boolean,
      )
      const checks = Object.fromEntries(checkResults.map((r) => [r.key, r]))

      const cu = consoleUrl(service, acct?.region) // #5 deep-link alla risorsa AWS esatta (region dal servizio o, in fallback, dall'account)
      return {
        name: service.name,
        links: { ...(service.links ?? {}), ...(cu ? { [t('link.console')]: cu } : {}) },
        account: acct
          ? { key: service.account, label: acct.label ?? service.account, color: acct.color ?? null }
          : null,
        region: service.aws?.region ?? acct?.region ?? null,
        type: service.aws?.type ?? null,
        dependsOn: service.dependsOn ?? [], // relazioni dichiarate (grafo dipendenze)
        overall: rollup(checks),
        checks,
      }
  })

  return {
    generatedAt: new Date().toISOString(),
    // mode + capabilities da ./mode.js (unica fonte): il frontend mostra/nasconde i pulsanti
    // in base a `capabilities`, non a un controllo dell'env duplicato lato client.
    mode: MODE,
    capabilities,
    discovered, // != null quando i servizi sono stati auto-scoperti (nessun services.yaml)
    services: results,
  }
}
