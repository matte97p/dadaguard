// Scrive la configurazione di wrangler dalle variabili d'ambiente, così il repo (pubblico) non
// contiene il dominio, l'account o i componenti di nessuna installazione. Chi deploya mette i
// propri valori nelle variabili del repo (vedi .github/workflows/deploy.yml) o nel proprio shell.
//
//   node statuspage/build-config.mjs > statuspage/wrangler.generated.json
//
// Required: STATUSPAGE_HOST (one or more, comma separated: the host that serves /health),
// STATUSPAGE_ZONE, STATUSPAGE_KV_ID, STATUSPAGE_COMPONENTS, CLOUDFLARE_ACCOUNT_ID. Optional:
// STATUSPAGE_NAME, STATUSPAGE_DADAGUARD_URL, STATUSPAGE_ATLASSIAN_PAGE_ID,
// STATUSPAGE_ATLASSIAN_COMPONENTS.
import { parseComponents } from './logic.js'

export function buildConfig(env) {
  const need = ['STATUSPAGE_HOST', 'STATUSPAGE_ZONE', 'STATUSPAGE_KV_ID', 'STATUSPAGE_COMPONENTS', 'CLOUDFLARE_ACCOUNT_ID']
  const missing = need.filter((k) => !env[k])
  if (missing.length) throw new Error(`mancano: ${missing.join(', ')}`)
  // Uno o più host separati da virgola (per esempio l'host vero e uno di prova dietro un login).
  const hosts = env.STATUSPAGE_HOST.split(',').map((h) => h.trim()).filter(Boolean)
  if (hosts.length === 0 || hosts.some((h) => !/^[a-z0-9.-]+$/i.test(h))) throw new Error('STATUSPAGE_HOST: solo nomi host, senza schema né percorso')
  const comps = parseComponents(env.STATUSPAGE_COMPONENTS)
  if (comps.length === 0) throw new Error('STATUSPAGE_COMPONENTS: nessun componente valido')
  return {
    name: env.STATUSPAGE_NAME || 'dadaguard-statuspage',
    main: 'worker.js',
    // Scritto qui perché un token di account non può interrogare /memberships, e senza account
    // wrangler fallisce con un errore di autenticazione che sembra un token sbagliato.
    account_id: env.CLOUDFLARE_ACCOUNT_ID,
    compatibility_date: '2026-09-01',
    // Off: the workers.dev address and the per-version previews would expose /health on domains that
    // are not ours.
    workers_dev: false,
    preview_urls: false,
    // La rotta, non un custom domain: il record DNS lo possiede l'IaC di chi deploya, e un custom
    // domain lo creerebbe di suo (fallendo se il record esiste già).
    routes: hosts.map((h) => ({ pattern: `${h}/*`, zone_name: env.STATUSPAGE_ZONE })),
    kv_namespaces: [{ binding: 'STATUS', id: env.STATUSPAGE_KV_ID }],
    triggers: { crons: ['* * * * *'] },
    observability: { enabled: true },
    vars: {
      COMPONENTS: JSON.stringify(comps.map((c) => ({ id: c.id, ...(c.probe ? { probe: c.probe } : {}) }))),
      ...(env.STATUSPAGE_DADAGUARD_URL ? { DADAGUARD_URL: env.STATUSPAGE_DADAGUARD_URL } : {}),
      // Copia facoltativa su Atlassian Statuspage (vedi mirror.js); la chiave API è un secret.
      ...(env.STATUSPAGE_ATLASSIAN_PAGE_ID ? { ATLASSIAN_PAGE_ID: env.STATUSPAGE_ATLASSIAN_PAGE_ID } : {}),
      ...(env.STATUSPAGE_ATLASSIAN_COMPONENTS ? { ATLASSIAN_COMPONENTS: env.STATUSPAGE_ATLASSIAN_COMPONENTS } : {}),
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(JSON.stringify(buildConfig(process.env), null, 2) + '\n')
  } catch (err) {
    process.stderr.write(`build-config: ${err.message}\n`)
    process.exit(1)
  }
}
