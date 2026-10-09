// SELEZIONE MULTIPLA per i filtri. Tre righe di logica, ma decidono il comportamento di ogni filtro
// dell'app, e prima erano scritte in due modi diversi nello stesso file.
//
// Il modello è: **elenco vuoto = tutti**. Non esiste un valore sentinella `'all'` da confrontare in
// venti punti: che era il difetto: `accountFilter === 'all' || x === accountFilter` compariva in sei
// file, e ognuno poteva sbagliarlo a modo suo. Con l'elenco, la domanda è sempre la stessa: «questo
// valore è fra quelli scelti?», e se nessuno ha scelto niente la risposta è sì.
//
// `asList` accetta anche le forme VECCHIE (`'all'`, una stringa singola) perché i preset dei filtri
// sono salvati nel browser di chi usa Dadaguard da prima: un preset salvato ieri non deve diventare un
// filtro impazzito oggi. Tutto puro/testabile.

// Normalizza in elenco: `'all'`, null, undefined, '' → [] (nessun filtro); 'prod' → ['prod'];
// ['prod', 'all'] → ['prod'] (il sentinella non sopravvive dentro un elenco).
export function asList(v) {
  if (v == null) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr.filter((x) => x != null && x !== '' && x !== 'all')
}

// «Questo valore è fra quelli scelti?». Elenco vuoto = nessun filtro = tutto passa.
export function matchesAny(value, list) {
  const l = asList(list)
  return l.length === 0 || l.includes(value)
}

// Un filtro è ATTIVO se qualcuno ha scelto qualcosa: serve al bottone «azzera» e all'indicatore.
export const isFiltering = (v) => asList(v).length > 0

// Filtro iniziale da un parametro dell'URL: `?account=staging`, `?service=backend,frontend`.
//
// Serve ai LINK che arrivano da fuori, come le notifiche di #aws-deploy: un link che porta alla
// pagina dei deploy senza filtri porta alla flotta intera in due account, e chi clicca deve
// ritrovare a mano il servizio di cui parlava il messaggio. La virgola separa piu' valori, che e' la
// forma naturale da quando i filtri sono multipli.
//
// Puro apposta: il parsing di un URL dentro un `useState` non lo prova nessuno, e questo sbaglia in
// un modo solo, tacendo (nessun filtro applicato), che dal messaggio non si distingue da un link
// scritto male.
export function listaDaUrl(search, chiave) {
  const grezzo = new URLSearchParams(search || '').get(chiave)
  // `trim` per ogni pezzo: `?service=backend, frontend` e' un link scritto a mano o passato per una
  // chat che ci mette lo spazio, e `matchesAny` confronta le stringhe esatte: senza, meta' filtro non
  // corrisponde a niente e nella tendina compare una voce fantasma con lo spazio davanti.
  return asList((grezzo ?? '').split(',').map((x) => x.trim()))
}

// Toglie da un filtro le scelte che non esistono fra le chiavi vere. Serve ai filtri che arrivano da
// un URL: una chiave stantia o sbagliata (`prod` per `production`, un account rinominato) non filtra
// «niente», filtra TUTTO VIA, e la pagina dice «nessun account configurato», che e' una frase falsa
// su un dato che c'e'. Meglio nessun filtro che una pagina vuota senza spiegazione.
//
// `chiaviNote` vuoto vuol dire «non lo so ancora» (i dati stanno arrivando): li' non si pota niente,
// sennò il filtro sparirebbe al primo render e il link non varrebbe mai.
export function potaSconosciuti(scelte, chiaviNote) {
  const note = asList(chiaviNote)
  if (note.length === 0) return asList(scelte)
  return asList(scelte).filter((s) => note.includes(s))
}

// Il filtro per NOME, anche con più nomi separati da virgola: vale «uno qualsiasi». È la forma dei
// link che arrivano da fuori (il quadro dei deploy in Slack apre questa pagina sulle risorse di una
// sua riga, che sono più d'una), e chi scrive a mano una parola sola non vede differenze.
// Puro apposta, come `listaDaUrl`: sbaglia in un modo solo, tacendo, cioè mostrando tutto.
export function corrispondeNome(query, ...nomi) {
  const pezzi = String(query ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  if (!pezzi.length) return true
  return nomi.some((n) => pezzi.some((p) => String(n ?? '').toLowerCase().includes(p)))
}

// I filtri della pagina Servizi nell'URL, nei due versi. Un link deve poter dire «i Bedrock di
// produzione» (`/servizi?account=production&type=bedrock`) e chi lo apre deve trovare le tendine
// gia' scelte; e chi sceglie a mano deve poter copiare l'indirizzo e mandarlo, invece di spiegare in
// chat quali tendine aprire. I nomi dei parametri sono corti e in inglese come `q` e `account`, che
// arrivano gia' cosi' dalle notifiche di Slack.
const LISTE_URL = { typeFilter: 'type', statusFilter: 'status', regionFilter: 'region' }
const SCHEDULE_URL = ['cron', 'ondemand']
const TF_URL = ['managed', 'unmanaged']

// Solo i campi che l'URL dice davvero: un campo assente resta al valore che ha gia' App, cosi' un
// link con il solo `?type=` non azzera la ricerca o l'ambiente scelti da un'altra parte. Un valore
// che non si conosce (`?tf=forse`) si ignora: meglio nessun filtro che uno che non si vede.
export function filtriDaUrl(search) {
  const p = new URLSearchParams(search || '')
  const out = {}
  for (const [campo, chiave] of Object.entries(LISTE_URL)) {
    const l = listaDaUrl(search, chiave)
    if (l.length) out[campo] = l
  }
  if (SCHEDULE_URL.includes(p.get('schedule'))) out.scheduleFilter = p.get('schedule')
  if (TF_URL.includes(p.get('tf'))) out.managedFilter = p.get('tf')
  if (p.get('problems') === '1') out.problemsOnly = true
  return out
}

// La query string con i filtri di adesso. Tiene i parametri che non sono filtri (quello che aggiunge
// un link esterno) e toglie quelli tornati al default, cosi' l'indirizzo dice solo cosa e' stato
// scelto. Le virgole restano virgole: `type=lambda,bedrock` si legge, `%2C` no.
export function filtriInUrl(search, f = {}) {
  const p = new URLSearchParams(search || '')
  const metti = (k, v) => (v ? p.set(k, v) : p.delete(k))
  metti('q', String(f.nameQuery ?? '').trim())
  metti('account', asList(f.accountFilter).join(','))
  for (const [campo, chiave] of Object.entries(LISTE_URL)) metti(chiave, asList(f[campo]).join(','))
  metti('schedule', SCHEDULE_URL.includes(f.scheduleFilter) ? f.scheduleFilter : '')
  metti('tf', TF_URL.includes(f.managedFilter) ? f.managedFilter : '')
  metti('problems', f.problemsOnly ? '1' : '')
  return p.toString().replace(/%2C/gi, ',')
}

// La ricerca della pagina dei cron, come pezzo di URL per `/api/runs`. Va al server perche' il server
// legge al massimo 40 cron per giro, e filtrare solo nel browser cercava fra quei 40: un cron vero oltre
// il tetto risultava «Nessuna esecuzione». Sotto i due caratteri non si chiede niente: «t» corrisponde a
// quasi tutto e costerebbe un giro intero per la stessa lista di prima.
export const MIN_CERCA_RUNS = 2
export function queryCerca(testo) {
  const q = String(testo ?? '').trim()
  return q.length >= MIN_CERCA_RUNS ? `&q=${encodeURIComponent(q)}` : ''
}
