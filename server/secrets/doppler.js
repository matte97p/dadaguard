import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Provider secret via CLI Doppler (già autenticata, come AWS/SSO). Legge SOLO i
// NOMI dei secret (Object.keys) — i valori non vengono mai usati né loggati.
// Permessi: accesso read ai config Doppler (la CLI usa il login locale).
async function secretNames(project, config) {
  // --json per parsing robusto; estraiamo solo le chiavi.
  const { stdout } = await exec(
    'doppler',
    ['secrets', '--json', '--project', project, '--config', config],
    { maxBuffer: 16 * 1024 * 1024 },
  )
  return Object.keys(JSON.parse(stdout))
}

// cfg: { project, config, compareWith? }. Ritorna { count, missing?, compareWith? }.
export async function dopplerSecrets(cfg) {
  const names = await secretNames(cfg.project, cfg.config)
  const result = { count: names.length }

  if (cfg.compareWith) {
    const ref = await secretNames(cfg.project, cfg.compareWith)
    const here = new Set(names)
    result.missing = ref.filter((k) => !here.has(k)) // presenti nel riferimento, assenti qui
    result.compareWith = cfg.compareWith
  }

  return result
}
