// Budget di errore: quanta parte dell'errore concesso dall'obiettivo e' gia' stata spesa. Si calcola
// sui conteggi che il check runtime ha GIA' letto da CloudWatch (invocazioni ed errori della sua
// finestra), quindi zero chiamate in piu'. La finestra e' quella del check e non il mese intero:
// lo si dichiara nel campo `finestra`, perche' un numero di un'ora spacciato per mensile mente.
//
// rimasto = 1 - (errori / totali) / (1 - slo). Negativo = sforato. Puro/testabile.
export function budgetErrore({ slo, totali, errori, finestra = null } = {}) {
  if (!slo || !Number.isFinite(totali) || totali <= 0 || !Number.isFinite(errori)) return null
  const concesso = 1 - slo
  const speso = errori / totali / concesso
  return {
    obiettivo: slo,
    disponibilita: 1 - errori / totali,
    rimasto: Math.round((1 - speso) * 1000) / 1000,
    sforato: speso > 1,
    totali,
    errori,
    finestra,
  }
}

// Dai campi del check runtime ai conteggi: Lambda ha `invocations`/`errors`, le API hanno
// `requests`/`errors5xx`. Un check senza conteggi → null (nessun budget, non zero).
export function conteggiDaRuntime(rt = {}) {
  const totali = rt.invocations ?? rt.requests ?? null
  const errori = rt.errors5xx ?? rt.errors ?? null
  if (totali == null || errori == null) return null
  return { totali: Number(totali), errori: Number(errori), finestra: rt.window ?? null }
}
