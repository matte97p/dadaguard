// PRONTO, che non è VIVO. `/healthz` dice che il processo risponde; questo dice che le cache care sono
// già piene, cioè che chi apre una pagina non aspetta il primo giro intero (lo stato della flotta costa
// più di un minuto a freddo). Serve all'orchestratore: con un rilascio a rotazione il task vecchio resta
// a servire finché il nuovo non è pronto, e il primo che apre dopo un merge non paga la cache fredda.
//
// ⚠️ Si apre comunque dopo `maxMs`: un account che non risponde non deve tenere il task nuovo fuori per
// sempre, né farlo uccidere in loop dall'orchestratore. Oltre quel tempo la prima richiesta ricalcola
// come prima, ed è il comportamento di oggi, non uno peggiore. Pura a parte l'orologio, iniettato.
export function creaPronto({ attesi = [], maxMs = 240_000, now = () => Date.now() } = {}) {
  const inizio = now()
  const mancano = new Set(attesi)
  let sveglia = () => {}
  const quando = new Promise((resolve) => (sveglia = resolve))
  if (mancano.size === 0) sveglia()
  else setTimeout(() => sveglia(), maxMs).unref?.()
  return {
    // Una scaldata finita, bene o male: un errore non va ritentato qui, lo ritenta la prima richiesta.
    fatto(nome) {
      mancano.delete(nome)
      if (mancano.size === 0) sveglia()
    },
    // Si risolve quando è pronto, o allo scadere di `maxMs`: lo stesso istante in cui `/readyz` passa a 200.
    quando() {
      return quando
    },
    stato() {
      const scaduto = now() - inizio >= maxMs
      return { pronto: mancano.size === 0 || scaduto, mancano: [...mancano], scaduto: mancano.size > 0 && scaduto }
    },
  }
}
