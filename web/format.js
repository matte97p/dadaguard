// Formattatori lato client — gemelli di server/util/format.js (client e server sono bundle separati,
// non condividono codice). Tienili allineati.

// Latenza leggibile: ms sotto il secondo, s fino al minuto, poi "Xm Ys" (245759ms → "4m 6s").
export function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}
