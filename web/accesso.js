// La strada verso AWS di ogni account (Teleport o SSO), come la manda il server in `accounts[].accesso`
// di /api/status: i comandi e i link che la pagina compone da sola (sprechi, quote, budget, cron) la
// seguono come quelli che arrivano gia' fatti dal server. Vedi shared/accessoAws.js.
//
// Un registro di modulo e non un context: la risposta di stato arriva una volta, la usano pannelli a
// cinque livelli di profondita', e prima che arrivi vale la strada di sempre (comando e link nudi).
// Le pagine conoscono l'account per chiave o per etichetta, quindi si cerca per tutte e due.
import { comandoAws, linkAws } from '../shared/accessoAws.js'

let perConto = new Map()

export function impostaAccessi(accounts = []) {
  const m = new Map()
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (!a?.accesso) continue
    m.set(a.key, a.accesso)
    if (a.label) m.set(a.label, a.accesso)
  }
  perConto = m
}

// Un conto sconosciuto (o nessuno) non ha strada: il comando e il link restano quelli nudi.
// Piu' nomi dello stesso conto (la chiave, poi l'etichetta): vale il primo che il registro conosce.
export function accessoPer(...conti) {
  for (const c of conti) if (c != null && perConto.has(c)) return perConto.get(c)
  return null
}

export const comandoPer = (cmd, conto, opts) => comandoAws(cmd, accessoPer(conto), opts)
export const linkPer = (url, conto) => linkAws(url, accessoPer(conto))
