// Le SERIE della vista «Andamento» della pagina Servizi: dalle serie per servizio di
// `/api/servizi/andamento` (una fascia per punto: richieste, errori 5xx, tempo di risposta di solito e
// nei momenti lenti) ai numeri della pagina. Puro e condiviso: i filtri di servizio e di ambiente si
// applicano nel browser, e rifare il giro per ogni filtro vorrebbe dire ripagare CloudWatch.
//
// Un servizio: { k, account, servizio, richieste: [], errori: [], p50: [], p90: [] } (ms; null = in
// quella fascia non c'e' stata una richiesta).
//
// Il problema da risolvere e' uno: i percentili non si sommano. CloudWatch da' il p50 e il p90 di ogni
// servizio in ogni fascia, ma la mediana di due servizi insieme (o di un servizio su un giorno intero)
// non e' la media delle mediane, ne' la mediana pesata delle mediane: con un servizio che fa il 90%
// del traffico a 200 ms e uno lento a 2 s, il p90 di tutte le richieste cade nel servizio lento, e
// ogni media lo nasconderebbe. Si ricostruisce allora la distribuzione di ogni pezzo dai suoi due
// percentili (vedi `cdf`) e si cerca il quantile della MISCELA, pesata con le richieste.

// La quota di richieste di un pezzo sotto `x` millisecondi, dai due punti che conosciamo: lo 0 a 0 ms,
// meta' al p50, nove decimi al p90. Oltre il p90 la coda non la conosce nessuno: si assume che arrivi
// a tutte al doppio del p90. Conta solo quando si mescolano pezzi diversi; per un pezzo solo il
// risultato e' esattamente il suo p50 e il suo p90. Puro.
export function cdf({ p50, p90 }, x) {
  if (x <= 0) return 0
  const a = Math.max(0, p50)
  const b = Math.max(a, p90)
  if (x < a) return (0.5 * x) / (a || 1)
  if (x < b) return 0.5 + (0.4 * (x - a)) / (b - a || 1)
  if (x < 2 * b) return 0.9 + (0.1 * (x - b)) / (b || 1)
  return 1
}

// Il quantile `q` della miscela dei pezzi `{ p50, p90, w }` (w = richieste). Bisezione: la cdf della
// miscela e' crescente, quaranta passi stanno sotto il millisecondo anche su minuti. Null se non c'e'
// nessun pezzo con richieste. Arrotondato al millisecondo. Puro.
export function quantileMisto(pezzi, q) {
  const validi = pezzi.filter((p) => p.w > 0 && Number.isFinite(p.p50) && Number.isFinite(p.p90))
  if (!validi.length) return null
  if (validi.length === 1) return Math.round(q <= 0.5 ? validi[0].p50 : q >= 0.9 ? validi[0].p90 : validi[0].p50 + ((q - 0.5) / 0.4) * (validi[0].p90 - validi[0].p50))
  const tot = validi.reduce((s, p) => s + p.w, 0)
  const f = (x) => validi.reduce((s, p) => s + p.w * cdf(p, x), 0) / tot
  let lo = 0
  let hi = Math.max(...validi.map((p) => 2 * Math.max(p.p50, p.p90))) || 1
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2
    if (f(m) < q) lo = m
    else hi = m
  }
  return Math.round(hi)
}

const pezzoDi = (s, i) => ({ p50: s.p50[i], p90: s.p90[i], w: s.richieste[i] })
const somma = (v) => v.reduce((a, b) => a + (b ?? 0), 0)

// Le serie di tutti i servizi scelti insieme, fascia per fascia: richieste ed errori sommati, tempo di
// risposta di solito e nei momenti lenti dalla miscela. Una fascia senza richieste ha la latenza null
// (un buco, non uno zero) e i conteggi a zero. Puro.
export function serieInsieme(servizi = [], punti = 0) {
  const fuori = { richieste: [], errori: [], tasso: [], p50: [], p90: [] }
  for (let i = 0; i < punti; i++) {
    const r = somma(servizi.map((s) => s.richieste[i]))
    const e = somma(servizi.map((s) => s.errori[i]))
    const pezzi = servizi.map((s) => pezzoDi(s, i))
    fuori.richieste.push(r)
    fuori.errori.push(e)
    fuori.tasso.push(r > 0 ? e / r : null)
    fuori.p50.push(quantileMisto(pezzi, 0.5))
    fuori.p90.push(quantileMisto(pezzi, 0.9))
  }
  return fuori
}

// I numeri di tutta la finestra: le richieste e gli errori contati, i tempi dalla miscela di tutte le
// fasce di tutti i servizi (una fascia con venti richieste non pesa quanto una con ventimila). Puro.
export function kpiAndamento(servizi = []) {
  const richieste = somma(servizi.flatMap((s) => s.richieste))
  const errori = somma(servizi.flatMap((s) => s.errori))
  const pezzi = servizi.flatMap((s) => s.richieste.map((_, i) => pezzoDi(s, i)))
  return {
    richieste,
    errori,
    tasso: richieste > 0 ? errori / richieste : null,
    p50: quantileMisto(pezzi, 0.5),
    p90: quantileMisto(pezzi, 0.9),
  }
}

// Quanto pesano gli errori: rosso dal 5% delle richieste, giallo dall'1%. Le stesse soglie delle
// build fallite della pagina Tempi sarebbero troppo larghe: una richiesta su dieci che fallisce e'
// gia' un servizio rotto per chi lo usa. Puro.
export function livelloErrori(tasso) {
  if (!Number.isFinite(tasso)) return null
  return tasso >= 0.05 ? 'crit' : tasso >= 0.01 ? 'warn' : null
}

// «1 su N»: quante richieste per un errore, a una cifra significativa (1 su 1.000, 1 su 400). Si legge
// meglio di 0,1% da chi non fa conti di percentuali, e la cifra sola dice che e' un ordine di
// grandezza, non una misura al decimale. Null senza richieste, 0 senza errori. Puro.
export function unoSu(errori, richieste) {
  if (!(richieste > 0)) return null
  if (!(errori > 0)) return 0
  const n = richieste / errori
  const p = 10 ** Math.floor(Math.log10(n))
  return Math.max(1, Math.round(n / p) * p)
}

// La tabella «servizio per servizio», dal peggiore: prima chi ha errori sopra soglia, poi dal piu'
// lento nei momenti lenti, che e' quello di cui si accorge chi usa il servizio. Puro.
export function righeAndamento(servizi = []) {
  const peso = { crit: 2, warn: 1 }
  return servizi
    .map((s) => ({ k: s.k, account: s.account, servizio: s.servizio, ...kpiAndamento([s]) }))
    .sort(
      (a, b) =>
        (peso[livelloErrori(b.tasso)] ?? 0) - (peso[livelloErrori(a.tasso)] ?? 0) ||
        (b.p90 ?? -1) - (a.p90 ?? -1) ||
        a.servizio.localeCompare(b.servizio),
    )
}

// I piccoli multipli: il tempo di risposta di solito per servizio, dal piu' lento, tutti sulla STESSA
// scala (con una scala per riga un servizio da 40 ms e uno da 2 s disegnerebbero la stessa collina). Il
// resto si conta, per dirlo sotto. Puro.
export function perServizioAndamento(servizi = [], { max = 12 } = {}) {
  const righe = servizi
    .map((s) => ({ k: s.k, account: s.account, servizio: s.servizio, p50: kpiAndamento([s]).p50, valori: s.p50 }))
    .filter((r) => r.p50 != null)
    .sort((a, b) => b.p50 - a.p50 || a.servizio.localeCompare(b.servizio))
  const scelte = righe.slice(0, max)
  const hi = Math.max(0, ...scelte.flatMap((r) => r.valori.filter(Number.isFinite)))
  return { righe: scelte, dominio: [0, hi], altri: Math.max(0, righe.length - max) }
}
