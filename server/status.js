import { loadConfig } from './config.js'
import { MODE, capabilities } from './mode.js'
import { makeT } from './i18n.js'
import { managedResources } from './terraform/state.js'
import * as liveness from './checks/liveness.js'
import * as version from './checks/version.js'
import * as runtime from './checks/runtime.js'
import * as drift from './checks/drift.js'
import * as secrets from './checks/secrets.js'

// Registro dei check attivi. Aggiungere un segnale = importare il modulo
// e aggiungerlo qui. Ogni modulo espone { key, run(service, ctx) }.
// run() può ritornare null se il segnale non si applica al servizio.
const CHECKS = [liveness, version, runtime, drift, secrets]

const SEVERITY = { up: 0, idle: 1, disabled: 1, unknown: 1, degraded: 2, down: 3 }

// Semaforo del servizio = il check messo peggio.
function rollup(checks) {
  return Object.values(checks).reduce(
    (worst, c) => (SEVERITY[c.status] > SEVERITY[worst] ? c.status : worst),
    'up',
  )
}

export async function getStatus(lang) {
  const { accounts, services } = loadConfig()
  const t = makeT(lang) // lingua dei summary: passata dal FE via /api/status?lang=

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
        console.error(`[dadaguard] state TF '${k}' non leggibile: ${err.message}`)
        tfByAccount[k] = {
          error: err.message,
          managed: { lambda: new Set(), ecs: new Set(), asg: new Set() },
          attrs: { lambda: {} },
          schedules: {},
        }
      }
    }),
  )

  const results = await Promise.all(
    services.map(async (service) => {
      const acct = service.account ? accounts[service.account] : null
      const ctx = {
        profile: acct?.profile,
        roleArn: acct?.roleArn,
        externalId: acct?.externalId,
        region: acct?.region,
        tf: service.account ? tfByAccount[service.account] : null,
        t, // traduttore dei summary (i check lo usano per parlare nella lingua scelta)
      }

      const checkResults = (await Promise.all(CHECKS.map((c) => c.run(service, ctx)))).filter(
        Boolean,
      )
      const checks = Object.fromEntries(checkResults.map((r) => [r.key, r]))

      return {
        name: service.name,
        links: service.links ?? {},
        account: acct
          ? { key: service.account, label: acct.label ?? service.account, color: acct.color ?? null }
          : null,
        region: service.aws?.region ?? acct?.region ?? null,
        type: service.aws?.type ?? null,
        dependsOn: service.dependsOn ?? [], // relazioni dichiarate (grafo dipendenze)
        overall: rollup(checks),
        checks,
      }
    }),
  )

  return {
    generatedAt: new Date().toISOString(),
    // mode + capabilities da ./mode.js (unica fonte): il frontend mostra/nasconde i pulsanti
    // in base a `capabilities`, non a un controllo dell'env duplicato lato client.
    mode: MODE,
    capabilities,
    services: results,
  }
}
