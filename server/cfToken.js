// Credenziali Cloudflare "senza config manuale": Dadaguard prende un token in quest'ordine —
//   1. env CLOUDFLARE_API_TOKEN (quello che usano già Terraform/CI) — o CF_API_TOKEN;
//   2. token OAuth locale di Wrangler (~/.config/.wrangler/config/default.toml), se non scaduto.
// Niente token → l'integrazione Cloudflare resta SPENTA (nessun errore, nessun ingombro).
// Read-only: il token serve solo a leggere Worker/deploy/analytics via API.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Parser TOML minimale: solo coppie `chiave = "valore"` di primo livello (basta per il file wrangler).
// Puro/testabile. Ignora sezioni [..], commenti (#) e chiavi annidate.
export function parseToml(text = '') {
  const out = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim().replace(/\s*#.*$/, '') // toglie commento in coda
    val = val.replace(/^["']|["']$/g, '') // spoglia le virgolette
    out[key] = val
  }
  return out
}

// Il token OAuth di Wrangler è valido? (esiste e non è scaduto). `now` iniettabile per i test.
export function wranglerTokenFrom(toml, now = Date.now()) {
  if (!toml?.oauth_token) return null
  if (toml.expiration_time && new Date(toml.expiration_time).getTime() <= now) return null // scaduto
  return toml.oauth_token
}

// Percorsi possibili del config di Wrangler (in ordine): $WRANGLER_HOME, XDG (~/.config/.wrangler),
// legacy (~/.wrangler). Solo lettura.
function wranglerConfigPaths() {
  const paths = []
  if (process.env.WRANGLER_HOME) paths.push(join(process.env.WRANGLER_HOME, 'config', 'default.toml'))
  paths.push(join(homedir(), '.config', '.wrangler', 'config', 'default.toml'))
  paths.push(join(homedir(), '.wrangler', 'config', 'default.toml'))
  return paths
}

// Token effettivo + provenienza, o null se non ce n'è. { token, source: 'env' | 'wrangler' }.
export function cloudflareToken() {
  const env = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN
  if (env) return { token: env.trim(), source: 'env' }
  for (const p of wranglerConfigPaths()) {
    try {
      const token = wranglerTokenFrom(parseToml(readFileSync(p, 'utf8')))
      if (token) return { token, source: 'wrangler' }
    } catch {
      // file assente/illeggibile → prova il prossimo
    }
  }
  return null
}

// Account id esplicito, se l'operatore ne ha più d'uno (altrimenti si risolve da GET /accounts).
export function cloudflareAccountId() {
  return process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || null
}
