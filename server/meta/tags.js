// Team, canale, runbook e obiettivo di disponibilita' di un servizio, letti dai TAG AWS della sua
// risorsa: chiavi `dadaguard:team`, `dadaguard:slack`, `dadaguard:runbook`, `dadaguard:slo`. Il tag
// sta sulla risorsa, quindi lo scrive chi la crea (Terraform) e non c'e' una seconda lista da tenere
// allineata qui dentro. Tag assente = campo vuoto: un team indovinato manda la persona sbagliata.
//
// Una chiamata per CHIAVE e per account (Resource Groups Tagging API, `GetResources`), non una per
// servizio: `TagFilters` con piu' chiavi vale come AND, quindi chiedere tutto in un colpo perderebbe
// le risorse che hanno il team ma non lo SLO. Permesso: tag:GetResources (sola lettura).
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api'
import { clientOpts } from '../runtime/awsClient.js'

export const CHIAVI = { team: 'dadaguard:team', slack: 'dadaguard:slack', runbook: 'dadaguard:runbook', slo: 'dadaguard:slo' }

// arn → { chiave: valore } per le sole risorse che portano almeno una delle chiavi. Paginato.
export async function fetchMetaTags(aws) {
  const client = new ResourceGroupsTaggingAPIClient(clientOpts(aws))
  const perArn = new Map()
  for (const key of Object.values(CHIAVI)) {
    let token
    do {
      const out = await client.send(new GetResourcesCommand({ TagFilters: [{ Key: key }], PaginationToken: token || undefined }))
      for (const r of out.ResourceTagMappingList ?? []) {
        const cur = perArn.get(r.ResourceARN) ?? {}
        for (const t of r.Tags ?? []) if (Object.values(CHIAVI).includes(t.Key)) cur[t.Key] = t.Value
        perArn.set(r.ResourceARN, cur)
      }
      token = out.PaginationToken
    } while (token)
  }
  return perArn
}

// L'ultimo pezzo di un ARN (`function:nome`, `service/cluster/nome`, `db:nome`): e' quello che
// corrisponde agli identificativi che la discovery tiene sul servizio. Puro.
export function codaArn(arn) {
  const s = String(arn ?? '')
  const risorsa = s.split(':').slice(5).join(':')
  return risorsa.split(/[/:]/).filter(Boolean)
}

// I tag della risorsa di UN servizio, cercati per ARN esatto se il servizio ne ha uno, altrimenti
// per identificativo. ECS si confronta su cluster E servizio insieme: due servizi omonimi in cluster
// diversi non devono prendersi i tag l'uno dell'altro. Puro/testabile.
export function tagsDelServizio(aws = {}, perArn) {
  if (!perArn?.size) return null
  if (aws.arn && perArn.has(aws.arn)) return perArn.get(aws.arn)
  for (const [arn, tags] of perArn) {
    const coda = codaArn(arn)
    const tipo = String(arn).split(':')[2]
    if (aws.type === 'ecs' && tipo === 'ecs') {
      if (coda[0] === 'service' && coda.at(-1) === aws.service && (coda.length < 3 || coda[1] === aws.cluster)) return tags
      continue
    }
    if (aws.type === 'lambda' && tipo === 'lambda' && coda[1] === aws.function) return tags
    if (aws.type === 'rds' && tipo === 'rds' && (coda[1] === aws.cluster || coda[1] === aws.instance)) return tags
  }
  return null
}

// Il valore dello SLO come frazione (`99.9` o `99.9%` → 0.999). Fuori da (0,100) → null: un
// obiettivo del 100% non lascia budget, e uno illeggibile non va trasformato in un numero.
export function sloDa(v) {
  const n = Number(String(v ?? '').replace('%', '').replace(',', '.').trim())
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null
  return Math.round(n * 10_000) / 1_000_000
}

// I quattro campi pronti per la UI. Sempre tutti presenti, vuoti quando il tag manca.
export function metaDaTags(tags) {
  const t = tags ?? {}
  return {
    team: t[CHIAVI.team] ?? null,
    slack: t[CHIAVI.slack] ?? null,
    runbook: t[CHIAVI.runbook] ?? null,
    slo: sloDa(t[CHIAVI.slo]),
  }
}
