// Cache in-process con TTL + single-flight (coalescing). Due scopi, entrambi anti-429:
//  1. coalescing — chiamate concorrenti con la STESSA chiave condividono un'unica esecuzione in volo
//     (es. build #2 + drift #6 + runtime leggono GetFunctionConfiguration dello stesso Lambda nello
//     stesso refresh → 1 chiamata control-plane invece di 3);
//  2. TTL — entro ttlMs i refresh successivi riusano il risultato, senza ri-chiamare AWS → niente
//     burst ripetuto a ogni "Aggiorna".
// Gli errori NON vengono cachati: al giro dopo si riprova. Nessuna persistenza, nessuna dipendenza.
const resolved = new Map() // key -> { at: epochMs, value }
const inflight = new Map() // key -> Promise in corso

export function cachedCall(key, ttlMs, fn) {
  const hit = resolved.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value)
  const pending = inflight.get(key)
  if (pending) return pending
  const p = Promise.resolve()
    .then(fn)
    .then((value) => {
      resolved.set(key, { at: Date.now(), value })
      return value
    })
    .finally(() => inflight.delete(key)) // libera lo slot sia su successo sia su errore (errore non cachato)
  inflight.set(key, p)
  return p
}

// Solo per i test: azzera lo stato tra un caso e l'altro.
export function clearCache() {
  resolved.clear()
  inflight.clear()
}
