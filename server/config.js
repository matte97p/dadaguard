import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { isCloud } from './mode.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const CONFIG_PATH = join(__dirname, '..', 'services.yaml')

// Riletto a ogni chiamata: fetch-on-load, zero stato.
// Ritorna { accounts, services }. Gli account definiscono profilo AWS + region +
// estetica (label, color); i servizi referenziano un account via `account`.
//
// Sorgente del config, secondo la modalità (vedi ./mode.js):
//  - local-first: file services.yaml (gitignored), editabile dalla dashboard.
//  - cloud: env DADAGUARD_CONFIG (YAML iniettato da SSM SecureString) → niente storage su
//    disco. In cloud il config si versiona in SSM/TF, non si edita dalla UI.
// Validazione leggera (pura/testabile): forma sbagliata = errore chiaro qui, non errori oscuri a
// valle. Permissiva: un config valido (anche minimale) non viene mai rifiutato.
export function validateConfig(doc) {
  const accounts = doc?.accounts ?? {}
  const services = doc?.services ?? []
  if (typeof accounts !== 'object' || Array.isArray(accounts)) {
    throw new Error("config non valido: 'accounts' deve essere un oggetto (mappa key → account)")
  }
  if (!Array.isArray(services)) {
    throw new Error("config non valido: 'services' deve essere una lista")
  }
  services.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !s.name) {
      throw new Error(`config non valido: services[${i}] manca del campo 'name'`)
    }
  })
  return {
    accounts,
    services,
    org: doc?.org ?? null,
    // Auto-discovery LOCALE degli account dai profili SSO in `~/.aws/config` (vedi server/awsProfiles.js):
    // attiva di default in locale (spirito zero-config), opt-out con `discoverAccounts: false`. Può anche
    // essere un oggetto `{ exclude: [...] }` per saltare account per Id o Nome. Ignorata in cloud e con `org`.
    discoverAccounts: doc?.discoverAccounts ?? null,
    freeTierAccount: doc?.freeTierAccount ?? null,
    // URL pubblico con cui Dadaguard è esposto (dietro Cloudflare Access): il guardiano
    // anti-esposizione lo sonda per verificare di avere davvero il login davanti (vedi server/exposure.js).
    publicUrl: doc?.publicUrl ?? null,
  }
}

export function loadConfig() {
  if (isCloud) return validateConfig(yaml.load(process.env.DADAGUARD_CONFIG) ?? {})
  let raw
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    // Zero-config: nessun services.yaml. Sintetizza un account 'default' dalla catena di
    // credenziali AWS (env / SSO / role), region da AWS_REGION — placeholder che l'auto-discovery
    // degli account (server/awsProfiles.js, in resolveServices) SOSTITUISCE con i profili SSO di
    // ~/.aws/config, se presenti. I servizi li trova l'auto-discovery. services.yaml resta un OVERRIDE.
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined
    return { accounts: { default: { region, label: 'AWS' } }, services: [], org: null, publicUrl: null }
  }
  return validateConfig(yaml.load(raw) ?? {})
}
