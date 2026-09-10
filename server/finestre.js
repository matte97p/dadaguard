import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Il lettore di `finestre.conf`: quanto indietro guarda una chiamata e quante righe puo' scaricare.
// Il perche' del file sta nel suo header. Qui c'e' solo la lettura, e una regola: chi chiede una
// chiave che non esiste ottiene un ERRORE e non un default silenzioso. Un endpoint dimenticato che
// prende «24 ore» per caso e' esattamente il modo in cui i sedici numeri sparsi sono nati.
const FILE = fileURLToPath(new URL('./finestre.conf', import.meta.url))

let cache = null

function leggi() {
  if (cache) return cache
  const righe = readFileSync(FILE, 'utf8').split('\n')
  const out = new Map()
  righe.forEach((riga, i) => {
    const pulita = riga.trim()
    if (!pulita || pulita.startsWith('#')) return
    const campi = pulita.split('|').map((c) => c.trim())
    if (campi.length !== 5) throw new Error(`finestre.conf riga ${i + 1}: ${campi.length} campi invece di 5`)
    const [chiave, unita, def, max, tetto] = campi
    if (unita !== 'ore' && unita !== 'giorni') throw new Error(`finestre.conf riga ${i + 1}: unita' "${unita}"`)
    const n = (v) => (v === '-' ? null : Number(v))
    if (Number(def) > Number(max)) throw new Error(`finestre.conf riga ${i + 1}: default oltre il massimo`)
    out.set(chiave, { chiave, unita, def: Number(def), max: Number(max), tetto: n(tetto) })
  })
  cache = out
  return out
}

export function finestra(chiave) {
  const f = leggi().get(chiave)
  if (!f) throw new Error(`finestre.conf: chiave "${chiave}" non dichiarata`)
  return f
}

// Il valore chiesto da chi guarda, riportato dentro i limiti dichiarati. Non e' una validazione
// difensiva: e' la garanzia che una query string non possa chiedere al server un mese di eventi su
// una pagina che ne dichiara sette giorni, che e' il modo in cui un tetto smette di essere un tetto.
export function entroLimiti(chiave, chiesto) {
  const f = finestra(chiave)
  const n = Number(chiesto)
  if (!Number.isFinite(n) || n <= 0) return f.def
  return Math.min(f.max, Math.max(1, Math.round(n)))
}

export function tetto(chiave) {
  return finestra(chiave).tetto
}

// Le finestre che la UI puo' offrire per una chiave: il default piu' i gradini standard che ci
// stanno sotto il massimo. Sta qui e non nella pagina perche' un elenco ricopiato in quattordici
// pagine e' un elenco che fra un mese ne dice quattordici versioni diverse.
const GRADINI_ORE = [1, 6, 24, 168, 720]

export function gradini(chiave) {
  const f = finestra(chiave)
  if (f.max === 0) return []
  const inOre = (v) => (f.unita === 'giorni' ? v * 24 : v)
  const scelti = GRADINI_ORE.filter((g) => g <= inOre(f.max))
  if (!scelti.includes(inOre(f.def))) scelti.push(inOre(f.def))
  return [...new Set(scelti)].sort((a, b) => a - b)
}

export function elenco() {
  return [...leggi().values()]
}
