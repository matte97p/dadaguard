// Segnale #2 — build/deploy: cosa gira e da quando? ZERO-CONFIG per i tipi AWS.
// Tre fonti, in ordine:
//   1. healthUrl + expectedVersion (dichiarati) → confronto versione (up/degraded).
//   2. metadata AWS, senza dichiarare nulla:
//        - ECS    → tag immagine del task definition + timestamp del deploy.
//        - lambda → versione pubblicata (o alias) + LastModified.
//        - ec2    → AMI + LaunchTime ("su da …").
//   3. niente di tutto ciò → null (segnale non applicabile).
// Confronto normalizzato (ignora "v" iniziale e spazi). up = match, degraded = mismatch.
import { ecsBuildInfo } from '../runtime/ecs.js'
import { ecsScheduledBuildInfo } from '../runtime/ecsScheduled.js'
import { lambdaBuildInfo } from '../runtime/lambda.js'
import { ec2BuildInfo } from '../runtime/ec2.js'
import { cleanAwsReason } from '../runtime/awsClient.js'
import { fmtAgo, fmtDuration } from '../i18n.js'

const TIMEOUT_MS = 5000

export const key = 'version'

const norm = (v) => String(v).trim().replace(/^v/i, '')

// --- #4 PROVENIENZA della versione attesa ---
// "Atteso" non è più solo un literal stantio in config: può venire da una fonte di verità
// DINAMICA (un URL/manifest/endpoint), e l'output dice SEMPRE da dove arriva (expectedSource).
const hostOf = (u) => {
  try {
    return new URL(u).host
  } catch {
    return 'url'
  }
}

// Estrae la versione da un corpo di risposta (JSON.field o prima riga di testo). Puro/testabile.
export function parseExpectedBody(raw, contentType = '', field = 'version') {
  if (/json/i.test(contentType) || /^\s*[[{]/.test(raw)) {
    try {
      const body = JSON.parse(raw)
      const v = String(field).split('.').reduce((o, k) => (o == null ? o : o[k]), body)
      return v == null ? null : String(v)
    } catch {
      /* non era JSON: prova come testo */
    }
  }
  const first = String(raw).split('\n')[0].trim()
  return first || null
}

async function fetchExpected(url, field) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return parseExpectedBody(await res.text(), res.headers.get('content-type') || '', field || 'version')
  } finally {
    clearTimeout(timer)
  }
}

// Ritorna { value, source: 'url'|'config', from } o null. L'URL ha precedenza (verità dinamica);
// se irraggiungibile, ripiega sul literal in config — senza mai mentire sulla provenienza.
export async function resolveExpected(service) {
  if (service.expectedVersionUrl) {
    try {
      const value = await fetchExpected(service.expectedVersionUrl, service.expectedVersionField)
      if (value != null) return { value, source: 'url', from: hostOf(service.expectedVersionUrl) }
    } catch {
      /* fallback sul literal sotto */
    }
  }
  if (service.expectedVersion != null)
    return { value: String(service.expectedVersion), source: 'config', from: 'config' }
  return null
}

export async function run(service, ctx) {
  const t = ctx?.t ?? ((k) => k)
  const exp = await resolveExpected(service)
  const expected = exp?.value
  const res = await compute(service, ctx, expected, t)
  // Provenienza trasparente: quando c'è un atteso e abbiamo un esito di confronto, dillo.
  if (res && exp && (res.status === 'up' || res.status === 'degraded')) {
    res.expected = exp.value
    res.expectedSource = exp.source
    res.expectedFrom = exp.from
  }
  return res
}

async function compute(service, ctx, expected, t) {
  // (1) Fonte dichiarata: /health JSON vs atteso (comportamento storico).
  if (expected && service.healthUrl) {
    return await fromHealth(service, expected, t)
  }

  // (2) Zero-config: metadata AWS per tipo. Degrada con grazia (permessi/risorsa) → unknown.
  const cfg = service.aws
  if (cfg?.type && BUILDERS[cfg.type]) {
    const aws = {
      profile: ctx?.profile,
      roleArn: ctx?.roleArn,
      externalId: ctx?.externalId,
      region: cfg.region ?? ctx?.region,
    }
    try {
      return await BUILDERS[cfg.type](cfg, aws, expected, t)
    } catch (err) {
      // Messaggio pulito e azionabile invece dell'eccezione SDK grezza (throttle/denied/notfound/expired/…).
      return { key, status: 'unknown', reason: cleanAwsReason(err, t) }
    }
  }

  // (3) atteso dichiarato ma senza healthUrl né tipo AWS leggibile.
  if (expected) return { key, status: 'unknown', reason: t('version.nosource') }
  return null // segnale non applicabile
}

// --- (1) /health HTTP ---
async function fromHealth(service, expected, t) {
  const field = service.versionField || 'version'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(service.healthUrl, { signal: controller.signal })
    const body = await res.json()
    const actual = field.split('.').reduce((o, k) => (o == null ? o : o[k]), body)

    if (actual == null) return { key, status: 'unknown', reason: t('version.fieldmissing', { field }) }
    if (norm(actual) === norm(expected)) return { key, status: 'up', summary: `v${norm(actual)}` }
    return { key, status: 'degraded', summary: t('version.mismatch', { actual, expected }) }
  } catch (err) {
    return {
      key,
      status: 'unknown',
      reason: err.name === 'AbortError' ? t('version.timeout') : t('version.notjson'),
    }
  } finally {
    clearTimeout(timer)
  }
}

// --- (2) builders per tipo AWS. Se `expected` c'è, confronto → degraded su mismatch. ---
// Appende "· modificato da <chi>" al summary, quando lo conosciamo (registeredBy ECS / CloudTrail Lambda).
function withModifier(summary, who, t) {
  return who ? `${summary} · ${t('build.by', { who })}` : summary
}

// Summary comune per ECS (servizio o task schedulato): stesso formato, stessa gestione tag/quando/chi.
function ecsSummary(b, expected, t) {
  const ago = b.deployedAt ? fmtAgo(b.deployedAt, t) : null
  const base = b.tag ? t('build.ecs', { tag: b.tag, ago: ago ?? '—' }) : t('build.ecsnotag', { ago: ago ?? '—' })
  return decideStatus({ key, summary: withModifier(base, b.modifiedBy, t) }, expected, b.tag, t)
}

const BUILDERS = {
  async ecs(cfg, aws, expected, t) {
    const b = await ecsBuildInfo(cfg, aws)
    if (!b) return { key, status: 'unknown', reason: t('build.notfound') }
    return ecsSummary(b, expected, t)
  },

  // Cron su ECS RunTask (nessun servizio long-running): build letta dalla task def schedulata.
  'ecs-scheduled': async (cfg, aws, expected, t) => {
    const b = await ecsScheduledBuildInfo(cfg, aws)
    if (!b) return { key, status: 'unknown', reason: t('build.notfound') }
    return ecsSummary(b, expected, t)
  },

  async lambda(cfg, aws, expected, t) {
    const b = await lambdaBuildInfo(cfg, aws)
    if (!b) return { key, status: 'unknown', reason: t('build.notfound') }
    // Versionata (numero o alias) → "v<n>". Non versionata ($LATEST) → fingerprint del codice
    // (CodeSha256 corto): dice QUALE build è viva, visto che "$LATEST" è uguale per tutte.
    const ver =
      b.version && b.version !== '$LATEST'
        ? `v${b.version}`
        : b.codeSha
          ? `sha ${b.codeSha.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()}`
          : '$LATEST'
    const ago = b.lastModified ? fmtAgo(b.lastModified, t) : '—'
    return decideStatus({ key, summary: withModifier(t('build.lambda', { ver, ago }), b.modifiedBy, t) }, expected, b.version, t)
  },

  async ec2(cfg, aws, expected, t) {
    const b = await ec2BuildInfo(cfg, aws)
    if (!b) return { key, status: 'unknown', reason: t('build.notfound') }
    // "su da {dur}" → durata bare (senza "fa"), perché la frase ha già la preposizione.
    const ago = b.launchTime ? fmtDuration(b.launchTime, t) : '—'
    return decideStatus(
      { key, summary: t('build.ec2', { ami: b.ami ?? '—', ago }) },
      expected,
      b.ami,
      t,
    )
  },
}

// Decide lo status: se `expected` è dichiarato confronta col valore reale (degraded su mismatch),
// altrimenti il segnale è puramente informativo → up con il summary "cosa gira e da quando".
function decideStatus(base, expected, actual, t) {
  if (!expected) return { ...base, status: 'up' }
  if (actual != null && norm(actual) === norm(expected)) return { ...base, status: 'up' }
  return { ...base, status: 'degraded', summary: t('build.mismatch', { actual: actual ?? '—', expected }) }
}
