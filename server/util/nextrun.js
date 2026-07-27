// Prossima/precedente esecuzione di uno schedule EventBridge. Puro/testabile.
// Valutato nel FUSO dello schedule quando dichiarato (`ScheduleExpressionTimezone` di EventBridge
// Scheduler, es. Europe/Rome); senza fuso → UTC, come le EventBridge Rules classiche.
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

// Campi di calendario di un istante, nel FUSO dello schedule. EventBridge Scheduler accetta
// `ScheduleExpressionTimezone` (i cron Cato sono su Europe/Rome): valutare l'espressione in UTC
// sposta ogni calcolo di 1-2 ore — abbastanza per cercare l'esecuzione nella finestra sbagliata.
// Niente aritmetica manuale sui fusi: si chiede a Intl i campi dell'orologio locale di quell'istante,
// così l'ora legale è gestita per costruzione.
const DOW_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const fmtCache = new Map()
function zoneFields(date, tz) {
  if (!tz) {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      year: date.getUTCFullYear(),
      dow: date.getUTCDay(),
    }
  }
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    fmtCache.set(tz, f)
  }
  const p = {}
  for (const { type, value } of f.formatToParts(date)) p[type] = value
  return {
    minute: Number(p.minute),
    hour: Number(p.hour) % 24, // 'en-US' con hour12:false può dare 24 a mezzanotte
    day: Number(p.day),
    month: Number(p.month),
    year: Number(p.year),
    dow: DOW_IDX[p.weekday] ?? 0,
  }
}

// Fuso non valido (typo, zona sconosciuta) → si valuta in UTC invece di esplodere.
function safeTz(tz) {
  if (!tz) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

function matches(date, c, tz) {
  const f = zoneFields(date, tz)
  if (!c.minute.has(f.minute)) return false
  if (!c.hour.has(f.hour)) return false
  if (!c.month.has(f.month)) return false
  if (!c.year.has(f.year)) return false
  const domOk = c.dom.has(f.day)
  const dowOk = c.dow.has(f.dow + 1) // JS 0=DOM → AWS 1=DOM
  // AWS impone che uno tra dom/dow sia `?`: quello ristretto governa. Se entrambi ristretti → OR (cron std).
  if (!c.domRestricted) return dowOk
  if (!c.dowRestricted) return domOk
  return domOk || dowOk
}

// Prossimo istante di fire (ms) dopo `fromMs`, o null se non calcolabile entro ~366 giorni.
// `tz` = ScheduleExpressionTimezone dello schedule (assente → UTC, come le EventBridge Rules).
export function nextRun(expr, fromMs, tz = null) {
  const c = parseCron(expr)
  if (!c) return null
  const z = safeTz(tz)
  let t = Math.floor(fromMs / 60000) * 60000 + 60000 // prossimo minuto pieno
  const horizon = t + 366 * 24 * 60 * 60000
  for (; t <= horizon; t += 60000) {
    if (matches(new Date(t), c, z)) return t
  }
  return null
}

// Fire PRECEDENTE (ms) a `fromMs`, o null. Serve al dead man's switch: "quando avrebbe dovuto
// girare l'ultima volta?" è l'unica domanda che rende il controllo corretto per i cron che NON
// hanno cadenza costante (lun-ven, giorni del mese, mesi).
export function prevRun(expr, fromMs, tz = null) {
  const c = parseCron(expr)
  if (!c) return null
  const z = safeTz(tz)
  let t = Math.floor(fromMs / 60000) * 60000 // minuto pieno corrente
  const horizon = t - 366 * 24 * 60 * 60000
  for (; t >= horizon; t -= 60000) {
    if (matches(new Date(t), c, z)) return t
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
export function missedWindow(expr, nowMs, tz = null, graceMin = GRACE_MIN) {
  const graceMs = graceMin * 60000
  let ref = prevRun(expr, nowMs, tz)
  while (ref != null && nowMs - ref < graceMs) ref = prevRun(expr, ref - 60000, tz)
  if (ref == null) return null
  const windowMin = Math.ceil((nowMs - ref) / 60000) + graceMin
  // Tetto a 31 giorni: oltre, la finestra non è più un dead-man ma un'archeologia (e le metriche
  // CloudWatch a quella distanza sono aggregate in bucket enormi).
  return { windowMin: Math.min(windowMin, 31 * 24 * 60), expectedAt: ref }
}
