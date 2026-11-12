// Scrive la configurazione di wrangler dalle variabili d'ambiente, così il repo (pubblico) non
// contiene il dominio, l'account o i componenti di nessuna installazione. Chi deploya mette i
// propri valori nelle variabili del repo (vedi .github/workflows/deploy.yml) o nel proprio shell.
//
//   node statuspage/build-config.mjs > statuspage/wrangler.generated.json
//
// Obbligatorie: STATUSPAGE_HOST, STATUSPAGE_ZONE, STATUSPAGE_KV_ID, STATUSPAGE_COMPONENTS,
// CLOUDFLARE_ACCOUNT_ID. Facoltative: STATUSPAGE_NAME, STATUSPAGE_SITE_NAME, STATUSPAGE_TZ,
// STATUSPAGE_DADAGUARD_URL, STATUSPAGE_ACCESS_TEAM_DOMAIN, STATUSPAGE_ACCESS_AUD.
import { parseComponents } from './logic.js'

export function buildConfig(env) {
  const need = ['STATUSPAGE_HOST', 'STATUSPAGE_ZONE', 'STATUSPAGE_KV_ID', 'STATUSPAGE_COMPONENTS', 'CLOUDFLARE_ACCOUNT_ID']
  const missing = need.filter((k) => !env[k])
  if (missing.length) throw new Error(`mancano: ${missing.join(', ')}`)
  const host = env.STATUSPAGE_HOST
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('STATUSPAGE_HOST: solo il nome host, senza schema né percorso')
  const comps = parseComponents(env.STATUSPAGE_COMPONENTS)
  if (comps.length === 0) throw new Error('STATUSPAGE_COMPONENTS: nessun componente valido')
  return {
    name: env.STATUSPAGE_NAME || 'dadaguard-statuspage',
    main: 'worker.js',
    // Scritto qui perché un token di account non può interrogare /memberships, e senza account
    // wrangler fallisce con un errore di autenticazione che sembra un token sbagliato.
    account_id: env.CLOUDFLARE_ACCOUNT_ID,
    compatibility_date: '2026-09-01',
    // Spenti: l'indirizzo workers.dev e le anteprime per versione sarebbero copie pubbliche della
    // pagina su domini che non sono il nostro.
    workers_dev: false,
    preview_urls: false,
    // La rotta, non un custom domain: il record DNS lo possiede l'IaC di chi deploya, e un custom
    // domain lo creerebbe di suo (fallendo se il record esiste già).
    routes: [{ pattern: `${host}/*`, zone_name: env.STATUSPAGE_ZONE }],
    kv_namespaces: [{ binding: 'STATUS', id: env.STATUSPAGE_KV_ID }],
    triggers: { crons: ['* * * * *'] },
    observability: { enabled: true },
    vars: {
      COMPONENTS: JSON.stringify(comps.map((c) => ({ id: c.id, it: c.name.it, en: c.name.en, subIt: c.sub.it, subEn: c.sub.en, ...(c.probe ? { probe: c.probe } : {}) }))),
      SITE_NAME: env.STATUSPAGE_SITE_NAME || 'Status',
      TZ: env.STATUSPAGE_TZ || 'UTC',
      ...(env.STATUSPAGE_DADAGUARD_URL ? { DADAGUARD_URL: env.STATUSPAGE_DADAGUARD_URL } : {}),
      ...(env.STATUSPAGE_ACCESS_TEAM_DOMAIN ? { ACCESS_TEAM_DOMAIN: env.STATUSPAGE_ACCESS_TEAM_DOMAIN } : {}),
      ...(env.STATUSPAGE_ACCESS_AUD ? { ACCESS_AUD: env.STATUSPAGE_ACCESS_AUD } : {}),
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
