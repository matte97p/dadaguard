// Le SERIE della dashboard della spesa giorno per giorno (Spesa, scheda Andamento): dal valore al giorno
// per servizio che manda `/api/costs/daily` alle colonne impilate, alle tessere in cima, ai piccoli
// multipli e alla tabella. Si fanno nel browser, come shared/tempiSerie.js: cambiare servizio o account
// non deve rifare una chiamata a Cost Explorer, che si paga 0,01 $ l'una.
//
// Un conto (uno per account): { giorni: ['AAAA-MM-GG', ...], servizi: [{ servizio, ai, valori }],
// crediti, tasse, oggi }. I giorni sono quelli di Cost Explorer, in UTC (il conto AWS si chiude in UTC);
// `valori` e' il CONSUMO a listino del servizio giorno per giorno, prima di crediti e tasse, che
// arrivano a parte (negativi i crediti). Tutto puro: lo provano test/spesaSerie.test.js.

const GIORNO = 86_400_000

// Quanti servizi hanno un colore loro nelle colonne impilate: i quattro colori dei grafici di app.css,
// gia' validati per chiaro e scuro. Dal quinto in poi un colore in piu' non si distingue, e il resto
// va in «Altri», grigio.
export const COLORI = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)']
export const COLORE_ALTRI = 'var(--chart-neutro)'
export const ALTRI = '__altri'

// Proiezione di fine mese ("run-rate"): la spesa MTD estrapolata linearmente sui giorni del mese,
// "a questo ritmo, a fine mese avrai speso X". Deterministica, niente ML/GetCostForecast (coerente con
// l'ethos no-LLM dell'app; nessuna chiamata extra a pagamento ne' permesso IAM in piu'):
//   factor = giorniDelMese / giorniTrascorsi.
// Deriva tutto dal `period` (start incluso, end ESCLUSIVO = domani per il mese corrente), quindi per
// un mese PASSATO i giorni trascorsi eguagliano quelli del mese, factor 1, nessuna estrapolazione
// (ritorna null). Proietta sia il netto (post-crediti) sia il lordo (consumo). NB early-month = pochi
// giorni, factor alto e stima rumorosa: il chiamante mostra sempre la base "su X/Y giorni" cosi' e'
// trasparente. Sta qui e non in server/costs.js (che la riesporta) perche' la usa anche la pagina, per
// la proiezione di un servizio solo: quel numero dal server non arriva. Pura/testabile.
export function monthEndProjection({ gross = 0, total = 0, period } = {}) {
  if (!period?.start || !period?.end) return null
  const start = new Date(`${period.start}T00:00:00Z`)
  const end = new Date(`${period.end}T00:00:00Z`) // esclusivo
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
  const daysElapsed = Math.round((end - start) / 86_400_000) // giorni coperti dall'MTD (end esclusivo)
  if (daysElapsed <= 0 || daysElapsed >= daysInMonth) return null // mese completo, niente da proiettare
  const factor = daysInMonth / daysElapsed
  return {
    daysElapsed,
    daysInMonth,
    pct: Math.round((daysElapsed / daysInMonth) * 100),
    gross: gross * factor,
    net: total * factor,
  }
}

// La mediana: e' il «di solito» della pagina. Non la media: un giorno con un rilascio di modelli da
// 900 $ alzerebbe la media di tutto il mese, e «di solito» smetterebbe di voler dire di solito.
export function mediana(valori = []) {
  const v = valori.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

const somma = (v = []) => v.reduce((s, x) => s + (Number(x) || 0), 0)
// Al centesimo: sommando decine di importi a virgola mobile si arriva a 1240.0000000002, che nella
// tabella non si vede ma in un confronto «uguale a zero» si'.
const cent = (x) => Math.round(x * 100) / 100

// Il giorno dopo, in 'AAAA-MM-GG' (UTC, come i giorni di Cost Explorer).
export function giornoDopo(g) {
  const d = new Date(`${g}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// La mezzanotte LOCALE di un giorno 'AAAA-MM-GG': e' dove il grafico mette la colonna, cosi' le tacche
// dell'asse (che cadono sulle mezzanotti locali) dicono lo stesso giorno della colonna.
export function mezzanotte(g) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(g ?? ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN
}

// L'asse del tempo dei grafici (`{ inizio, passoMs, punti }`, la forma di web/ui/Grafici.jsx): una
// colonna per giorno, dalla mezzanotte locale del primo.
export function grigliaGiorni(giorni = []) {
  return { inizio: giorni.length ? mezzanotte(giorni[0]) : 0, passoMs: GIORNO, punti: giorni.length }
}

// Gli account visibili in un conto solo: le date sono l'unione (un account aggiunto ieri ha meno
// giorni), lo stesso servizio in due account si somma. Puro.
export function unisciConti(conti = []) {
  const giorni = [...new Set(conti.flatMap((c) => c?.giorni ?? []))].sort()
  const pos = new Map(giorni.map((g, i) => [g, i]))
  const zeri = () => giorni.map(() => 0)
  const crediti = zeri()
  const tasse = zeri()
  const servizi = new Map()
  for (const c of conti) {
    if (!c) continue
    const suoi = c.giorni ?? []
    suoi.forEach((g, j) => {
      const i = pos.get(g)
      crediti[i] += Number(c.crediti?.[j]) || 0
      tasse[i] += Number(c.tasse?.[j]) || 0
    })
    for (const s of c.servizi ?? []) {
      if (!servizi.has(s.servizio)) servizi.set(s.servizio, { servizio: s.servizio, ai: Boolean(s.ai), valori: zeri() })
      const r = servizi.get(s.servizio)
      suoi.forEach((g, j) => {
        r.valori[pos.get(g)] += Number(s.valori?.[j]) || 0
      })
    }
  }
  const oggi = conti.map((c) => c?.oggi).filter(Boolean).sort().at(-1) ?? giorni.at(-1) ?? null
  return {
    giorni,
    servizi: [...servizi.values()].map((s) => ({ ...s, valori: s.valori.map(cent) })),
    crediti: crediti.map(cent),
    tasse: tasse.map(cent),
    oggi,
  }
}

// Gli ultimi `n` giorni. Il server ne manda anche di piu' quando il mese e' piu' lungo della finestra
// (il 31 con la finestra di 30 giorni), perche' «questo mese finora» deve contare dal primo. Puro.
export function ultimi(dati, n) {
  const da = Math.max(0, (dati?.giorni?.length ?? 0) - n)
  const taglia = (v = []) => v.slice(da)
  return {
    ...dati,
    giorni: taglia(dati?.giorni),
    servizi: (dati?.servizi ?? []).map((s) => ({ ...s, valori: taglia(s.valori) })),
    crediti: taglia(dati?.crediti),
    tasse: taglia(dati?.tasse),
  }
}

// Solo i servizi scelti (lista vuota = tutti). Crediti e tasse non hanno un servizio: con un filtro
// attivo si azzerano, come fa Cost Explorer con un filtro sul servizio. Puro.
export function soloServizi(dati, scelti = []) {
  if (!scelti.length) return dati
  const voluti = new Set(scelti)
  const zeri = (dati?.giorni ?? []).map(() => 0)
  return { ...dati, servizi: (dati?.servizi ?? []).filter((s) => voluti.has(s.servizio)), crediti: zeri, tasse: [...zeri] }
}

// Il totale di ogni giorno, sommato sui servizi. Puro.
export function totaliGiorno(dati) {
  const tot = (dati?.giorni ?? []).map(() => 0)
  for (const s of dati?.servizi ?? []) s.valori.forEach((v, i) => (tot[i] += v))
  return tot.map(cent)
}

// I servizi dal piu' caro, col totale della finestra. A parita', per nome: l'ordine non deve cambiare
// da un caricamento all'altro. Puro.
export function classifica(dati) {
  return (dati?.servizi ?? [])
    .map((s) => ({ ...s, totale: cent(somma(s.valori)) }))
    .filter((s) => s.totale > 0.005)
    .sort((a, b) => b.totale - a.totale || a.servizio.localeCompare(b.servizio))
}

// Il colore di ogni servizio: i primi quattro per spesa sulla finestra, in ordine. Va calcolato sui
// dati SENZA filtri (tutti gli account, tutti i servizi): cosi' scegliere un servizio o un account non
// ridipinge le colonne, e il colore segue il servizio e mai il suo posto in classifica di un giorno.
export function coloriServizi(dati) {
  return new Map(classifica(dati).slice(0, COLORI.length).map((s, i) => [s.servizio, COLORI[i]]))
}

// Le colonne impilate: i servizi col loro colore, nell'ordine dei colori (il piu' caro in basso, cosi'
// la base della colonna e' sempre lui e si confronta a occhio fra un giorno e l'altro), e tutto il
// resto in una fetta sola. Se il resto e' un servizio solo (un filtro su un servizio senza colore) la
// fetta porta il suo nome invece di «Altri». Puro.
export function seriePila(dati, colori) {
  const servizi = dati?.servizi ?? []
  const col = servizi.filter((s) => colori.has(s.servizio)).sort((a, b) => [...colori.keys()].indexOf(a.servizio) - [...colori.keys()].indexOf(b.servizio))
  const resto = servizi.filter((s) => !colori.has(s.servizio) && s.valori.some((v) => Math.abs(v) > 0.005))
  const pezzi = col.map((s) => ({ k: s.servizio, servizio: s.servizio, colore: colori.get(s.servizio), valori: s.valori }))
  if (resto.length === 1) pezzi.push({ k: resto[0].servizio, servizio: resto[0].servizio, colore: COLORE_ALTRI, valori: resto[0].valori })
  else if (resto.length > 1) {
    const valori = (dati.giorni ?? []).map((_, i) => cent(somma(resto.map((s) => s.valori[i]))))
    pezzi.push({ k: ALTRI, servizio: null, colore: COLORE_ALTRI, valori, quanti: resto.length })
  }
  return pezzi
}

// Gli indici dei giorni INTERI: tutti tranne oggi, che e' a meta' (e Cost Explorer resta indietro di
// qualche ora). Con oggi dentro, «di solito» e il confronto fra settimane scenderebbero ogni mattina.
const interi = (dati) => (dati?.giorni ?? []).map((g, i) => [g, i]).filter(([g]) => !dati.oggi || g < dati.oggi).map(([, i]) => i)

// Il NETTO di ogni giorno: consumo a listino + crediti (negativi) + tasse, la stessa regola del mese
// (aggregateMonth in server/costs.js) applicata giorno per giorno. E' quanto si paga davvero; con un
// filtro sul servizio crediti e tasse sono a zero (vedi soloServizi) e il netto torna il listino. Puro.
export function nettiGiorno(dati) {
  return totaliGiorno(dati).map((v, i) => cent(v + (dati.crediti?.[i] ?? 0) + (dati.tasse?.[i] ?? 0)))
}

// Le tessere in cima. `tutto` sono i dati interi (il mese puo' cominciare prima della finestra),
// `n` la finestra in giorni. Il mese e' quello UTC di oggi, come per /api/costs. Il numero grande e'
// il NETTO, come nel verdetto in cima alla pagina Spesa: e' quello che si paga. Il listino resta
// accanto (`lordo`, `gross`), perche' e' quello che si paghera' a crediti finiti. Puro.
export function kpiSpesa(tutto, n) {
  const oggi = tutto?.oggi
  const tot = totaliGiorno(tutto)
  const netti = nettiGiorno(tutto)
  const mese = oggi ? oggi.slice(0, 7) : null
  const delMese = mese ? tutto.giorni.map((g, i) => [g, i]).filter(([g]) => g.startsWith(mese) && g <= oggi) : []
  const inizioMese = mese ? `${mese}-01` : null
  // Il numero di oggi e quello di ogni giorno passato del mese: le tessere ne disegnano l'andamento.
  let cumL = 0
  let cumN = 0
  const listino = delMese.map(([, i]) => cent((cumL += tot[i])))
  const cumulato = delMese.map(([, i]) => cent((cumN += netti[i])))
  const proiezioni = delMese.map(([g], k) => {
    const p = monthEndProjection({ gross: listino[k], total: cumulato[k], period: { start: inizioMese, end: giornoDopo(g) } })
    return p ? cent(p.net) : cumulato[k]
  })
  const lordo = listino.at(-1) ?? 0
  const netto = cumulato.at(-1) ?? 0
  const proiezione = mese && delMese.length ? monthEndProjection({ gross: lordo, total: netto, period: { start: inizioMese, end: giornoDopo(oggi) } }) : null

  // «Di solito» e «il piu' caro» anche loro al netto, sui giorni interi della finestra.
  const fin = ultimi(tutto, n)
  const nettiFin = nettiGiorno(fin)
  const idx = interi(fin)
  const giornalieri = idx.map((i) => nettiFin[i])
  const caro = idx.reduce((m, i) => (m == null || nettiFin[i] > nettiFin[m] ? i : m), null)
  return {
    mese: delMese.length ? { netto, lordo, conCrediti: Math.abs(netto - lordo) > 0.005, cumulato, giorni: delMese.length } : null,
    proiezione: proiezione ? { ...proiezione, gross: cent(proiezione.gross), net: cent(proiezione.net), andamento: proiezioni } : delMese.length ? { gross: lordo, net: netto, chiuso: true, andamento: proiezioni } : null,
    alGiorno: giornalieri.length ? { valore: cent(mediana(giornalieri)), andamento: giornalieri } : null,
    piuCaro: caro != null && nettiFin[caro] > 0.005 ? { giorno: fin.giorni[caro], valore: nettiFin[caro], andamento: giornalieri } : null,
  }
}

// Una settimana contro quella prima, sui giorni interi: la variazione in frazione (0,12 = +12%),
// `null` se la settimana prima non c'e' tutta o non c'era spesa (allora `nuovo` dice se ora c'e').
function settimane(valori, idx) {
  const ult = idx.slice(-7)
  const prima = idx.slice(-14, -7)
  const a = somma(ult.map((i) => valori[i]))
  const b = somma(prima.map((i) => valori[i]))
  if (prima.length < 7) return { ultimi: cent(a), prima: null, variazione: null, nuovo: false }
  return { ultimi: cent(a), prima: cent(b), variazione: b > 0.005 ? (a - b) / b : null, nuovo: b <= 0.005 && a > 0.005 }
}

// La tabella «Servizio per servizio», dal piu' caro. `base` e' il totale su cui si calcola la quota:
// quello di TUTTI i servizi degli account visibili, anche quando la tabella ne mostra uno solo, perche'
// «il 40% della spesa» deve voler dire della spesa, non di se stesso. Puro.
export function tabellaServizi(dati, { base } = {}) {
  const idx = interi(dati)
  const righe = classifica(dati)
  const tot = base ?? somma(righe.map((r) => r.totale))
  return righe.map((r) => ({
    servizio: r.servizio,
    ai: r.ai,
    totale: r.totale,
    solito: cent(mediana(idx.map((i) => r.valori[i])) ?? 0),
    settimana: settimane(r.valori, idx),
    quota: tot > 0.005 ? r.totale / tot : null,
  }))
}

// I piccoli multipli: i `max` servizi piu' cari, tutti sulla STESSA scala (`dominio`). Con una scala
// per riga un servizio da 3 $ al giorno e uno da 300 disegnano la stessa collina, e quello che cresce
// davvero non si vede. Puro.
export function multipliSpesa(dati, { max = 10 } = {}) {
  const tutti = classifica(dati)
  const righe = tutti.slice(0, max)
  const hi = Math.max(0, ...righe.flatMap((r) => r.valori.filter(Number.isFinite)))
  return { righe, dominio: [0, hi], altri: Math.max(0, tutti.length - max) }
}
