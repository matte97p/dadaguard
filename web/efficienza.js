// Efficienza, lato pagina: filtri, lenti, viste salvate e i conti su quello che il server manda
// (`/api/efficienza`). Tutto puro: la pagina disegna e basta, e qui si prova senza browser.

import { matchesAny } from './filters.js'

export const RISCHI = ['basso', 'medio']
export const COME = ['deploy', 'config', 'schedule', 'riavvio', 'migration']
export const IMPORTI = ['mese', 'anno', 'ultimo']
export const LENTI = ['risparmio', 'capacita', 'squadra']
export const SCHEDE = ['calcolo', 'database', 'chi']

export const PREDEFINITO = {
  lente: 'risparmio',
  squadra: [],
  risorsa: '',
  giorni: '30',
  prezzo: 'listino',
  importi: 'mese',
  rischio: RISCHI,
  come: COME,
  minimo: '0',
  scheda: 'calcolo',
}

// I blocchi di ogni lente, nell'ordine in cui compaiono. La lente non nasconde dati: sceglie quali
// domande vengono prima.
export const BLOCCHI = {
  risparmio: ['risposta'],
  capacita: ['semaforo', 'dettaglio'],
  squadra: ['chi', 'unita'],
}

const elenco = (v) => (v == null || v === '' ? [] : String(v).split(',').filter(Boolean))

// Stato dai parametri dell'indirizzo, così una vista si manda con un link. Un valore che non si
// riconosce torna al predefinito invece di filtrare a vuoto.
export function statoDaQuery(search) {
  const q = new URLSearchParams(search ?? '')
  const scegli = (k, ammessi) => (ammessi.includes(q.get(k)) ? q.get(k) : PREDEFINITO[k])
  const lista = (k, ammessi) => (q.has(k) ? elenco(q.get(k)).filter((x) => ammessi.includes(x)) : PREDEFINITO[k])
  return {
    lente: scegli('lente', LENTI),
    squadra: q.has('squadra') ? elenco(q.get('squadra')) : [],
    risorsa: scegli('risorsa', ['', 'ecs', 'rds']),
    giorni: scegli('giorni', ['7', '30', '90']),
    prezzo: scegli('prezzo', ['listino', 'netto']),
    importi: scegli('importi', IMPORTI),
    rischio: lista('rischio', RISCHI),
    come: lista('come', COME),
    minimo: scegli('minimo', ['0', '20', '100']),
    scheda: scegli('scheda', SCHEDE),
  }
}

// I soli parametri diversi dal predefinito: l'indirizzo resta corto e leggibile.
export function queryDaStato(stato) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(stato)) {
    const base = PREDEFINITO[k]
    if (Array.isArray(v)) {
      const uguale = v.length === base.length && v.every((x) => base.includes(x))
      if (!uguale) q.set(k, v.join(','))
    } else if (v !== base) q.set(k, v)
  }
  return q.toString()
}

// I filtri attivi, uno per chip, ognuno con lo stato che lo toglie.
export function filtriAttivi(stato) {
  const out = []
  if (stato.squadra.length) out.push({ k: 'squadra', valore: stato.squadra, togli: { squadra: [] } })
  if (stato.risorsa) out.push({ k: 'risorsa', valore: stato.risorsa, togli: { risorsa: '' } })
  if (stato.giorni !== PREDEFINITO.giorni) out.push({ k: 'giorni', valore: stato.giorni, togli: { giorni: PREDEFINITO.giorni } })
  if (stato.prezzo !== PREDEFINITO.prezzo) out.push({ k: 'prezzo', valore: stato.prezzo, togli: { prezzo: PREDEFINITO.prezzo } })
  if (stato.importi !== PREDEFINITO.importi) out.push({ k: 'importi', valore: stato.importi, togli: { importi: PREDEFINITO.importi } })
  if (stato.minimo !== PREDEFINITO.minimo) out.push({ k: 'minimo', valore: stato.minimo, togli: { minimo: PREDEFINITO.minimo } })
  for (const r of RISCHI) if (!stato.rischio.includes(r)) out.push({ k: 'senzaRischio', valore: r, togli: { rischio: [...stato.rischio, r] } })
  for (const c of COME) if (!stato.come.includes(c)) out.push({ k: 'senzaCome', valore: c, togli: { come: [...stato.come, c] } })
  return out
}

// Le viste pronte: combinazioni che rispondono a una domanda ricorrente. Quelle salvate da chi usa la
// pagina stanno nel browser (vedi `vistePersonali`), e si mandano anche come link.
export const VISTE_PRONTE = [
  { key: 'facili', stato: { rischio: ['basso'] } },
  { key: 'database', stato: { risorsa: 'rds', scheda: 'database' } },
  { key: 'capacita', stato: { lente: 'capacita' } },
  { key: 'unita', stato: { lente: 'squadra' } },
  { key: 'cfo', stato: { importi: 'anno', prezzo: 'netto', lente: 'squadra' } },
]
export function statoVista(vista) {
  return { ...PREDEFINITO, ...vista.stato }
}
export function vistaAttiva(stato, viste) {
  const q = queryDaStato(stato)
  return viste.find((v) => queryDaStato(statoVista(v)) === q)?.key ?? null
}

const CHIAVE_VISTE = 'dg-efficienza-viste'
export function vistePersonali(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(CHIAVE_VISTE) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => x?.key && x?.nome && x?.query != null) : []
  } catch {
    return []
  }
}
export function salvaViste(viste, storage = globalThis.localStorage) {
  try {
    storage?.setItem(CHIAVE_VISTE, JSON.stringify(viste))
  } catch {
    // browser senza storage: la vista resta nell'indirizzo, che si può salvare come segnalibro
  }
}

// Quanto della fattura resta dopo crediti e sconti: fatturato su listino dell'ultimo mese CHIUSO,
// sommato sugli account che Spesa legge. Senza dati: 1, cioè il listino.
export function fattoreNetto(trend) {
  let listino = 0
  let pagato = 0
  for (const a of Object.values(trend ?? {})) {
    const chiusi = (a?.months ?? []).filter((m) => !m.partial)
    const ultimo = chiusi[chiusi.length - 1]
    if (!ultimo) continue
    listino += Number(ultimo.usage ?? 0)
    pagato += Number(ultimo.invoiced ?? 0)
  }
  if (listino <= 0) return 1
  return Math.max(0, Math.min(1, pagato / listino))
}

// Un importo mensile a listino nella forma scelta (al mese o all'anno, listino o netto).
export function importo(usdMese, stato, netto = 1) {
  if (usdMese == null) return null
  return usdMese * (stato.importi === 'anno' ? 12 : 1) * (stato.prezzo === 'netto' ? netto : 1)
}

const SENZA = '__senza__'
export const squadraDi = (x) => x?.squadra ?? SENZA
export const SENZA_SQUADRA = SENZA

// Tutti i conti della pagina sul sottoinsieme scelto: account (dal selettore d'ambiente in alto),
// squadra, risorsa, e per le leve rischio, modo di applicarle e minimo.
export function filtra(dati, stato, accountFilter = []) {
  const vuoto = { servizi: [], database: [], leve: [], base: 0, recuperabile: 0, giornaliero: [], squadre: [], ambienti: [], unita: [], usata: null }
  if (!dati) return vuoto
  const passa = (x) => matchesAny(x.account, accountFilter) && (!stato.squadra.length || stato.squadra.includes(squadraDi(x)))
  const servizi = stato.risorsa === 'rds' ? [] : (dati.servizi ?? []).filter(passa)
  const database = stato.risorsa === 'ecs' ? [] : (dati.database ?? []).filter(passa)
  // Una leva di tutto l'ambiente (lo spegnimento fuori orario) porta il risparmio per squadra: con il
  // filtro per squadra vale solo la parte delle squadre scelte.
  const quota = (l) => {
    if (!stato.squadra.length || !l.dati?.perSquadra) return l
    const usdMese = Object.entries(l.dati.perSquadra)
      .filter(([k]) => stato.squadra.includes(k === '' ? SENZA : k))
      .reduce((a, [, v]) => a + v, 0)
    return { ...l, usdMese, squadra: null }
  }
  const leve = (dati.leve ?? []).map(quota).filter(
    (l) =>
      l.usdMese > 0.5 &&
      matchesAny(l.account, accountFilter) &&
      (!stato.squadra.length || l.dati?.perSquadra || stato.squadra.includes(squadraDi(l))) &&
      (!stato.risorsa || l.risorsa === stato.risorsa) &&
      stato.rischio.includes(l.rischio) &&
      stato.come.includes(l.come) &&
      l.usdMese >= Number(stato.minimo),
  )
  const base = [...servizi, ...database].reduce((a, x) => a + (x.usdMese ?? 0), 0)
  const recuperabile = leve.reduce((a, l) => a + l.usdMese, 0)

  // Pagato contro usato, giorno per giorno, sui servizi scelti.
  const perGiorno = new Map()
  for (const s of servizi) {
    for (const g of s.giornaliero ?? []) {
      const d = perGiorno.get(g.giorno) ?? { giorno: g.giorno, pagate: 0, usate: 0 }
      d.pagate += g.pagate
      d.usate += g.usate
      perGiorno.set(g.giorno, d)
    }
  }
  const giornaliero = [...perGiorno.values()].sort((a, b) => a.giorno.localeCompare(b.giorno))
  const pagate = giornaliero.reduce((a, g) => a + g.pagate, 0)
  const usata = pagate > 0 ? giornaliero.reduce((a, g) => a + g.usate, 0) / pagate : null

  // Chi spende: per squadra e per ambiente, calcolo e database insieme.
  const somma = (chiave) => {
    const m = new Map()
    for (const x of [...servizi, ...database]) m.set(chiave(x), (m.get(chiave(x)) ?? 0) + (x.usdMese ?? 0))
    return [...m.entries()].map(([k, usd]) => ({ k, usd })).sort((a, b) => b.usd - a.usd)
  }

  // Costo per unità: i servizi dietro un load balancer, sulle richieste del periodo.
  const giorni = Number(stato.giorni)
  const unita = servizi
    .filter((s) => s.richieste > 0 && s.usdMese != null)
    .map((s) => {
      const usd = (s.usdMese * giorni * 12) / 365
      return { account: s.account, nome: s.nome, squadra: s.squadra, richieste: s.richieste, usd, per1000: usd / (s.richieste / 1000) }
    })
    .sort((a, b) => b.usd - a.usd)

  return { servizi, database, leve, base, recuperabile, giornaliero, squadre: somma(squadraDi), ambienti: somma((x) => x.account), unita, usata }
}

// Le squadre presenti nei dati, per il filtro: dedotte dai tag, mai scritte a mano.
export function squadreDisponibili(dati) {
  const s = new Set([...(dati?.servizi ?? []), ...(dati?.database ?? [])].map(squadraDi))
  return [...s].sort((a, b) => (a === SENZA) - (b === SENZA) || a.localeCompare(b))
}

// La settimana tipo degli account scelti che non sono produzione, sommata: la mappa delle ore.
export function settimanaNonProd(dati, accountFilter = []) {
  const chiavi = Object.entries(dati?.accounts ?? {})
    .filter(([k, a]) => a.nonProd && matchesAny(k, accountFilter))
    .map(([k]) => k)
  if (!chiavi.length) return null
  const out = new Array(168).fill(null)
  for (const k of chiavi) {
    ;(dati.settimane?.[k] ?? []).forEach((v, i) => {
      if (v != null) out[i] = (out[i] ?? 0) + v
    })
  }
  return { chiavi, celle: out }
}

// La settimana tipo è in ore UTC (lunedì 00 = cella 0): per mostrarla nell'ora di chi guarda si
// ruota dello scarto del fuso, in ore intere.
export function ruotaSettimana(celle, scartoMinuti = 0) {
  const ore = Math.round(-scartoMinuti / 60)
  if (!ore) return celle
  return celle.map((_, i) => celle[(((i - ore) % 168) + 168) % 168])
}

// Soglie del semaforo: sopra «a tappo» non c'è margine per un picco, sotto «spreco» si paga capacità ferma.
export const SOGLIA_TAPPO = { cpu: 80, mem: 85, memLibera: 10 }

// Capacità in due colonne: dove si paga più del necessario (c'è una taglia più piccola) e dove non c'è
// più margine (picco alto). Ogni riga porta il motivo in numeri, senza gergo; l'ordine è per costo.
export function semaforo(f) {
  const spreco = []
  const tappo = []
  const sani = []
  const nodati = []
  const risparmio = (tipo, nome, account) => f.leve.find((l) => l.oggetto === nome && l.account === account && (tipo === 'db' ? l.tipo === 'rds-taglia' : l.tipo === 'taglia'))?.usdMese ?? null
  for (const s of f.servizi) {
    const base = { tipo: 'calcolo', nome: s.nome, account: s.account, usdMese: s.usdMese, cpu: s.cpuP95, mem: s.memP95, taglia: s.cpu ? `${s.cpu / 1024} vCPU · ${s.memMb / 1024} GB` : null, oraria: s.oraria ?? null }
    if (s.cpuP95 != null && s.cpuP95 >= SOGLIA_TAPPO.cpu) tappo.push({ ...base, stato: 'tappo', motivo: 'cpu', valore: s.cpuP95 })
    else if (s.memP95 != null && s.memP95 >= SOGLIA_TAPPO.mem) tappo.push({ ...base, stato: 'tappo', motivo: 'mem', valore: s.memP95 })
    else if (s.proposta) spreco.push({ ...base, stato: 'spreco', motivo: 'taglia', risparmio: risparmio('calcolo', s.nome, s.account) })
    else if (s.cpuP95 == null && s.memP95 == null) nodati.push({ ...base, stato: 'nodati' })
    else sani.push({ ...base, stato: 'sano' })
  }
  for (const d of f.database) {
    // Nei database la colonna è la memoria LIBERA: la si porta a «usata» così le due barre dicono la stessa cosa.
    const base = { tipo: 'db', nome: d.id, account: d.account, usdMese: d.usdMese, cpu: d.cpuP95, mem: d.memLiberaMin == null ? null : 100 - d.memLiberaMin, taglia: d.classe ?? null, oraria: d.oraria ?? null }
    if (d.cpuP95 != null && d.cpuP95 >= SOGLIA_TAPPO.cpu) tappo.push({ ...base, stato: 'tappo', motivo: 'cpu', valore: d.cpuP95 })
    else if (d.memLiberaMin != null && d.memLiberaMin < SOGLIA_TAPPO.memLibera) tappo.push({ ...base, stato: 'tappo', motivo: 'memDb', valore: d.memLiberaMin })
    else if (d.proposta) spreco.push({ ...base, stato: 'spreco', motivo: 'taglia', risparmio: risparmio('db', d.id, d.account) })
    else if (d.cpuP95 == null && d.memLiberaMin == null) nodati.push({ ...base, stato: 'nodati' })
    else sani.push({ ...base, stato: 'sano' })
  }
  const perCosto = (a, b) => (b.risparmio ?? b.usdMese ?? 0) - (a.risparmio ?? a.usdMese ?? 0)
  const costo = (a, b) => (b.usdMese ?? 0) - (a.usdMese ?? 0)
  spreco.sort(perCosto)
  tappo.sort(perCosto)
  sani.sort(costo)
  nodati.sort(costo)
  // Un elenco solo: prima chi è al limite, poi chi spreca, poi i sani e chi non ha misure.
  return { spreco, tappo, sani, nodati, tutti: [...tappo, ...spreco, ...sani, ...nodati] }
}

// «Da dove partire»: le poche cose da fare, in ordine. Prima i rischi (chi è a tappo), poi le leve di
// risparmio dalla più redditizia, fino a `max` voci in tutto.
export function partenza(f, sem, max = 5) {
  const rischi = sem.tappo.slice(0, 2)
  const risparmi = [...f.leve].sort((a, b) => b.usdMese - a.usdMese).slice(0, Math.max(0, max - rischi.length))
  return { rischi, risparmi, usd: risparmi.reduce((a, l) => a + l.usdMese, 0) }
}

// L'ultimo mese CHIUSO fatturato (quello in corso è `partial` e non conta), sommato sugli account che
// Spesa legge. Torna { mese: 'YYYY-MM', usage, invoiced } oppure null senza dati.
export function ultimoMeseChiuso(trend) {
  const per = new Map()
  for (const a of Object.values(trend ?? {})) {
    const chiusi = (a?.months ?? []).filter((m) => !m.partial)
    const m = chiusi[chiusi.length - 1]
    if (!m?.month) continue
    const x = per.get(m.month) ?? { mese: m.month, usage: 0, invoiced: 0 }
    x.usage += Number(m.usage ?? 0)
    x.invoiced += Number(m.invoiced ?? 0)
    per.set(m.month, x)
  }
  if (!per.size) return null
  // Se gli account non chiudono lo stesso mese, vale il più recente.
  return [...per.values()].sort((a, b) => b.mese.localeCompare(a.mese))[0]
}
