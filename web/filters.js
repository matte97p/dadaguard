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
