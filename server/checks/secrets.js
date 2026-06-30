// Segnale #4 — secret: i secret del servizio esistono in Doppler? (+ #14/#16:
// con `compareWith`, quali sono presenti in un altro ambiente ma mancanti qui).
// Si applica solo ai servizi con `doppler: { project, config, compareWith? }`.
import { dopplerSecrets } from '../secrets/doppler.js'
import { ssmSecrets } from '../secrets/ssm.js'

export const key = 'secrets'

export async function run(service, ctx) {
  const t = ctx?.t ?? ((k) => k)
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
      if (!r.count) return { key, status: 'degraded', summary: t('secrets.none', { path: service.ssm.path }) }
      return { key, status: 'up', summary: t('secrets.present', { n: r.count }), count: r.count }
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
        summary: t('secrets.missing', { n: r.missing.length, env: r.compareWith, list: `${shown}${more}` }),
        count: r.count,
        missing: r.missing.length,
      }
    }

    // #15 età/rotazione: secret più vecchi di `maxAgeDays` (default 90). Scatta solo se
    // Doppler espone le date (r.oldest != null); altrimenti il dato non c'è e si salta.
    const maxAgeDays = cfg.maxAgeDays ?? 90
    if (r.oldest != null) {
      const ageDays = Math.floor((Date.now() - r.oldest) / 86400000)
      if (ageDays > maxAgeDays) {
        return {
          key,
          status: 'degraded',
          summary: t('secrets.stale', { n: r.count, days: maxAgeDays }),
          count: r.count,
        }
      }
    }

    return {
      key,
      status: 'up',
      summary: t('secrets.present', { n: r.count }),
      count: r.count,
    }
  } catch (err) {
    // config inesistente, CLI non loggata, JSON illeggibile, ecc. Niente valori nel messaggio.
    const reason =
      err.code === 'DOPPLER_BAD_JSON'
        ? t('secrets.dopplerbadjson')
        : /not found|Invalid|Unable/i.test(err.message)
          ? t('secrets.dopplernotfound')
          : t('secrets.dopplerunavailable')
    return { key, status: 'unknown', reason }
  }
}

// TODO #13 (secret orfani: in Doppler ma referenziati da nessuno) — NON implementato.
// È fragile: richiederebbe scansionare env Lambda / task ECS / SSM di tutti i servizi e
// fare match per NOME col set Doppler, con alto rischio di falsi positivi (nomi che non
// coincidono 1:1, secret usati a runtime ma non in env). Senza un legame robusto non lo
// inventiamo. Vedi anche TODO #18 (mappa secret→servizio→risorsa) — fuori da questo batch.
