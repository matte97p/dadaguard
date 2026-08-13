// «La mia modifica è già in produzione?» — la domanda che oggi costringe ad aprire GitHub e
// confrontare due tag a mano. I dati per rispondere Dadaguard li ha già (le build CodeBuild per
// account, vedi deploys.js): quello che mancava era metterli AFFIANCATI per servizio.
//
// Tutto puro: entra il payload per-account di `/api/deploys`, esce la tabella. Nessuna chiamata AWS,
// così la vista non aggiunge un giro di rete e la logica si prova senza fixture.

// Quale ambiente è un account, dalla sua CHIAVE. Stessa convenzione che usano le notifiche (`[PROD]`,
// `[STAGING]`): un account il cui nome comincia per `prod` è la produzione, `stag`/`stg` è staging.
// Gli altri (payer, security) non hanno deploy applicativi e restano fuori: metterli in una colonna
// «rilasci» darebbe una riga vuota per ogni servizio, che si legge come «manca qualcosa».
export function ambienteDi(chiave = '') {
  const k = String(chiave).toLowerCase()
  if (/^prod/.test(k)) return 'produzione'
  if (/^stag|^stg/.test(k)) return 'staging'
  return null
}

// L'ultimo deploy ANDATO A BUON FINE per servizio: è quello che sta girando. Una build fallita non
// cambia cosa c'è in produzione, e una in corso non ci è ancora arrivata: contarle direbbe che è
// uscito qualcosa che non è uscito.
export function ultimoRilascioPerServizio(builds = []) {
  const out = new Map()
  for (const b of builds) {
    if (b.status !== 'SUCCEEDED' || !b.service) continue
    const gia = out.get(b.service)
    if (!gia || new Date(b.startedAt ?? 0) > new Date(gia.startedAt ?? 0)) out.set(b.service, b)
  }
  return out
}

// La tabella: una riga per servizio, staging e produzione accanto.
//
// `allineato` risponde alla domanda vera, e ha tre valori invece di due: `sì` (stesso commit), `no`
// (commit diversi: c'è qualcosa in staging che in produzione non c'è), e `null` quando il servizio
// esiste in un ambiente solo. Il terzo caso NON è un problema da segnalare: `acme-admin` e le sonde
// vivono solo in staging per scelta, e trattarli come «non rilasciato» sarebbe rumore per sempre.
export function tabellaRilasci(perAccount = {}) {
  const perAmbiente = { staging: new Map(), produzione: new Map() }
  for (const [chiave, dati] of Object.entries(perAccount)) {
    const amb = ambienteDi(chiave)
    if (!amb) continue
    const builds = dati?.builds ?? dati ?? []
    for (const [servizio, build] of ultimoRilascioPerServizio(builds)) {
      // Due account per lo stesso ambiente non capitano oggi; se capitassero, vince il deploy più
      // recente invece di uno scelto dall'ordine delle chiavi, che sarebbe casuale.
      const gia = perAmbiente[amb].get(servizio)
      if (!gia || new Date(build.startedAt ?? 0) > new Date(gia.startedAt ?? 0)) perAmbiente[amb].set(servizio, build)
    }
  }

  const servizi = [...new Set([...perAmbiente.staging.keys(), ...perAmbiente.produzione.keys()])].sort()
  return servizi.map((servizio) => {
    const s = perAmbiente.staging.get(servizio) ?? null
    const p = perAmbiente.produzione.get(servizio) ?? null
    const dueLati = Boolean(s && p)
    return {
      servizio,
      staging: s && { commit: s.commit, quando: s.startedAt, autore: s.author, build: s.number },
      produzione: p && { commit: p.commit, quando: p.startedAt, autore: p.author, build: p.number },
      allineato: dueLati ? s.commit === p.commit : null,
      soloIn: dueLati ? null : s ? 'staging' : 'produzione',
    }
  })
}

// Quello che è in staging e NON in produzione: la coda del non rilasciato. È la lista che oggi si
// ottiene aprendo un compare su GitHub, e l'unica riga che serve davvero a chi chiede «esce stasera?».
export const daRilasciare = (righe = []) => righe.filter((r) => r.allineato === false)

// Forma TESTO, per il terminale e per una skill: la stessa tabella senza aprire il browser. Larghezze
// fisse e niente colori: deve restare leggibile dentro a `curl`, in un log e incollata in chat.
export function testoRilasci(righe = []) {
  if (!righe.length) return 'nessun deploy applicativo trovato negli account di staging e produzione'
  const w = Math.max(8, ...righe.map((r) => r.servizio.length))
  const riga = (r) => {
    const s = r.staging?.commit ?? '—'
    const p = r.produzione?.commit ?? '—'
    const stato = r.allineato === true ? 'allineato' : r.allineato === false ? 'DA RILASCIARE' : `solo ${r.soloIn}`
    return `${r.servizio.padEnd(w)}  staging ${String(s).padEnd(9)}  prod ${String(p).padEnd(9)}  ${stato}`
  }
  const coda = daRilasciare(righe)
  const testa = righe.map(riga).join('\n')
  return coda.length
    ? `${testa}\n\nDa rilasciare (${coda.length}): ${coda.map((r) => r.servizio).join(', ')}`
    : `${testa}\n\nTutto allineato fra staging e produzione.`
}
