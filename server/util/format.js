// Formattatori condivisi per l'output utente (summary delle card). Estratti da lambda.js per riuso fra
// i runtime provider, così durate e conteggi sono leggibili ovunque invece di ms grezzi / numeri lunghi.

// Latenza leggibile: ms sotto il secondo, s fino al minuto, poi "Xm Ys" (245759ms → "4m 6s").
export function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}

// Conteggio compatto: 1234 → "1.2k", 15000 → "15k", sotto 1000 invariato.
export function fmtCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k'
  return String(n)
}
