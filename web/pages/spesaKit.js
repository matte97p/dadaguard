// Pezzi comuni a Spesa e Limiti: formato dei soldi, livello dei budget, lettura tollerante di un'API.
// Stanno qui e non in ogni pagina perche' sono le stesse regole: un importo scritto in due modi
// diversi in due schede si legge come due misure diverse.

// Importo in dollari nel formato di chi legge: sopra i 100 senza decimali (4.812 $), sotto con due
// (3,60 $). I centesimi di un totale da migliaia sono rumore, quelli di un IP elastico sono il prezzo.
export function soldi(v, lang) {
  const n = Number(v ?? 0)
  const a = Math.abs(n)
  const cifre = a >= 100 ? 0 : 2
  const s = a.toLocaleString(lang === 'en' ? 'en-US' : 'it-IT', { minimumFractionDigits: cifre, maximumFractionDigits: cifre })
  return `${n < 0 ? '−' : ''}${s} $`
}

// Livello del budget (scala del server: sforato, sforera', vicino, a posto) nella scala dei colori
// di stato. «Sforera'» e' arancio e non rosso: non si e' ancora speso, c'e' tempo per decidere.
export const LIVELLO_BUDGET = { over: 'crit', willOver: 'warn', warn: 'warn', ok: 'ok' }

// Livello di una barra al tetto (quote e free tier): la soglia rossa e' dove smette di funzionare o
// comincia a costare, quella arancio dove conviene guardarci.
export function livelloTetto(pct, rosso = 90, arancio = 80) {
  return pct >= rosso ? 'crit' : pct >= arancio ? 'warn' : 'ok'
}

// GET che risolve sempre: `{ dati }` oppure `{ errore }`. Ogni scheda legge piu' fonti, e una che non
// risponde (o che il server non ha ancora, come la spesa giornaliera) non deve spegnere le altre.
export function leggi(url) {
  return fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((dati) => ({ dati }))
    .catch((e) => ({ errore: e.message }))
}

// Il mese corrente in forma 'AAAA-MM', la stessa che vuole /api/costs.
export function meseCorrente(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
