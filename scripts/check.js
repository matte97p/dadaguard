// CLI / CI mode: esegue gli STESSI check della dashboard (getStatus) e termina con un EXIT CODE
// in base allo stato peggiore. Pensato per le pipeline: "blocca il deploy se qualcosa è giù/in drift".
//
// Uso:
//   node scripts/check.js                      # tabella leggibile, exit 1 se un servizio è "down"
//   node scripts/check.js --json               # output JSON (machine-readable)
//   node scripts/check.js --service webhook    # filtra (match esatto o sottostringa)
//   node scripts/check.js --fail-on degraded   # soglia: down (default) | degraded | none
//   node scripts/check.js --lang it            # lingua dei summary (default en)
//
// Auth AWS come la dashboard: profili/SSO in locale, ruolo dell'istanza in CI/cloud.
import { getStatus } from '../server/status.js'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

const json = has('--json')
const svc = val('--service', null)
const lang = val('--lang', 'en')
const failOn = val('--fail-on', 'down') // down | degraded | none

const SEV = { up: 0, idle: 1, disabled: 1, unknown: 1, degraded: 2, down: 3 }
const THRESHOLD = { none: 99, degraded: 2, down: 3 }[failOn] ?? 3
const SYM = { up: '✓', degraded: '!', down: '✗', idle: '·', disabled: '·', unknown: '?' }

try {
  const status = await getStatus(lang)
  let services = status.services
  if (svc) services = services.filter((s) => s.name === svc || s.name.includes(svc))

  if (json) {
    console.log(JSON.stringify({ generatedAt: status.generatedAt, mode: status.mode, services }, null, 2))
  } else {
    for (const s of services) {
      // mostra il check messo peggio del servizio (il motivo del semaforo)
      const worst = Object.values(s.checks ?? {}).sort((a, b) => (SEV[b.status] ?? 0) - (SEV[a.status] ?? 0))[0]
      const detail = worst?.summary ?? worst?.reason ?? ''
      console.log(`${SYM[s.overall] ?? '?'} ${s.name.padEnd(26)} ${String(s.overall).padEnd(9)} ${detail}`)
    }
    const counts = services.reduce((m, s) => ((m[s.overall] = (m[s.overall] || 0) + 1), m), {})
    const tally = Object.entries(counts)
      .map(([k, n]) => `${n} ${k}`)
      .join(' · ')
    console.log(`\n${services.length} servizi · ${tally}`)
  }

  const worstSev = services.reduce((w, s) => Math.max(w, SEV[s.overall] ?? 0), 0)
  const fail = worstSev >= THRESHOLD
  if (!json) console.log(fail ? '→ FAIL' : '→ OK')
  process.exit(fail ? 1 : 0)
} catch (err) {
  console.error(`dadaguard check: ${err.message}`)
  process.exit(2) // errore di esecuzione (config/creds), distinto dal "servizio giù" (1)
}
