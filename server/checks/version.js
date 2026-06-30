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
import { lambdaBuildInfo } from '../runtime/lambda.js'
import { ec2BuildInfo } from '../runtime/ec2.js'
import { fmtAgo, fmtDuration } from '../i18n.js'

const TIMEOUT_MS = 5000

export const key = 'version'

const norm = (v) => String(v).trim().replace(/^v/i, '')

export async function run(service, ctx) {
  const t = ctx?.t ?? ((k) => k)
  const expected = service.expectedVersion

  // (1) Fonte dichiarata: /health JSON vs expectedVersion (comportamento storico).
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
      return { key, status: 'unknown', reason: err.message }
    }
  }

  // (3) expectedVersion dichiarato ma senza healthUrl né tipo AWS leggibile.
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
const BUILDERS = {
  async ecs(cfg, aws, expected, t) {
    const b = await ecsBuildInfo(cfg, aws)
    if (!b) return { key, status: 'unknown', reason: t('build.notfound') }
    const ago = b.deployedAt ? fmtAgo(b.deployedAt, t) : null
    const summary = b.tag
      ? t('build.ecs', { tag: b.tag, ago: ago ?? '—' })
      : t('build.ecsnotag', { ago: ago ?? '—' })
    return decideStatus({ key, summary }, expected, b.tag, t)
  },

  async lambda(cfg, aws, expected, t) {
    const b = await lambdaBuildInfo(cfg, aws)
    if (!b) return { key, status: 'unknown', reason: t('build.notfound') }
    const ver = `v${b.version}`
    const ago = b.lastModified ? fmtAgo(b.lastModified, t) : '—'
    return decideStatus({ key, summary: t('build.lambda', { ver, ago }) }, expected, b.version, t)
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
