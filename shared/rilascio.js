// «Rilasciato dopo il guasto»: un job che ha fallito e che ha una versione nuova arrivata DOPO
// l'ultimo fallimento. Chi ha rilasciato la correzione non deve tornare in dashboard a segnarla: lo
// stato si deduce dalle date che AWS restituisce gia' (la revision della task definition, la
// `LastModified` della Lambda) contro l'ora dell'ultima corsa fallita.
//
//  · `null`: niente da dire. Nessun rilascio dopo il fallimento, o date mancanti: senza le date non si
//    promette una correzione che forse non c'e', e la riga resta rossa.
//  · 'rilasciato': c'e' una versione nuova e nessuna corsa l'ha ancora provata. Si aspetta il giro dopo.
//  · 'verificato': una corsa DOPO il rilascio e' riuscita. Il guasto e' chiuso.
//
// Un fallimento dopo il rilascio sposta `ultimaFallita` oltre `rilascio`, e la riga torna rossa da
// sola. Il limite, voluto: conta qualunque versione nuova, anche una che col guasto non c'entra
// (un cambio di variabile d'ambiente). Il giro dopo lo smentisce comunque. Pura.
export function statoRilascio({ rilascio, ultimaFallita, ultimaRiuscita = null } = {}) {
  const r = toMs(rilascio)
  const f = toMs(ultimaFallita)
  if (r == null || f == null || r <= f) return null
  const ok = toMs(ultimaRiuscita)
  return ok != null && ok > r ? 'verificato' : 'rilasciato'
}

function toMs(v) {
  if (v == null) return null
  const n = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime()
  return Number.isFinite(n) ? n : null
}
