// Segnale #4 — secret: i secret del servizio esistono in Doppler? (+ #14/#16:
// con `compareWith`, quali sono presenti in un altro ambiente ma mancanti qui).
// Si applica solo ai servizi con `doppler: { project, config, compareWith? }`.
import { dopplerSecrets } from '../secrets/doppler.js'
import { ssmSecrets } from '../secrets/ssm.js'

export const key = 'secrets'

export async function run(service, ctx) {
  // SSM (runtime, cloud-ready via AWS role): i secret che il servizio vede davvero.
  if (service.ssm?.path) {
    try {
      const r = await ssmSecrets({
        profile: ctx?.profile,
        roleArn: ctx?.roleArn,
        externalId: ctx?.externalId,
        region: service.ssm.region ?? ctx?.region,
        path: service.ssm.path,
      })
      if (!r.count) return { key, status: 'degraded', summary: `0 secret in SSM ${service.ssm.path}` }
      return { key, status: 'up', summary: `${r.count} secret (SSM)`, count: r.count }
    } catch (err) {
      return { key, status: 'unknown', reason: `SSM: ${err.message}` }
    }
  }

  // Doppler (source): check opzionale, locale (CLI).
  const cfg = service.doppler
  if (!cfg?.project || !cfg?.config) return null // segnale non applicabile

  try {
    const r = await dopplerSecrets(cfg)

    if (r.missing && r.missing.length) {
      const shown = r.missing.slice(0, 3).join(', ')
      const more = r.missing.length > 3 ? `, +${r.missing.length - 3}` : ''
      return {
        key,
        status: 'degraded',
        summary: `${r.missing.length} mancanti vs ${r.compareWith}: ${shown}${more}`,
        count: r.count,
        missing: r.missing.length,
      }
    }

    return {
      key,
      status: 'up',
      summary: `${r.count} secret (${cfg.project}/${cfg.config})`,
      count: r.count,
    }
  } catch (err) {
    // config inesistente, CLI non loggata, ecc. Niente valori nel messaggio.
    const reason = /not found|Invalid|Unable/i.test(err.message)
      ? 'config Doppler non trovato o accesso negato'
      : 'CLI Doppler non disponibile'
    return { key, status: 'unknown', reason }
  }
}
