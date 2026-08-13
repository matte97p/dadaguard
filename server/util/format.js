// Formattatori condivisi per l'output utente (summary delle card). Estratti da lambda.js per riuso fra
// i runtime provider, così durate e conteggi sono leggibili ovunque invece di ms grezzi / numeri lunghi.

// Latenza leggibile: ms sotto il secondo, s fino al minuto, poi "Xm Ys" (245759ms → "4m 6s").
export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}

// «I primi N, e poi +M»: la stessa regola serve ai target fuori di un load balancer, alle istanze di un
// cluster RDS, ai security group aperti, agli allarmi attivi, ai secret mancanti e alle regole WAF. Era
// scritta sei volte in sei grafie diverse, e tre tagliavano SENZA dirlo — una lista troncata in silenzio
// fa concludere che gli elementi siano quelli, che è il modo peggiore di risparmiare caratteri.
//
// Niente `t`: «+3» non ha lingua. Passarlo dal dizionario aggiungeva una chiave da tenere allineata in
// due bundle e un modo di perdere tutto (con un `t` identità usciva la chiave al posto dei nomi).
export function truncateItems(items, max = 2) {
  return items.length > max ? [...items.slice(0, max), `+${items.length - max}`] : [...items]
}

export const truncateList = (items, max = 2) => truncateItems(items, max).join(', ')

// Conteggio compatto: 1234 → "1.2k", 9999 → "10k", 15000 → "15k", sotto 1000 invariato.
export function fmtCount(n) {
  if (!Number.isFinite(n)) return '—'
  const scale = (v, suffix) => v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, '') + suffix
  if (n >= 1e9) return scale(n / 1e9, 'B')
  if (n >= 1e6) return scale(n / 1e6, 'M') // 1.788M invece di 1788k
  if (n >= 1000) return scale(n / 1000, 'k')
  return String(n)
}
