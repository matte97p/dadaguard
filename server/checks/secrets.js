// Segnale #4 — secret: i secret del servizio esistono in Doppler? (+ #14/#16:
// con `compareWith`, quali sono presenti in un altro ambiente ma mancanti qui).
// Si applica solo ai servizi con `doppler: { project, config, compareWith? }`.
import { dopplerSecrets } from '../secrets/doppler.js'
import { ssmSecrets } from '../secrets/ssm.js'
import { serviceSecretSlugs } from '../secrets/ssmIndex.js'
import { cleanAwsReason } from '../runtime/awsClient.js'

export const key = 'secrets'

// Auto-inferenza ZERO-CONFIG: nessun `ssm.path` né `doppler` dichiarati → mappa il servizio sulla
// convenzione Cato /cato/<env>/<servizio> consultando l'indice precaricato (ctx.secretsIndex, una
// sola chiamata per account, fatta in status.js). Mostra la riga SOLO se esistono davvero parametri
// → niente falsi positivi, niente dichiarazioni a mano. `null` = segnale non applicabile (come prima).
function inferFromIndex(service, ctx, t) {
  const byComponent = ctx?.secretsIndex?.byComponent
  if (!byComponent) return null
  const keys = Object.keys(byComponent)
  if (!keys.length) return null
  for (const slug of serviceSecretSlugs(service, ctx.env)) {
    const hit = keys.find((k) => k.toLowerCase() === slug.toLowerCase())
    if (hit && byComponent[hit] > 0) {
      return { key, status: 'up', summary: t('secrets.present', { n: byComponent[hit] }), count: byComponent[hit] }
    }
  }
  return null
}

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
      return { key, status: 'unknown', reason: `SSM: ${cleanAwsReason(err, t)}` }
    }
  }

  // Doppler (source): check opzionale, locale (CLI). Se non dichiarato, prova l'inferenza zero-config.
  const cfg = service.doppler
  if (!cfg?.project || !cfg?.config) return inferFromIndex(service, ctx, t)

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

// DECISIONE (chiusa, non un TODO aperto): #13 (secret orfani) e #18 (mappa secret→servizio→risorsa)
// NON si implementano. #13 richiederebbe scansionare il CODICE SORGENTE delle app per sapere cosa è
// "referenziato": fuori dal modello di Dadaguard (monitora infra/AWS/Doppler, non i repo) → produrrebbe
// solo falsi positivi. #18 è già coperto: i servizi dichiarano `ssm.path`/`doppler` in config (è di
// fatto la mappa) e le relazioni tra servizi le disegna la topologia (deduce.js). Non duplichiamo.
