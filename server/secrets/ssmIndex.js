import { ssmSecrets } from './ssm.js'

// Indice secret per-account, ZERO-CONFIG (#4 senza dichiarare ssm.path a mano).
// Convenzione Cato: /cato/<env>/<componente>[/<job>]/<KEY>. Elenchiamo UNA volta la radice
// /cato/<env>/ (solo NOMI, WithDecryption=false → niente kms:Decrypt) e contiamo i parametri per
// componente di primo livello. Il check "secrets" mappa poi ogni servizio scoperto sul suo
// componente, senza una chiamata SSM per servizio.

// Abbreviazioni d'ambiente usate nei nomi risorsa AWS (es. lambda `prod-...`) vs l'ambiente
// "lungo" usato nel path SSM (/cato/production/...). Servono a spogliare il prefisso dal nome.
function envAliases(env) {
  const e = String(env ?? '').toLowerCase()
  const map = { production: ['prod', 'prd'], staging: ['stg', 'stage'], prod: ['production'], prd: ['production'] }
  return [e, ...(map[e] ?? [])].filter(Boolean)
}

// Segmenti "d'ambiente" che compaiono come prefisso nei nomi risorsa e NON fanno parte dello slug
// del componente. Tenuti larghi di proposito: spogliare un token in più è innocuo (poi si matcha
// contro l'indice reale), non spogliarlo abbastanza no.
function envPrefixTokens(env) {
  return new Set(['cato', 'prod', 'production', 'prd', 'staging', 'stg', 'stage', ...envAliases(env)])
}

// Slug candidati per un servizio, in ordine di preferenza (più spogliato prima). Puro/testabile.
// Es. env=production: 'prod-follow-competitor' → ['follow-competitor', 'prod-follow-competitor'];
//     'cato-staging-backend' → ['backend', 'staging-backend', 'cato-staging-backend'].
export function serviceSecretSlugs(service, env) {
  const raw = service?.name ?? service?.aws?.function ?? service?.aws?.service ?? ''
  if (!raw) return []
  const tokens = envPrefixTokens(env)
  const out = []
  let s = String(raw)
  out.push(s)
  // Spoglia fino a 2 segmenti d'ambiente iniziali (copre `cato-staging-<svc>`), tenendo ogni forma
  // intermedia come candidato di fallback.
  for (let i = 0; i < 2; i++) {
    const m = /^([a-z0-9]+)-(.+)$/i.exec(s)
    if (!m || !tokens.has(m[1].toLowerCase())) break
    s = m[2]
    out.push(s)
  }
  // Più spogliato prima, deduplicato.
  return [...new Set(out.reverse())]
}

// Conta i parametri per componente di primo livello. Input = nomi RELATIVI alla radice
// (come li ritorna ssmSecrets), es. ['backend/DB_URL', 'follow-competitor/API_KEY']. Puro/testabile.
export function countTopSegment(relNames) {
  const out = {}
  for (const n of relNames ?? []) {
    const seg = String(n).split('/')[0]
    if (seg) out[seg] = (out[seg] ?? 0) + 1
  }
  return out
}

// Carica l'indice per un account. Ritorna { base, byComponent } o null se manca l'ambiente
// (nessuna convenzione applicabile → il check resta muto, non inventa).
export async function loadSecretsIndex({ profile, roleArn, externalId, region, env, base } = {}) {
  const root = base ?? (env ? `/cato/${env}` : null)
  if (!root) return null
  const { names } = await ssmSecrets({ profile, roleArn, externalId, region, path: root })
  return { base: root.replace(/\/$/, ''), byComponent: countTopSegment(names) }
}
