// SELEZIONE MULTIPLA per i filtri. Tre righe di logica, ma decidono il comportamento di ogni filtro
// dell'app, e prima erano scritte in due modi diversi nello stesso file.
//
// Il modello è: **elenco vuoto = tutti**. Non esiste un valore sentinella `'all'` da confrontare in
// venti punti — che era il difetto: `accountFilter === 'all' || x === accountFilter` compariva in sei
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
