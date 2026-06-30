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
  return { accounts, services }
}

export function loadConfig() {
  const raw = isCloud ? process.env.DADAGUARD_CONFIG : readFileSync(CONFIG_PATH, 'utf8')
  return validateConfig(yaml.load(raw) ?? {})
}
