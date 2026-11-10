import { SSMClient, DescribeParametersCommand } from '@aws-sdk/client-ssm'
import { clientOpts, isDenied } from './awsClient.js'
import { cached } from '../util/ttlcache.js'
import { log } from '../log.js'

// «Rilasciato dopo il guasto» conta anche un segreto cambiato. Un job che fallisce per una password
// scaduta si corregge riscrivendo il parametro SSM, non con un deploy: ECS legge i `secrets` della task
// definition all'avvio di ogni task, quindi la revision resta quella di prima e la riga restava rossa fino
// al giro dopo, anche con la correzione gia' al suo posto.
//
// Solo la DATA di modifica, da `ssm:DescribeParameters`, che restituisce i metadati e mai il valore: lo
// stesso permesso con cui Dadaguard elenca gia' i nomi dei segreti (sid `SecretsByNameOnly`). Niente
// `GetParameter`, niente `kms:Decrypt`. I segreti di Secrets Manager restano fuori: per quelli la riga
// fa come prima.

const LOTTO = 50 // valori massimi per un filtro di DescribeParameters

// I parametri SSM che una task definition legge, raggruppati per regione. `valueFrom` e' il nome
// (`/app/DB_PASSWORD`, `TOKEN`) o l'ARN (`arn:aws:ssm:<regione>:<account>:parameter/app/DB_PASSWORD`):
// nell'ARN il nome gerarchico perde la barra iniziale, e un nome con una barra e' sempre gerarchico. Pura.
export function parametriSsm(td, regioneDefault = null) {
  const perRegione = new Map()
  for (const c of td?.containerDefinitions ?? []) {
    for (const s of c.secrets ?? []) {
      const v = s?.valueFrom
      if (typeof v !== 'string' || !v) continue
      let regione = regioneDefault
      let nome = v
      if (v.startsWith('arn:')) {
        const m = /^arn:[^:]+:ssm:([^:]*):[^:]*:parameter\/(.+)$/.exec(v)
        if (!m) continue // Secrets Manager o altro: non e' un parametro SSM
        regione = m[1] || regioneDefault
        nome = m[2].includes('/') ? `/${m[2]}` : m[2]
      }
      const k = regione ?? ''
      if (!perRegione.has(k)) perRegione.set(k, new Set())
      perRegione.get(k).add(nome)
    }
  }
  return [...perRegione].map(([regione, nomi]) => ({ regione: regione || null, nomi: [...nomi].sort() }))
}

// La modifica piu' recente fra i parametri SSM che la task definition legge, in ms, o `null` (nessun
// parametro, permesso negato, errore). Best-effort: senza questa data la riga fa come prima.
export function ultimoCambioSegreti(aws, td) {
  const gruppi = parametriSsm(td, aws?.region ?? null)
  if (!gruppi.length) return Promise.resolve(null)
  const chiave = `segreti-cambiati:${aws?.roleArn ?? aws?.profile ?? 'default'}:${td?.taskDefinitionArn ?? JSON.stringify(gruppi)}`
  return cached(chiave, 5 * 60_000, async () => {
    let ultimo = null
    for (const { regione, nomi } of gruppi) {
      const client = new SSMClient({ ...clientOpts(aws), ...(regione ? { region: regione } : {}) })
      for (let i = 0; i < nomi.length; i += LOTTO) {
        let NextToken
        do {
          let r
          try {
            r = await client.send(
              new DescribeParametersCommand({
                ParameterFilters: [{ Key: 'Name', Option: 'Equals', Values: nomi.slice(i, i + LOTTO) }],
                NextToken,
              }),
            )
          } catch (err) {
            // Permesso negato: lo si ricorda per tutto il TTL invece di richiederlo a ogni giro.
            if (isDenied(err)) return null
            throw err
          }
          for (const p of r.Parameters ?? []) {
            const t = p.LastModifiedDate ? new Date(p.LastModifiedDate).getTime() : NaN
            if (Number.isFinite(t) && (ultimo == null || t > ultimo)) ultimo = t
          }
          NextToken = r.NextToken
        } while (NextToken)
      }
    }
    return ultimo
  }).catch((err) => {
    log.warn('segreti SSM: data di modifica non letta', { err: err.message })
    return null
  })
}

// Il rilascio di un job su ECS: la revision della task definition o un suo segreto cambiato dopo,
// quale dei due e' piu' recente. Pura.
export function rilascioJob(registeredAt, segretiAt) {
  const r = registeredAt ? new Date(registeredAt).getTime() : NaN
  const s = Number.isFinite(segretiAt) ? segretiAt : NaN
  const m = Math.max(Number.isFinite(r) ? r : -Infinity, Number.isFinite(s) ? s : -Infinity)
  return Number.isFinite(m) ? m : null
}
