// Memo con scadenza per le risposte che si PAGANO a chiamata (Cost Explorer: ~$0.01 a richiesta).
//
// Perché non è furbizia inutile: i dati di Cost Explorer si aggiornano poche volte al giorno, quindi
// una cache di un'ora non perde nulla di reale, mentre senza cache ogni apertura della pagina Costi
// rifà una chiamata **per account** — con tre account e la pagina aperta dieci volte al giorno sono
// ~$9 al mese di sola curiosità.
//
// In-memory e per-processo: coerente con l'ethos zero-storage dell'app (nessun file, nessun Redis).
// A ogni riavvio si riparte a freddo, che è il comportamento giusto per un dato di sola lettura.
const store = new Map()

// Le chiamate concorrenti sulla stessa chiave condividono la promessa: aprire due volte la pagina
// mentre la prima risposta è in volo non deve pagare due volte. Se la promessa fallisce, la si
// dimentica subito — un errore in cache si trascinerebbe per tutta la durata del TTL.
export function cached(key, ttlMs, fn) {
  const hit = store.get(key)
  if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.value
  const value = Promise.resolve()
    .then(fn)
    .then((v) => {
      store.set(key, { at: Date.now(), value: Promise.resolve(v), pending: false })
      return v
    })
    .catch((err) => {
      store.delete(key)
      throw err
    })
  store.set(key, { at: Date.now(), value, pending: true })
  return value
}

// Per i test e per un eventuale "ricarica davvero" dalla UI.
export function invalidate(prefix = '') {
  if (!prefix) return void store.clear()
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k)
}

export function size() {
  return store.size
}
