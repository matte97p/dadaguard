// Lo stato della flotta come lo vede la UI: UNA cache, condivisa da chi lo chiede (l'endpoint) e da
// chi lo calcola comunque (il watchdog delle notifiche).
//
// Prima erano due mondi separati: l'endpoint aveva la sua `Map` con 30 secondi di TTL, il watchdog
// chiamava `getStatus` per conto suo ogni 300 secondi e il suo giro non finiva in nessuna cache.
// Misurato sul servizio vero il 31/08/2026: la cache dell'endpoint era quindi fresca 30 secondi su
// 300 (il 10% del tempo) e chi apriva una pagina pagava il ricalcolo intero 9 volte su 10, fra 7,6 e
// 28,2 secondi. E `/api/status` lo chiede il guscio dell'app, quindi era il costo di OGNI pagina.
//
// Due cambi, insie: il dato vecchio si consegna subito e si rinfresca dietro (vedi util/swr.js), e il
// giro del watchdog lo REGALA a questa cache. Da qui in poi nessuno aspetta, tranne il primo che
// arriva dopo un riavvio, e per quello c'è la scaldata all'avvio.
import { getStatus } from './status.js'
import { swrCache } from './util/swr.js'
import { log } from './log.js'

// Quanto vecchio può essere il dato prima che parta un rinfresco DIETRO le spalle. Non è più «quanto
// aspetta chi apre la pagina», che adesso è zero: per questo il default sale da 30 a 120 secondi, che
// su finestre di 24 ore non cambia una diagnosi e dimezza i giri inutili. L'età vera resta scritta in
// pagina (`generatedAt`, «ultimo fetch» sulla Dashboard), che è la condizione per potersi permettere
// di servire un dato non appena calcolato.
const TTL_MS = Number(process.env.DADAGUARD_STATUS_TTL_MS ?? 120_000)

const cache = swrCache({
  ttlMs: TTL_MS,
  compute: (lang) => getStatus(lang),
  onError: (err, lang) => log.error('status: rinfresco in background fallito', { lang, err: err.message }),
})

// `{ value, at, stale, computed }`. `fresh: true` aspetta un giro nuovo: il bottone «Aggiorna» deve
// poter dire la verità, altrimenti aggiorna niente.
export const statusFor = (lang, opts) => cache.get(lang, opts)

// Il giro che il watchdog ha già pagato: senza questo era lavoro speso per nessuno.
export const publishStatus = (lang, payload) => cache.publish(lang, payload)

export const statusAge = (lang) => cache.age(lang)

// Scaldata all'avvio, in background: il primo che apre dopo un rilascio pagherebbe il giro intero, e
// un rilascio succede a ogni merge su main. Non si aspetta e non si fa cadere l'avvio se fallisce.
export function warmStatus(lang = 'it') {
  return cache
    .get(lang)
    .then(({ value }) => log.info('status: cache scaldata', { ms: value?.ms ?? null, servizi: value?.services?.length ?? null }))
    .catch((err) => log.error('status: scaldata iniziale fallita', { err: err.message }))
}
