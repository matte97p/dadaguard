// Lo stato che serve al QUADRO dei deploy, letto solo con API GRATUITE.
//
// Il quadro usava lo stato completo della dashboard (`/api/status`): 150 e più risorse, otto controlli
// ciascuna, e fra quei controlli le metriche CloudWatch, che si pagano a metrica letta. Misurato in
// Cost Explorer fra il 28/09 e il 04/10/2026: circa 470 metriche a giro. Rifarlo ogni 2 minuti per
// tenere il quadro fresco costava circa 100 $ al mese, ogni 15 secondi sarebbero stati migliaia.
// Al quadro però le metriche non servono: gli bastano le risorse che si rilasciano (servizi e cron
// ECS, Lambda) e, di quelle, due controlli che leggono API gratuite:
//   version   cosa gira e da quando: ECS DescribeServices/DescribeTaskDefinition, Lambda
//             GetFunctionConfiguration, e CloudTrail per l'autore (in cache finché la risorsa non cambia)
//   runtime   task attivi, rollout in corso, target sani: ECS e bilanciatori, SOLO per i servizi ECS.
//             Quello delle Lambda e dei cron legge metriche e log, e resta fuori
// L'elenco delle risorse è quello della discovery, già in cache (5 minuti): non si riscopre niente.
//
// La forma di ogni voce è la stessa di `/api/status`, così il quadro non sa da dove arriva.
import { resolveServices } from './status.js'
import { mapLimit } from './util/pool.js'
import { makeT } from './i18n.js'
import * as version from './checks/version.js'
import * as runtime from './checks/runtime.js'

const TIPI = new Set(['ecs', 'ecs-scheduled', 'lambda'])
// Quante risorse si leggono insieme: abbastanza per stare in qualche secondo, poche per non toccare
// le quote delle API (ECS e Lambda reggono decine di richieste al secondo per account).
const CONCORRENZA = 8

// `controlli` per le prove: i due `run` veri leggono AWS.
export async function statoLeggero({ resolve = resolveServices, lang = 'it', controlli = { version: version.run, runtime: runtime.run } } = {}) {
  const { accounts, services, people, soglie, discoveryProblems } = await resolve()
  const t = makeT(lang)
  const scelti = services.filter((s) => TIPI.has(s.aws?.type))
  const voci = await mapLimit(scelti, CONCORRENZA, async (s) => {
    const acct = s.account ? accounts[s.account] : null
    const ctx = { profile: acct?.profile, roleArn: acct?.roleArn, externalId: acct?.externalId, region: acct?.region, people, soglie, t }
    const [v, r] = await Promise.all([
      Promise.resolve(controlli.version(s, ctx)).catch(() => null),
      s.aws.type === 'ecs' ? Promise.resolve(controlli.runtime(s, ctx)).catch(() => null) : null,
    ])
    return {
      name: s.name,
      type: s.aws.type,
      account: acct ? { key: s.account } : null,
      // Per il quadro conta solo «giù o no», e lo dice il runtime dei servizi ECS.
      overall: r?.status ?? null,
      checks: { ...(v ? { version: v } : {}), ...(r ? { runtime: r } : {}) },
    }
  })
  // Le letture della discovery non riuscite viaggiano con la lista, come fa la discovery stessa: una
  // risorsa che manca perché non si è letta non è una risorsa sparita, e il quadro deve saperlo per
  // non togliere la sua riga (vedi `pianoCelle` in server/notify/quadro.js).
  const out = voci.filter(Boolean)
  out.problemi = discoveryProblems ?? []
  return out
}
