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
// ⚠️ I nomi veri NON stanno in chiaro qui dentro (15/09/2026). Questo file e' l'unico posto del repo
// che deve nominarli per poterli vietare, e finche' erano scritti in chiaro bastava una ricerca su
// GitHub per ottenere, da un file solo, l'organizzazione, il dominio, il prodotto, gli id account e
// i nomi del team: esattamente l'elenco che il file esiste per proteggere. Ora sono in base64.
// Non e' cifratura e non vuole esserlo: chiunque li decodifica in un secondo. Toglie la ricerca per
// parola, che e' il modo in cui quei nomi venivano trovati davvero.
// Per aggiungerne uno: `node -e "console.log(Buffer.from('parola').toString('base64'))"`.
const d = (b64) => Buffer.from(b64, 'base64').toString('utf8')

export const ORGANIZZAZIONE = d('Y2F0bw==')
export const DOMINIO_INTERNO = d('Z2V0LWNhdG8uY29t')
const ORGANIZZAZIONE_VECCHIA = d('YXBwYWx0aWdwdA==')
const PRODOTTO_INTERNO = d('YXZ2aXN0YQ==')
const PERSONE_DEL_TEAM = d(
  'Z2lvdmFubml8Z2lhY29tZXR0aXxnZ2lhY29tZXR0aXxib3Nzb2xpbml8bWlkZW5hfG1tYXR0ZW8yM3xtYXR0ZW9taWRlbmF8c2FiYXR0aXxib25mYW50aXx6b25jYWRh',
)
const AUTORE = d('bWF0dGVv')

export const VIETATI = [
  { re: new RegExp(`\\b${ORGANIZZAZIONE}\\b|${ORGANIZZAZIONE}-|/${ORGANIZZAZIONE}/`, 'i'), cosa: 'nome interno dell’organizzazione' },
  { re: new RegExp(`${DOMINIO_INTERNO.replace('.', '\\.')}|${ORGANIZZAZIONE_VECCHIA}`, 'i'), cosa: 'dominio interno' },
  { re: new RegExp(PRODOTTO_INTERNO, 'i'), cosa: 'nome di prodotto interno' },
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
  // I NOMI delle persone quando compaiono NUDI: il pattern sull'email non li vede in
  // `members: ['matteo', 'giovanni']`, ed e' esattamente la forma in cui erano finiti nella demo.
  // Un handle di un collega dice chi lavora su quello stack quanto la sua email.
  // ⚠️ Niente `\b` in CODA: il 31/08/2026 un nome del team attaccato a un cognome e' passato davanti
  // a questa riga ed e' finito nel CHANGELOG di un repo pubblico, perche' il confine di parola non
  // combacia fra una minuscola e la maiuscola che segue. Un nome attaccato a un altro pezzo
  // e' lo stesso nome, quindi si vieta il PREFISSO.
  { re: new RegExp(`\\b(${PERSONE_DEL_TEAM})`, 'i'), cosa: 'nome di una persona del team' },
  // `matteo` e' anche il nome dell'AUTORE, che nella licenza e nel README ci deve stare: si vieta il
  // nome nudo e la forma puntata (`matteo.perino`), non l'attribuzione «Matteo Perino» ne' il dominio
  // `matteoperino.dev`.
  { re: new RegExp(`\\b${AUTORE}(?!\\s+perino\\b)(?!perino)`, 'i'), cosa: 'nome di una persona nei dati' },
]

// Gli id account veri: se compaiono, la sostituzione non ha funzionato.
export const ACCOUNT_VIETATI = ['MDUxOTg2NjEyNjMx', 'NTIxNTk1MzAzMjE4', 'NzA4ODk1MDY5ODY0', 'OTczNTg0NzI2MDE0'].map(d)

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
