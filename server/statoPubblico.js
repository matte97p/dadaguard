// Il riepilogo che può uscire da Dadaguard verso una status page pubblica.
//
// Tutto il resto di Dadaguard è per chi gestisce l'infrastruttura e sta dietro un login; questo è
// l'unico pezzo pensato per finire davanti ai clienti, quindi la regola è al contrario: esce SOLO
// quello che la config nomina. La config dice quali componenti pubblici esistono e quali servizi li
// compongono:
//
//   statusPage:
//     web: [production/frontend]          # <account>/<nome servizio>, o il nome secco
//     api: [production/backend, production/gateway]
//
// La risposta porta per ogni componente il suo id e uno stato, e nient'altro: niente nomi di
// servizi, account, cause, allarmi o conteggi. I nomi da mostrare e le traduzioni li tiene la
// status page, che è il posto dove si decide come parlare ai clienti.
//
// Pura e testabile: riceve lo stato già calcolato (la stessa cache della dashboard) e non chiama AWS.

// I soli segnali che un cliente sente. Drift, versione, secret, sicurezza e backup restano interni:
// un Terraform disallineato non è un servizio rallentato, e mostrarlo giallo in pubblico direbbe il
// falso.
const SEGNALI_PUBBLICI = ['liveness', 'runtime', 'alarms']

const DA_CHECK = { down: 'outage', degraded: 'degraded', up: 'operational', idle: 'operational' }
const GRAVITA = { unknown: 0, operational: 1, degraded: 2, outage: 3 }

const ID_VALIDO = /^[a-z0-9][a-z0-9-]{0,31}$/

// Lo stato pubblico di UN servizio dai suoi check. `unknown` quando nessun segnale pubblico ha
// detto niente: meglio «non lo so» che un verde dedotto dal silenzio.
export function statoServizio(servizio) {
  let stato = 'unknown'
  for (const k of SEGNALI_PUBBLICI) {
    const s = DA_CHECK[servizio?.checks?.[k]?.status]
    if (s && GRAVITA[s] > GRAVITA[stato]) stato = s
  }
  return stato
}

// Un servizio risponde a un riferimento della config se il nome coincide e, quando il riferimento
// porta l'account (`staging/backend`), anche l'account.
export function corrisponde(servizio, rif) {
  const r = String(rif)
  const i = r.indexOf('/')
  if (i === -1) return servizio?.name === r
  return servizio?.account?.key === r.slice(0, i) && servizio?.name === r.slice(i + 1)
}

// Lo stato di un componente è il peggiore fra i suoi servizi. `unknown` solo se nessun servizio
// nominato è stato trovato o nessuno ha detto niente: un servizio sconosciuto accanto a uno sano non
// spegne il verde dell'altro.
export function statoComponente(servizi, riferimenti) {
  const trovati = servizi.filter((s) => riferimenti.some((r) => corrisponde(s, r)))
  let stato = 'unknown'
  for (const s of trovati) {
    const st = statoServizio(s)
    if (GRAVITA[st] > GRAVITA[stato]) stato = st
  }
  return stato
}

// Valida la sezione `statusPage` della config. Permissiva come il resto: una voce malformata si
// salta (e lo dice chi chiama), non fa cadere Dadaguard.
export function componentiDaConfig(sezione) {
  if (!sezione || typeof sezione !== 'object' || Array.isArray(sezione)) return { componenti: [], scartati: [] }
  const componenti = []
  const scartati = []
  for (const [id, rif] of Object.entries(sezione)) {
    const lista = Array.isArray(rif) ? rif.filter((x) => typeof x === 'string' && x.length > 0) : []
    if (!ID_VALIDO.test(id) || lista.length === 0) scartati.push(id)
    else componenti.push({ id, riferimenti: lista })
  }
  return { componenti, scartati }
}

// Il payload di `GET /api/public-status`. `null` quando la config non dichiara componenti: in quel
// caso la rotta risponde 404, così una installazione che non lo usa non espone niente.
export function statoPubblico(status, sezione) {
  const { componenti } = componentiDaConfig(sezione)
  if (componenti.length === 0) return null
  const servizi = Array.isArray(status?.services) ? status.services : []
  return {
    generatedAt: status?.generatedAt ?? null,
    components: componenti.map((c) => ({ id: c.id, state: statoComponente(servizi, c.riferimenti) })),
  }
}
