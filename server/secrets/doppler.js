import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Provider secret via CLI Doppler (già autenticata, come AWS/SSO). Legge SOLO i
// NOMI dei secret (Object.keys) — i valori non vengono mai usati né loggati.
// Permessi: accesso read ai config Doppler (la CLI usa il login locale).
//
// Nota #15 (età/rotazione): `doppler secrets --json` NON espone le date dei secret
// (created/modified) — solo computed/raw/note. Le date stanno nell'API / activity log,
// non in questo comando. Qui rileviamo una eventuale data SE la CLI la espone in futuro
// (campi `created_at`/`createdAt`), così #15 si abilita senza altri cambi. Finché non
// c'è, `oldest` resta null e il check età non scatta. #15 (età/rotazione) resta quindi DORMIENTE
// by-design: si attiva da sé se la CLI esporrà le date. `doppler activity`/API sarebbero fragili o
// fuori dallo scope CLI → non li usiamo. Scelta chiusa, non un TODO aperto.
async function readSecrets(project, config) {
  const { stdout } = await exec(
    'doppler',
    ['secrets', '--json', '--project', project, '--config', config],
    { maxBuffer: 16 * 1024 * 1024 },
  )
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // output non-JSON: tipicamente un messaggio di errore della CLI (login scaduto,
    // progetto inesistente) stampato in chiaro. Errore esplicito, non un crash opaco.
    const e = new Error('doppler: output non leggibile come JSON')
    e.code = 'DOPPLER_BAD_JSON'
    throw e
  }
  if (!parsed || typeof parsed !== 'object') {
    const e = new Error('doppler: forma JSON inattesa')
    e.code = 'DOPPLER_BAD_JSON'
    throw e
  }
  return parsed
}

// Estrae una data dal valore di un secret, SE la CLI la espone (future-proof per #15).
function secretDate(entry) {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry.created_at ?? entry.createdAt ?? entry.modified_at ?? entry.modifiedAt
  if (!raw) return null
  const ms = new Date(raw).getTime()
  return Number.isFinite(ms) ? ms : null
}

// cfg: { project, config, compareWith?, maxAgeDays? }.
// Ritorna { count, names, missing?, compareWith?, oldest? }.
export async function dopplerSecrets(cfg) {
  const secrets = await readSecrets(cfg.project, cfg.config)
  const names = Object.keys(secrets)
  const result = { count: names.length, names }

  // #15: secret più vecchio (epoch ms) se la CLI espone date; altrimenti null.
  let oldest = null
  for (const name of names) {
    const d = secretDate(secrets[name])
    if (d != null && (oldest == null || d < oldest)) oldest = d
  }
  result.oldest = oldest

  if (cfg.compareWith) {
    const ref = Object.keys(await readSecrets(cfg.project, cfg.compareWith))
    const here = new Set(names)
    result.missing = ref.filter((k) => !here.has(k)) // presenti nel riferimento, assenti qui
    result.compareWith = cfg.compareWith
  }

  return result
}
