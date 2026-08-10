import { ssmSecrets } from './ssm.js'
import { cached } from '../util/ttlcache.js'
import { ENV_TOKENS } from '../util/envToken.js'

// Radice dei parametri SSM (es. `/acme`), senza slash finale. Assente = convenzione non applicabile.
const ssmPrefix = () => String(process.env.DADAGUARD_SSM_PREFIX ?? '').replace(/\/+$/, '')

// Primo segmento di un path SSM: è il nome dell'organizzazione, e nei nomi risorsa AWS compare come
// prefisso da spogliare. Si DEDUCE dalla radice, non si scrive nel codice. Pura/testabile.
export function orgSegment(root = '') {
  return String(root).replace(/^\/+/, '').split('/')[0]?.toLowerCase() || null
}

// Indice secret per-account, ZERO-CONFIG (#4 senza dichiarare ssm.path a mano).
// Convenzione: <radice>/<env>/<componente>[/<job>]/<KEY>. Elenchiamo UNA volta <radice>/<env>/ (solo
// NOMI, WithDecryption=false → niente kms:Decrypt) e contiamo i parametri per componente di primo
// livello. Il check "secrets" mappa poi ogni servizio scoperto sul suo componente, senza una chiamata
// SSM per servizio.
//
// La RADICE arriva da `DADAGUARD_SSM_PREFIX` (es. `/acme`) e non da un default nel codice, per due
// ragioni che vanno insieme: un nome di organizzazione scritto qui, in un repo pubblico, dice a
// chiunque di chi è l'infrastruttura che questo strumento guarda; e per chi lo installa sarebbe
// comunque sbagliato, perché la sua radice si chiama in un altro modo. Senza la variabile l'indice non
// si carica e il check auto-inferito resta MUTO — non rosso: un servizio senza secret dichiarati e un
// servizio che non abbiamo potuto guardare non devono somigliarsi.

// Abbreviazioni d'ambiente usate nei nomi risorsa AWS (es. lambda `prod-...`) vs l'ambiente
// "lungo" usato nel path SSM (<radice>/production/...). Servono a spogliare il prefisso dal nome.
function envAliases(env) {
  const e = String(env ?? '').toLowerCase()
  const map = { production: ['prod', 'prd'], staging: ['stg', 'stage'], prod: ['production'], prd: ['production'] }
  return [e, ...(map[e] ?? [])].filter(Boolean)
}

// Segmenti "d'ambiente" che compaiono come prefisso nei nomi risorsa e NON fanno parte dello slug
// del componente. Tenuti larghi di proposito: spogliare un token in più è innocuo (poi si matcha
// contro l'indice reale), non spogliarlo abbastanza no.
// Prefissi da spogliare dal nome risorsa: il nome dell'organizzazione (dedotto dalla radice SSM, non
// scritto qui), i token d'ambiente e il gruppo `cron`. I nomi risorsa AWS incorporano il gruppo (es.
// lambda `acme-production-cron-credit-monitor`) mentre in SSM è un segmento di path
// (`/acme/production/cron/credit-monitor`) → per matchare va tolto anche `cron`.
function prefixTokens(env, root) {
  const org = orgSegment(root)
  return new Set([...(org ? [org] : []), ...ENV_TOKENS, 'cron', ...envAliases(env)])
}

// Slug candidati per un servizio, in ordine di preferenza (più spogliato prima). Puro/testabile.
// Spoglia i prefissi noti (ambiente + `cron`) tenendo ogni forma intermedia come fallback. Es.:
//   'prod-follow-competitor'                    → ['follow-competitor', 'prod-follow-competitor']
//   'acme-production-cron-credit-monitor'       → ['credit-monitor', 'cron-credit-monitor', …]
//   'acme-staging-backend'                      → ['backend', 'staging-backend', 'acme-staging-backend']
// `root` = la radice dell'indice (es. `/acme/production`): da lì si deduce il nome dell'organizzazione
// da spogliare. Passarla invece di leggerla dall'ambiente tiene la funzione pura — e chi la chiama la
// ha già, perché è la radice che ha appena elencato.
export function serviceSecretSlugs(service, env, root = '') {
  const raw = service?.name ?? service?.aws?.function ?? service?.aws?.service ?? ''
  if (!raw) return []
  const tokens = prefixTokens(env, root)
  const out = []
  let s = String(raw)
  out.push(s)
  // Spoglia i segmenti-prefisso iniziali finché ne trova (copre `<org>-<env>-cron-<job>` = 3 livelli).
  // Cap a 4 come backstop; ci fermiamo comunque appena il segmento non è un prefisso noto.
  for (let i = 0; i < 4; i++) {
    const m = /^([a-z0-9]+)-(.+)$/i.exec(s)
    if (!m || !tokens.has(m[1].toLowerCase())) break
    s = m[2]
    out.push(s)
  }
  // Più spogliato prima, deduplicato.
  return [...new Set(out.reverse())]
}

// Conta i parametri per componente. Input = nomi RELATIVI alla radice (come li ritorna ssmSecrets).
// Convenzione a DUE profondità → li indicizziamo entrambi:
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
// "lungo" (<radice>/production, <radice>/staging). Normalizziamo così l'indice punta al path giusto anche se
// l'account nella config è chiamato `prod`/`stg`.
function canonicalEnv(env) {
  const e = String(env ?? '').toLowerCase()
  return { prod: 'production', prd: 'production', stg: 'staging', stage: 'staging' }[e] ?? env
}

// Carica l'indice per un account. Ritorna { base, byComponent } o null se manca l'ambiente
// (nessuna convenzione applicabile → il check resta muto, non inventa).
// L'indice dei NOMI dei secret (mai i valori) cambia quando qualcuno aggiunge o toglie un parametro:
// settimane, non secondi. Leggerlo costava 36 chiamate paginate e ~1,7s per ogni risposta. Cinque
// minuti di cache non cambiano una diagnosi, e la promessa condivisa evita che i quattro account
// partano tutti insieme sulla stessa lettura.
const INDEX_TTL_MS = Number(process.env.DADAGUARD_SECRETS_INDEX_TTL_MS ?? 5 * 60 * 1000)

export function loadSecretsIndex({ profile, roleArn, externalId, region, env, base } = {}) {
  const prefix = ssmPrefix()
  const root = base ?? (prefix && env ? `${prefix}/${canonicalEnv(env)}` : null)
  if (!root) return null
  const key = `ssmIndex:${region ?? ''}|${profile ?? ''}|${roleArn ?? ''}|${root}`
  return cached(key, INDEX_TTL_MS, async () => {
    const { names } = await ssmSecrets({ profile, roleArn, externalId, region, path: root })
    return { base: root.replace(/\/$/, ''), byComponent: indexComponents(names) }
  })
}
