// Cache che NON fa aspettare: se il dato è vecchio lo serve com'è e rinfresca dietro le spalle
// (stale-while-revalidate).
//
// Perché serve, misurato sul servizio vero il 31/08/2026: un giro completo di `/api/status` costa fra
// 7,6 e 28,2 secondi (media oraria fra 12,6 e 16,1 su 113 servizi per 8 famiglie di check), la cache
// dell'endpoint durava 30 secondi e chi la riempiva davvero era il watchdog delle notifiche, che gira
// ogni 300. Risultato: la cache era fresca 30 secondi su 300, cioè il 10% del tempo, e chi apriva una
// pagina in un momento qualsiasi pagava il ricalcolo intero 9 volte su 10. E `/api/status` lo chiede
// il GUSCIO dell'app, quindi lo pagava ogni pagina.
//
// La differenza con `cached` (ttlcache.js) è tutta qui: là un dato scaduto BLOCCA chi lo chiede finché
// il ricalcolo non finisce, qui il dato scaduto si consegna subito e il ricalcolo parte per il
// prossimo. È una scelta legittima solo perché la pagina DICE quando il dato è stato calcolato
// (`generatedAt`, «ultimo fetch» sulla Dashboard): una cache che serve dati vecchi senza dirlo è un
// modo di mentire, non di andare veloce.
//
// ⚠️ Il primo giro (nessun dato in cache) si aspetta: consegnare `null` per non far aspettare vorrebbe
// dire mostrare una dashboard vuota che sembra un guasto. Per quel caso c'è `publish`, con cui chi ha
// già calcolato lo stato per altri motivi riempie la cache prima che arrivi qualcuno.
export function swrCache({ ttlMs, compute, now = () => Date.now(), onError = () => {} }) {
  const store = new Map() // chiave → { at, value }
  const inflight = new Map() // chiave → promessa del ricalcolo in corso

  // Un ricalcolo per chiave: due schede aperte insieme non pagano due volte, e il watchdog che
  // pubblica nel mezzo non ne fa partire un terzo.
  function refresh(key) {
    const pending = inflight.get(key)
    if (pending) return pending
    const p = Promise.resolve()
      .then(() => compute(key))
      .then((value) => {
        store.set(key, { at: now(), value })
        return value
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  return {
    // `{ value, at, stale, computed }`: `at` è QUANDO il dato è stato calcolato (non quando è stato
    // chiesto), `stale` dice che si sta rinfrescando dietro, `computed` che questa risposta è nuova.
    async get(key, { fresh = false } = {}) {
      const hit = store.get(key)
      // «Aggiorna» deve poter dire la verità: aspetta, altrimenti aggiorna niente.
      if (fresh || !hit) {
        const value = await refresh(key)
        return { value, at: store.get(key)?.at ?? now(), stale: false, computed: true }
      }
      const eta = now() - hit.at
      if (eta >= ttlMs) {
        // Fire and forget CON il catch: un ricalcolo che fallisce non deve diventare una promessa
        // non gestita, e soprattutto non deve buttare il dato buono che stiamo consegnando.
        refresh(key).catch((err) => onError(err, key))
        return { value: hit.value, at: hit.at, stale: true, computed: false }
      }
      return { value: hit.value, at: hit.at, stale: false, computed: false }
    },

    // Chi ha già in mano un calcolo fresco lo regala alla cache: è così che il giro del watchdog
    // (ogni 300s) smette di essere lavoro speso per nessuno e diventa il dato che vede chi apre.
    publish(key, value) {
      store.set(key, { at: now(), value })
    },

    age(key) {
      const hit = store.get(key)
      return hit ? now() - hit.at : null
    },

    clear() {
      store.clear()
      inflight.clear()
    },
  }
}
