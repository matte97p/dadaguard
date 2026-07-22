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

// Conta i parametri per componente. Input = nomi RELATIVI alla radice (come li ritorna ssmSecrets).
// Convenzione Cato a DUE profondità → li indicizziamo entrambi:
//   • app-service:  <svc>/<KEY>              → componente = <svc>        (es. backend/DB_URL → backend)
//   • cron:         cron/<job>/<KEY>         → componente = cron E <job> (es. cron/follow-competitor/X → follow-competitor)
// Regola generica (niente hardcoding di "cron"): con ≥3 segmenti, il 2° è un servizio annidato sotto
// un gruppo → lo indicizziamo a sé. Con 2 segmenti il 2° è una KEY, non un servizio → non si indicizza.
// Puro/testabile.
export function indexComponents(relNames) {
  const out = {}
  const bump = (k) => {
    if (k) out[k] = (out[k] ?? 0) + 1
  }
  for (const n of relNames ?? []) {
    const segs = String(n).split('/').filter(Boolean)
    if (!segs.length) continue
    bump(segs[0]) // top-level (backend, agentic-chat, cron, garanzia…)
    if (segs.length >= 3) bump(segs[1]) // servizio annidato sotto un gruppo (cron/<job>/<KEY> → <job>)
  }
  return out
}

// Alias d'ambiente: i nomi risorsa AWS usano spesso l'abbreviazione (prod/stg), il path SSM l'ambiente
// "lungo" (/cato/production, /cato/staging). Normalizziamo così l'indice punta al path giusto anche se
// l'account nella config è chiamato `prod`/`stg`.
function canonicalEnv(env) {
  const e = String(env ?? '').toLowerCase()
  return { prod: 'production', prd: 'production', stg: 'staging', stage: 'staging' }[e] ?? env
}

// Carica l'indice per un account. Ritorna { base, byComponent } o null se manca l'ambiente
// (nessuna convenzione applicabile → il check resta muto, non inventa).
export async function loadSecretsIndex({ profile, roleArn, externalId, region, env, base } = {}) {
  const root = base ?? (env ? `/cato/${canonicalEnv(env)}` : null)
  if (!root) return null
  const { names } = await ssmSecrets({ profile, roleArn, externalId, region, path: root })
  return { base: root.replace(/\/$/, ''), byComponent: indexComponents(names) }
}
