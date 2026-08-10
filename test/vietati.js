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
  // Il PREFISSO `AWSReservedSSO_` è di AWS e il codice deve poterlo cercare: si vieta il NOME di un
  // permission set vero, cioè prefisso + nome + suffisso esadecimale dell'istanza.
  { re: /AWSReservedSSO_(?!Ruolo_0000)[A-Za-z]+_[0-9a-f]{6,}/, cosa: 'permission set SSO reale' },
  { re: /assumed-role\/[^/"]*\/(?!persona)[A-Z][a-zA-Z]+(?=["/])/, cosa: 'nome di una persona in una sessione' },
  // `users.noreply.github.com` e `mail.example.org` sono ammessi: il primo è il dominio pubblico di
  // GitHub (i test provano come si accorciano quelle email), il secondo è un dominio d'esempio.
  // Local part di almeno 3 caratteri: senza, `postgres://u:p@host` passava per un'email (la `p` era
  // il destinatario) e ogni stringa di connessione risultava una violazione.
  { re: /[a-z0-9._%+-]{3,}@(?!example\.com|users\.noreply\.github\.com|mail\.example\.org)[a-z0-9.-]+\.(com|it|dev|net|org)/i, cosa: 'email reale' },
  // Il dominio da solo compare nella documentazione (`https://hooks.slack.com/services/...`): si
  // vieta un webhook VERO, cioè quello che ha un token dietro.
  { re: /hooks\.slack\.com\/services\/[A-Z0-9]{6,}/i, cosa: 'webhook Slack' },
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
