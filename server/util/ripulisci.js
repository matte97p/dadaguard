// Una riga di log prima che finisca in chat (il thread di un allarme, il motivo di una CI rossa).
// Condivisa da server/notify/allarmi.js e server/notify/github.js, che pescano righe da log diversi
// con lo stesso rischio: dentro ci possono essere dati e segreti.

const MAX_RIGA = 220
// Un messaggio di eccezione può portarsi dietro la query, i suoi parametri o una stringa di
// connessione: nel canale va la causa, non i dati (la stessa pulizia del notificatore degli allarmi ALB
// che queste righe sostituiscono). Si TAGLIA tutto da `[SQL:`, `[parameters:` e dal rimando di
// SQLAlchemy in poi, e le stringhe lunghe fra apici diventano `'…'`: dentro ci sono i valori (un nome,
// il testo di un documento), non il tipo di errore.
const DA_TAGLIARE = [/\s*\[SQL:.*$/s, /\s*\[parameters:.*$/s, /\s*\(Background on this error at:.*$/s]
// Prima di finire in chat una riga perde quello che non serve a capire e potrebbe non dover uscire:
// dati di query, credenziali, query string, indirizzi email, token. `<`, `>` e `&` sono il markup di
// Slack: i segnaposto sono fra quadre, e il resto si scappa. Pura/testabile.
export function ripulisci(riga = '') {
  let s = String(riga)
  for (const re of DA_TAGLIARE) s = s.replace(re, '')
  return s
    .replace(/\s+/g, ' ')
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://***@')
    .replace(/\b(password|passwd|pwd|token|secret|api_?key|authorization)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s)\]},;]+)/gi, '$1$2***')
    .replace(/\?[^\s"']+/g, '?…')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')
    // Senza il trattino nella classe: un UUID non è un segreto, e resta leggibile (`forma` lo rende `[id]`).
    .replace(/\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/g, '[token]')
    .replace(/'[^']{25,}'/g, "'…'")
    .replace(/"[^"]{25,}"/g, '"…"')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim()
    .slice(0, MAX_RIGA)
}
