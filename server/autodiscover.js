import { discover, candidatesToServices } from './discover.js'
import { log } from './log.js'

// Auto-discovery zero-config: se non c'è alcun servizio dichiarato, scopre quelli che
// girano in ogni account (read-only, in memoria — NON scrive services.yaml). Così il primo
// avvio mostra valore senza config; services.yaml resta un OVERRIDE opzionale.
//
// Read-only e on-DNA: riusa la stessa discover() del pulsante "Scopri servizi", ma senza
// mai persistere. Se un account non è raggiungibile, logga e prosegue (gli altri restano).
export async function autoDiscoverServices(accounts) {
  const out = []
  for (const [key, a] of Object.entries(accounts ?? {})) {
    try {
      const { candidates } = await discover({
        profile: a.profile,
        roleArn: a.roleArn,
        externalId: a.externalId,
        region: a.region,
        stateBucket: a.terraform?.stateBucket,
      })
      out.push(...candidatesToServices(candidates, key))
    } catch (err) {
      log.error('auto-discovery fallita', { account: key, err: err.message })
    }
  }
  return out
}
