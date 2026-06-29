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
export function loadConfig() {
  const raw = isCloud ? process.env.DADAGUARD_CONFIG : readFileSync(CONFIG_PATH, 'utf8')
  const doc = yaml.load(raw) ?? {}
  return { accounts: doc.accounts ?? {}, services: doc.services ?? [] }
}
