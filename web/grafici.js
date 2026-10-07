// I CONTI dei grafici del cruscotto (Flotta e Accessi), fuori dai componenti: le tacche dell'asse del
// tempo, il percorso di una linea con i buchi, le colonne impilate, la riduzione di una serie oraria a
// una tessera. Puri, per poterli provare (`test/grafici.test.js`): un'etichetta sbagliata sull'asse
// sposta un guasto di un giorno, e una linea che unisce due punti attraverso un buco disegna un dato
// che non c'e'.
//
// Le regole di forma vengono dalla guida dataviz del progetto: linee da 2px, una sola scala per
// grafico, i buchi restano buchi, l'asse e la griglia sono sottili e grigi, le etichette dirette sono
// poche e scelte.

const MIN = 60_000
const ORA = 60 * MIN
const GIORNO = 24 * ORA

const locale = (lang) => (lang === 'it' ? 'it-IT' : 'en-GB')

// Le tacche dell'asse del tempo per una serie `{ inizio, passoMs, punti }`: dove stanno (in indice di
// punto, anche frazionario, cosi' una tacca a mezzanotte cade nel posto giusto anche fra due fasce) e
// cosa dicono. Il passo delle tacche si sceglie dalla durata: ogni quarto d'ora su un'ora, ogni ora o
// due su sei ore, ogni sei ore su un giorno, ogni giorno su una settimana. Tacche su istanti tondi
// dell'ora LOCALE, perche' chi legge pensa «a mezzanotte», non «a 22:00 UTC».
export function tacche({ inizio, passoMs, punti } = {}, lang = 'it', { max = 8 } = {}) {
  if (!Number.isFinite(inizio) || !passoMs || !punti) return []
  const fine = inizio + punti * passoMs
  const durata = fine - inizio
  const passi = [15 * MIN, 30 * MIN, ORA, 2 * ORA, 3 * ORA, 6 * ORA, 12 * ORA, GIORNO, 2 * GIORNO]
  const passo = passi.find((p) => durata / p <= max) ?? passi.at(-1)
  const giornaliero = passo >= GIORNO
  // Il primo istante tondo dopo l'inizio, nell'ora locale.
  const d = new Date(inizio)
  if (giornaliero) d.setHours(0, 0, 0, 0)
  else {
    const minuti = passo / MIN
    const tot = d.getHours() * 60 + d.getMinutes()
    const giu = Math.floor(tot / minuti) * minuti
    d.setHours(Math.floor(giu / 60), giu % 60, 0, 0)
  }
  const fuori = []
  for (let t = d.getTime(); t <= fine; ) {
    if (t >= inizio) {
      const x = new Date(t)
      const label = giornaliero
        ? x.toLocaleDateString(locale(lang), { weekday: 'short', day: 'numeric' })
        : x.toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' })
      fuori.push({ i: (t - inizio) / passoMs, t, label })
    }
    // Avanti nell'ora locale: un giorno col cambio d'ora dura 23 o 25 ore, e `+ GIORNO` scivolerebbe.
    const n = new Date(t)
    if (giornaliero) n.setDate(n.getDate() + passo / GIORNO)
    else n.setTime(t + passo)
    t = n.getTime()
  }
  return fuori
}

// L'etichetta di una fascia nel tooltip: «mar 6, 14:00» per le fasce sotto il giorno, «mar 6» per
// quelle di un giorno. Con la fine della fascia quando e' piu' lunga di un'ora («14:00 - 20:00»).
export function etichettaFascia(t, passoMs, lang = 'it') {
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const giorno = d.toLocaleDateString(locale(lang), { weekday: 'short', day: 'numeric', month: 'short' })
  if (passoMs >= GIORNO) return giorno
  const ora = (x) => new Date(x).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' })
  return passoMs > ORA ? `${giorno}, ${ora(t)} - ${ora(t + passoMs)}` : `${giorno}, ${ora(t)}`
}

// Il percorso SVG di una linea su `valori`, con un BUCO dove il valore e' `null`: un'ora senza righe
// e' un Mac spento, e unirla ai vicini direbbe una memoria che nessuno ha misurato.
export function percorso(valori = [], x, y) {
  let d = ''
  let dentro = false
  valori.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      dentro = false
      return
    }
    d += `${dentro ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    dentro = true
  })
  return d
}

// L'area fra due serie (`alto` sopra, `basso` sotto), con gli stessi buchi: un tratto per ogni corsa
// di punti in cui ci sono tutte e due.
export function percorsoBanda(alto = [], basso = [], x, y) {
  const tratti = []
  let corrente = []
  for (let i = 0; i < Math.max(alto.length, basso.length); i++) {
    const a = alto[i]
    const b = basso[i]
    if (a == null || b == null) {
      if (corrente.length) tratti.push(corrente)
      corrente = []
    } else corrente.push(i)
  }
  if (corrente.length) tratti.push(corrente)
  return tratti
    .map((idx) => {
      const su = idx.map((i) => `${x(i).toFixed(1)},${y(alto[i]).toFixed(1)}`)
      const giu = [...idx].reverse().map((i) => `${x(i).toFixed(1)},${y(basso[i]).toFixed(1)}`)
      return `M${su.join('L')}L${giu.join('L')}Z`
    })
    .join('')
}

// Una serie lunga ridotta a gruppi di `n` punti, col criterio della serie: `min` per la memoria libera
// (il caso peggiore del gruppo), `max`, `somma` per i conteggi. Un gruppo tutto `null` resta `null`.
export function riduci(valori = [], n = 1, modo = 'somma') {
  if (n <= 1) return [...valori]
  const fuori = []
  // I gruppi si contano dalla FINE: l'ultimo gruppo e' sempre intero e finisce adesso.
  const resto = valori.length % n
  for (let a = resto ? resto - n : 0; a < valori.length; a += n) {
    const pezzo = valori.slice(Math.max(0, a), a + n).filter((v) => v != null && Number.isFinite(v))
    if (!pezzo.length) fuori.push(null)
    else if (modo === 'min') fuori.push(Math.min(...pezzo))
    else if (modo === 'max') fuori.push(Math.max(...pezzo))
    else fuori.push(pezzo.reduce((s, v) => s + v, 0))
  }
  return fuori
}

// Le colonne impilate di un grafico a fasce: per ogni fascia e ogni serie, da dove parte e dove
// arriva. Una fascia `null` in tutte le serie e' «non lo so» (fuori dal campione), e resta vuota.
export function impila(serie = [], punti = 0) {
  const fuori = []
  for (let i = 0; i < punti; i++) {
    let base = 0
    let nota = false
    const pezzi = serie.map((s) => {
      const v = s.valori?.[i]
      if (v == null) return { k: s.k, da: base, a: base, v: null }
      nota = true
      const da = base
      base += v
      return { k: s.k, da, a: base, v }
    })
    fuori.push({ i, totale: nota ? base : null, pezzi })
  }
  return fuori
}

// Il massimo «tondo» per l'asse dei valori: 1, 2, 5 per potenze di dieci. Un asse che finisce a 7,3
// non si legge; uno che finisce a 10 si'.
export function tondo(max) {
  if (!Number.isFinite(max) || max <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(max))
  const m = max / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

// «12m», «3h», «2g»: quanto e' passato, in una cella stretta. `fmtAgo` dice «2h 30m fa», che in una
// colonna della matrice e' troppo.
export function agoBreve(ts, t = (k) => k, adesso = Date.now()) {
  if (!Number.isFinite(ts)) return null
  const min = Math.max(0, Math.round((adesso - ts) / MIN))
  if (min < 1) return t('ago.now')
  if (min < 60) return `${min}${t('time.unit.m')}`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}${t('time.unit.h')}`
  return `${Math.floor(h / 24)}${t('time.unit.d')}`
}

// Un numero con la virgola giusta per la lingua, a `cifre` decimali, senza zeri inutili.
export function numero(x, lang = 'it', cifre = 1) {
  if (x == null || !Number.isFinite(Number(x))) return null
  const p = 10 ** cifre
  return String(Math.round(Number(x) * p) / p).replace('.', lang === 'it' ? ',' : '.')
}
