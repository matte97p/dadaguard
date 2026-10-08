// L'utente di database di una persona, quando il login e' il suo nome. Tre prefissi, uno per
// perimetro, e sono i tre modi in cui oggi un login porta dentro il nome di chi lo usa:
// `dev_<utente github>` (scrittura), `adm_<utente github>` (amministrazione, ENG-2389) e
// `data_<utente github>` (il team data). Il confronto e' senza maiuscole perche' GitHub le tiene e
// Postgres no.
//
// Sta in un modulo suo perche' la stessa risposta serve a due domande, e le due risposte non devono
// mai poter divergere: il messaggio (`sommarioLogin` in notify/slack.js) la usa per non ridire fra
// parentesi un nome gia' detto, `segnali()` in accessi.js per decidere il COLORE della riga sui dati.
// Una scrittura fatta solo con login personali e' un fatto d'audit (ℹ️), una fatta con un login che
// non e' il nome di nessuno e' l'anomalia (🚨). Due liste di prefissi vorrebbero dire, un giorno, una
// riga ℹ️ con un login estraneo fra parentesi, o una 🚨 che non sa dire perche'.
//
// ⚠️ Un prefisso che manca qui non fa sbagliare il conto, fa RUMORE: quel login finisce fra gli
// «estranei» e la riga torna a dire fra parentesi un nome che il messaggio ha gia' detto per intero
// («da tizio … (adm_tizio su writer)»), cioe' proprio la ripetizione che `sommarioLogin` toglie. E dal
// 08/10/2026 accende anche la sirena su una scrittura normale. E' successo il 16/09/2026, il giorno in
// cui l'amministrazione e' passata al login per persona: chi aggiunge un perimetro nuovo aggiunge il
// prefisso qui.
export const PREFISSI_PERSONALI = ['dev_', 'adm_', 'data_']

export const suoLogin = (utenteDb, chi = []) => {
  const u = String(utenteDb ?? '').toLowerCase()
  return chi.some((c) => PREFISSI_PERSONALI.some((p) => `${p}${String(c).toLowerCase()}` === u))
}

// Gli `utentiDb` di una riga in una forma sola. La forma vecchia era una frase gia' scritta
// (`"tizio su writer"`): si legge ancora, perche' uno stato o un payload di ieri non deve far sparire
// la riga.
export const vociLogin = (utentiDb = []) =>
  utentiDb.map((u) => (typeof u === 'string' ? { utente: u, endpoint: null } : u)).filter((u) => u?.utente)

// Tutti i login con cui si e' scritto sono il nome di una persona che ha scritto? `false` anche
// quando i login non si conoscono (lista vuota): non sapere con che cosa si e' scritto non e' sapere
// che era un login personale, e fra i due errori il silenzioso e' quello che costa.
export const soloLoginPersonali = (utentiDb = [], chi = []) => {
  const voci = vociLogin(utentiDb)
  return voci.length > 0 && voci.every((u) => suoLogin(u.utente, chi))
}
