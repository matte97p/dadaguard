// Prossima esecuzione di uno schedule EventBridge. Puro/testabile, tutto in UTC (come EventBridge).
// Supporta `cron(min hour dom month dow year)`. Per `rate(...)` ritorna null: senza l'istante di
// creazione/abilitazione della regola non è possibile sapere QUANDO ricade il prossimo tick.
// Caratteri avanzati (L/W/#) non supportati → null (nessuna stima inventata).
//
// Numerazione AWS: giorno-della-settimana 1=DOM … 7=SAB; mese 1-12. Nomi (JAN.., SUN..) ammessi.

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 }
const DOWS = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 }

function nameOrNum(tok, names) {
  const s = String(tok).trim().toUpperCase()
  if (s in names) return names[s]
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  return null // L/W/# o spazzatura → non gestito
}

// Espande un campo cron in un Set di valori ammessi. Ritorna null se non parsabile (→ niente stima).
function parseField(spec, min, max, names = {}) {
  const set = new Set()
  for (const partRaw of String(spec).split(',')) {
    let part = partRaw.trim()
    if (part === '*' || part === '?') {
      for (let v = min; v <= max; v++) set.add(v)
      continue
    }
    let step = 1
    const slash = part.indexOf('/')
    if (slash !== -1) {
      step = parseInt(part.slice(slash + 1), 10)
      if (!step || step < 1) return null
      part = part.slice(0, slash)
    }
    let lo, hi
    if (part === '*') {
      lo = min
      hi = max
    } else if (part.includes('-')) {
      const [a, b] = part.split('-')
      lo = nameOrNum(a, names)
      hi = nameOrNum(b, names)
    } else {
      lo = nameOrNum(part, names)
      hi = slash !== -1 ? max : lo // "a/n" = da a fino a max con passo n
    }
    if (lo == null || hi == null || lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) set.add(v)
  }
  return set
}

// Parsa `cron(...)` → struttura di match, o null.
export function parseCron(expr) {
  const m = /^\s*cron\((.+)\)\s*$/i.exec(String(expr ?? ''))
  if (!m) return null
  const f = m[1].trim().split(/\s+/)
  if (f.length !== 6) return null
  const [minSpec, hourSpec, domSpec, monthSpec, dowSpec, yearSpec] = f
  const minute = parseField(minSpec, 0, 59)
  const hour = parseField(hourSpec, 0, 23)
  const dom = parseField(domSpec, 1, 31)
  const month = parseField(monthSpec, 1, 12, MONTHS)
  const dow = parseField(dowSpec, 1, 7, DOWS)
  const year = parseField(yearSpec, 1970, 2199)
  if (!minute || !hour || !dom || !month || !dow || !year) return null
  const isStar = (s) => s === '*' || s === '?'
  return { minute, hour, dom, month, dow, year, domRestricted: !isStar(domSpec), dowRestricted: !isStar(dowSpec) }
}

function matches(date, c) {
  if (!c.minute.has(date.getUTCMinutes())) return false
  if (!c.hour.has(date.getUTCHours())) return false
  if (!c.month.has(date.getUTCMonth() + 1)) return false
  if (!c.year.has(date.getUTCFullYear())) return false
  const domOk = c.dom.has(date.getUTCDate())
  const dowOk = c.dow.has(date.getUTCDay() + 1) // JS 0=DOM → AWS 1=DOM
  // AWS impone che uno tra dom/dow sia `?`: quello ristretto governa. Se entrambi ristretti → OR (cron std).
  if (!c.domRestricted) return dowOk
  if (!c.dowRestricted) return domOk
  return domOk || dowOk
}

// Prossimo istante di fire (ms) dopo `fromMs`, o null se non calcolabile entro ~366 giorni.
export function nextRun(expr, fromMs) {
  const c = parseCron(expr)
  if (!c) return null
  let t = Math.floor(fromMs / 60000) * 60000 + 60000 // prossimo minuto pieno
  const horizon = t + 366 * 24 * 60 * 60000
  for (; t <= horizon; t += 60000) {
    if (matches(new Date(t), c)) return t
  }
  return null
}

// Fire PRECEDENTE (ms) a `fromMs`, o null. Serve al dead man's switch: "quando avrebbe dovuto
// girare l'ultima volta?" è l'unica domanda che rende il controllo corretto per i cron che NON
// hanno cadenza costante (lun-ven, giorni del mese, mesi).
export function prevRun(expr, fromMs) {
  const c = parseCron(expr)
  if (!c) return null
  let t = Math.floor(fromMs / 60000) * 60000 // minuto pieno corrente
  const horizon = t - 366 * 24 * 60 * 60000
  for (; t >= horizon; t -= 60000) {
    if (matches(new Date(t), c)) return t
  }
  return null
}

const GRACE_MIN = 10 // pubblicazione metriche CloudWatch (~1-3 min) + durata della run

// Finestra del dead man's switch: entro quanto tempo indietro DEVE esserci una traccia di esecuzione.
//
// Prima si assumeva una cadenza costante (finestra = cadenza × 1.2) e per i cron lun-ven questo dava
// un ROSSO falso ogni fine settimana: un `cron(0 17 ? * MON-FRI *)` visto di lunedì mattina ha
// l'ultima esecuzione attesa il venerdì, 67 ore prima, ben oltre le 29h di una cadenza "giornaliera".
//
// Qui la finestra arriva dall'espressione vera: fino all'ultimo fire atteso, più una grazia. E si
// prende come riferimento l'ultimo fire più VECCHIO della grazia: subito dopo uno scatto la metrica
// non è ancora pubblicata, e misurare da lì darebbe un altro falso rosso per un paio di minuti.
// Ritorna null se l'espressione non è calcolabile (`rate(...)`, caratteri L/W/#) → il chiamante
// resta sull'euristica della cadenza.
export function missedWindow(expr, nowMs, graceMin = GRACE_MIN) {
  const graceMs = graceMin * 60000
  let ref = prevRun(expr, nowMs)
  while (ref != null && nowMs - ref < graceMs) ref = prevRun(expr, ref - 60000)
  if (ref == null) return null
  const windowMin = Math.ceil((nowMs - ref) / 60000) + graceMin
  // Tetto a 31 giorni: oltre, la finestra non è più un dead-man ma un'archeologia (e le metriche
  // CloudWatch a quella distanza sono aggregate in bucket enormi).
  return { windowMin: Math.min(windowMin, 31 * 24 * 60), expectedAt: ref }
}
