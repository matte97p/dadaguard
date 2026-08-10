// Cose che non devono comparire in NIENTE di pubblicato da questo repo, che è pubblico.
//
// Non è un elenco di segreti — quelli non passano da qui. È l'elenco di ciò che RICONDUCE a
// un'infrastruttura o a una persona: il nome dell'organizzazione, un prodotto interno, l'email di un
// collega, l'id di un account. Da soli sembrano dettagli innocui; insieme disegnano lo stack di
// qualcuno e chi ci lavora.
//
// Stava dentro il test delle fixture e guardava solo quelle. Ma la superficie più esposta è la
// MODALITÀ DEMO — l'immagine pubblica che chiunque lancia con `docker run` — e lì non guardava
// nessuno: i dati finti erano cresciuti con nomi di servizi veri, budget veri e handle di persone
// vere. Ora la lista è una, e la usano entrambi i guardiani.
export const VIETATI = [
  { re: /\bcato\b|cato-|\/cato\//i, cosa: 'nome interno dell’organizzazione' },
  { re: /get-cato\.com|appaltigpt/i, cosa: 'dominio interno' },
  { re: /avvista/i, cosa: 'nome di prodotto interno' },
  { re: /AWSReservedSSO_(?!Ruolo_0000)/, cosa: 'permission set SSO reale' },
  { re: /assumed-role\/[^/"]*\/(?!persona)[A-Z][a-zA-Z]+(?=["/])/, cosa: 'nome di una persona in una sessione' },
  { re: /@(?!example\.com)[a-z0-9.-]+\.(com|it|dev|net|org)/i, cosa: 'email reale' },
  { re: /hooks\.slack\.com/i, cosa: 'webhook Slack' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, cosa: 'access key' },
]

// Gli id account veri: se compaiono, la sostituzione non ha funzionato.
export const ACCOUNT_VIETATI = ['051986612631', '521595303218', '708895069864', '973584726014']

// Applica le regole a un testo. Ritorna la prima violazione trovata, o null. Pura/testabile.
export function violazione(testo) {
  for (const { re, cosa } of VIETATI) {
    const m = String(testo).match(re)
    if (m) return { cosa, trovato: m[0] }
  }
  for (const id of ACCOUNT_VIETATI) {
    if (String(testo).includes(id)) return { cosa: 'id account reale', trovato: id }
  }
  return null
}
