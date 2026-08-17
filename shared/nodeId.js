// La CHIAVE di un nodo del grafo di topologia. Vive in un modulo suo, senza nessun import, perché la
// usano tutte e due le parti: il server che costruisce il grafo e il web che lo disegna.
//
// Perché non basta esportarla da server/topology/deduce.js, che è dove stava: quel file importa mezzo
// SDK di AWS, e importarlo dal web lo trascina nel bundle del browser — il build si è rotto proprio
// così. E perché non due copie: erano già due funzioni omonime con firme diverse (una prendeva
// `(name, account)`, l'altra l'oggetto servizio), e due chiavi che divergono fondono o sdoppiano i nodi
// in silenzio, che è il modo peggiore di sbagliare.
//
// NON è il nome: lo stesso nome esiste in più account (`backend` sta in staging e in produzione, gli
// stessi modelli Bedrock stanno in ogni account). Usare il nome fondeva due servizi in un nodo solo,
// con lo stato di quello letto per ultimo.
//
// `account` arriva come stringa dal risolutore dei servizi e come oggetto `{key,label,color}` nel
// payload della UI: si normalizza qui, perché una chiave costruita su un oggetto diventa
// "[object Object]" per tutti gli account e le collisioni tornano tutte insieme.
export function topologyNodeId(name, account) {
  const acct = (typeof account === 'string' ? account : account?.key) ?? '__none__'
  return `${acct}::${name}`
}

// Comodità per il web, che ha in mano l'oggetto servizio (o già una chiave).
export function nodeIdOf(s) {
  if (typeof s === 'string') return s
  return topologyNodeId(s?.name, s?.account)
}
