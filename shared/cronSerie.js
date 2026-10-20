// Le SERIE della vista «Andamento» dei cron: dalle righe di `/api/runs/storico` (una per cron, gia' in
// fasce) ai totali per fascia del grafico, alle tessere in cima, ai piccoli multipli e alla tabella. Nel
// browser e non nel server, come per i tempi dei deploy (shared/tempiSerie.js): scegliere un cron o un
// account non rifa' il giro di CloudWatch.
//
// Una riga: { k, nome, account, tipo, acceso, esitoLetto, corse[], riuscite[], fallite[], nonLette[],
// saltate[], p50[], p90[], finestra: { p50, p90, n }, ultima }. Nelle serie `null` e' «non lo so» (fuori
// dallo storico, schedule non calcolabile) e resta un buco: non e' uno zero.

// Somma per fascia di un campo su piu' righe; una fascia null in TUTTE le righe resta null. Pura.
export function sommaFasce(righe = [], campo, punti) {
  return Array.from({ length: punti }, (_, i) => {
    let s = null
    for (const r of righe) {
      const v = r[campo]?.[i]
      if (v != null) s = (s ?? 0) + v
    }
    return s
  })
}

const totale = (valori = []) => valori.reduce((a, v) => a + (v ?? 0), 0)

// Quantile PESATO, a gradini: il valore sotto cui sta la quota `q` del peso. Serve a dire «di solito»
// su piu' cron insieme, dove di ogni fascia si sa la durata tipica e quante corse ci sono state, non la
// durata di ogni corsa: una fascia di cento corse pesa cento volte una di una corsa sola. Puro.
export function quantilePesato(coppie = [], q) {
  const v = coppie.filter((c) => Number.isFinite(c?.v) && c.w > 0).sort((a, b) => a.v - b.v)
  const tot = v.reduce((s, c) => s + c.w, 0)
  if (!tot) return null
  let cum = 0
  for (const c of v) {
    cum += c.w
    if (cum >= q * tot) return c.v
  }
  return v.at(-1).v
}

// Durata tipica (o dei giorni lenti) di una fascia su piu' cron. Con un cron solo e' la sua. Puro.
const durataFascia = (righe, campo, i) => quantilePesato(righe.map((r) => ({ v: r[campo]?.[i], w: r.corse?.[i] ?? 0 })), campo === 'p90' ? 0.9 : 0.5)

// Le serie del grafico a colonne e delle tessere. Puro.
export function serieCron(righe = [], { inizio, passoMs, punti } = {}) {
  const somma = (campo) => sommaFasce(righe, campo, punti)
  return {
    inizio,
    passoMs,
    punti,
    corse: somma('corse'),
    riuscite: somma('riuscite'),
    fallite: somma('fallite'),
    saltate: somma('saltate'),
    nonLette: somma('nonLette'),
    p50: Array.from({ length: punti }, (_, i) => durataFascia(righe, 'p50', i)),
    p90: Array.from({ length: punti }, (_, i) => durataFascia(righe, 'p90', i)),
  }
}

// I numeri dell'intera finestra. La quota in cima e' «senza problemi noti»: su tutte le volte che un cron
// doveva partire (corse piu' saltate), quelle senza una fallita o una saltata. Una corsa ECS con l'esito
// non letto sta nel totale come PARTITA, non come riuscita: la pagina lo dice con un'altra frase
// («senza problemi noti» invece di «bene»). Tenerla fuori dal totale non funzionava: un job con 29
// corse e una saltata diventava «0 su 1», cioe' 0%, e accanto a una Lambda sana dava «100%, 1 saltata».
// Puro.
export function kpiCron(righe = []) {
  const somma = (campo) => righe.reduce((s, r) => s + totale(r[campo]), 0)
  const corse = somma('corse')
  const riuscite = somma('riuscite')
  const fallite = somma('fallite')
  const saltate = somma('saltate')
  const nonLette = somma('nonLette')
  const noti = corse + saltate
  const problemi = fallite + saltate
  const conEsito = riuscite + fallite
  // La durata: di un cron solo quella che il server ha calcolato sulla finestra intera (esatta); di piu'
  // cron insieme il quantile pesato delle fasce (una stima: la mediana delle mediane non e' la mediana).
  const coppie = (campo) => righe.flatMap((r) => (r[campo] ?? []).map((v, i) => ({ v, w: r.corse?.[i] ?? 0 })))
  const durata =
    righe.length === 1
      ? righe[0].finestra ?? null
      : coppie('p50').some((c) => Number.isFinite(c.v) && c.w > 0)
        ? { p50: quantilePesato(coppie('p50'), 0.5), p90: quantilePesato(coppie('p90'), 0.9) }
        : null
  return {
    corse,
    riuscite,
    fallite,
    saltate,
    nonLette,
    noti,
    // Mai 100% con un fallimento dentro: 999 su 1000 arrotondato direbbe «sempre».
    quotaBene: noti ? (problemi === 0 ? 100 : Math.min(99, Math.floor(((noti - problemi) / noti) * 100))) : null,
    tassoFallite: conEsito ? fallite / conEsito : null,
    conEsito,
    durata,
  }
}

// «Piu' lento del solito»: la durata tipica delle ultime fasce con corse (l'ultimo quarto della
// finestra) contro quella delle fasce prima. Un terzo in piu' e almeno mezzo minuto: un job da due
// secondi che ne fa tre non e' una notizia. Puro.
export function rallentato(r, { quota = 1.3, minimoMs = 30_000 } = {}) {
  const valori = r.p50 ?? []
  const taglio = Math.floor(valori.length * 0.75)
  const mediana = (xs) => quantilePesato(xs.map((v) => ({ v, w: 1 })), 0.5)
  const prima = mediana(valori.slice(0, taglio).filter(Number.isFinite))
  const dopo = mediana(valori.slice(taglio).filter(Number.isFinite))
  if (prima == null || dopo == null) return null
  return dopo > prima * quota && dopo - prima >= minimoMs ? { prima, dopo } : null
}

// La tabella «Cron per cron», dal peggiore: chi ha fallito o saltato di piu', poi chi e' rallentato, poi
// per nome. Puro.
export function righeTabella(righe = []) {
  return righe
    .map((r) => {
      const fallite = r.esitoLetto ? totale(r.fallite) : null
      const saltate = r.saltate?.some((v) => v != null) ? totale(r.saltate) : null
      return {
        ...r,
        tot: { corse: totale(r.corse), fallite, saltate, conEsito: r.esitoLetto ? totale(r.riuscite) + totale(r.fallite) : null },
        lento: rallentato(r),
      }
    })
    .sort(
      (a, b) =>
        (b.tot.fallite ?? 0) + (b.tot.saltate ?? 0) - ((a.tot.fallite ?? 0) + (a.tot.saltate ?? 0)) ||
        (b.tot.fallite ?? 0) - (a.tot.fallite ?? 0) ||
        Number(Boolean(b.lento)) - Number(Boolean(a.lento)) ||
        Number(Boolean(b.errore)) - Number(Boolean(a.errore)) ||
        a.nome.localeCompare(b.nome),
    )
}

// I piccoli multipli: la durata tipica per fascia di ogni cron, da chi ci mette di piu', tutti sulla
// STESSA scala (`dominio`): con una scala per riga un job da un'ora e una Lambda da un secondo
// disegnerebbero la stessa collina. Puro.
export function perCron(righe = [], { max = 12 } = {}) {
  const conDurate = righe.filter((r) => (r.p50 ?? []).some(Number.isFinite))
  const ordinate = [...conDurate].sort((a, b) => (b.finestra?.p50 ?? 0) - (a.finestra?.p50 ?? 0) || a.nome.localeCompare(b.nome)).slice(0, max)
  const hi = Math.max(0, ...ordinate.flatMap((r) => r.p50.filter(Number.isFinite)))
  return { righe: ordinate, dominio: [0, hi], altri: Math.max(0, conDurate.length - max) }
}
