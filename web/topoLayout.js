// DOVE VA OGNI RIQUADRO, dedotto dagli archi e non deciso a mano.
//
// Prima le colonne erano un elenco scritto qui dentro (ingresso a sinistra, applicazioni al centro,
// dati a destra): una convenzione, non una lettura dei dati. Si vedeva: dentro un gruppo le risorse
// finivano in una griglia da quattro per riga in ordine alfabetico, e le frecce verso i vicini
// passavano IN MEZZO alle card, dando l'impressione di una catena fra servizi che non esiste.
//
// Ora la colonna è la DISTANZA DAL PERIMETRO calcolata sul grafo: chi non ha niente che lo chiami sta
// a sinistra (un load balancer esposto, un cron, un evento), chi risponde a lui viene dopo, e così via.
// Il livello si calcola con una relaxation ripetuta invece che con un ordinamento topologico perché il
// grafo vero HA dei cicli (il Backend chiama la chat e la chat chiama il Backend, via load balancer
// interno: sono due archi veri, non un errore) e un ordinamento topologico su un ciclo non esiste. Il
// tetto di iterazioni è quello che rende la cosa finita: dentro un ciclo i livelli si stabilizzano al
// massimo raggiunto, e chi lo guarda vede due nodi affiancati invece di una catena infinita.
const TETTO = 12

// Livello di ogni nodo. `orfani` (nessun arco) vanno in fondo e non in testa: un nodo che non parla con
// nessuno non è una porta d'ingresso, è una cosa a parte, e in prima colonna direbbe il contrario. Pura.
export function livelli(chiavi = [], edges = []) {
  const liv = new Map(chiavi.map((k) => [k, 0]))
  const collegati = new Set()
  const validi = edges.filter((e) => liv.has(e.source) && liv.has(e.target) && e.source !== e.target)
  // Le chiamate RECIPROCHE non fanno colonna. Il Backend chiama la chat e la chat chiama il Backend: sono
  // due archi veri, e metterli in fila racconterebbe un verso che non c'è, scegliendone uno a caso. Due
  // che si chiamano a vicenda sono PARI, quindi vanno nella stessa colonna con le due frecce fra loro,
  // che è esattamente l'informazione da leggere.
  // Fra due nodi si tiene la direzione PREVALENTE: sette frecce da una parte e una dall'altra sono un
  // verso, non un pareggio (il load balancer instrada verso sette servizi, e uno di loro cita il suo
  // indirizzo). A parità, nessuna delle due vince e i due restano pari.
  const conta = new Map()
  for (const e of validi) conta.set(`${e.source}>${e.target}`, (conta.get(`${e.source}>${e.target}`) ?? 0) + (e.n ?? 1))
  const archi = validi.filter((e) => {
    const avanti = conta.get(`${e.source}>${e.target}`) ?? 0
    const indietro = conta.get(`${e.target}>${e.source}`) ?? 0
    return avanti > indietro
  })
  for (const e of validi) {
    collegati.add(e.source)
    collegati.add(e.target)
  }
  for (let giro = 0; giro < TETTO; giro++) {
    let cambiato = false
    for (const e of archi) {
      const nuovo = liv.get(e.source) + 1
      if (nuovo > liv.get(e.target) && nuovo <= TETTO) {
        liv.set(e.target, nuovo)
        cambiato = true
      }
    }
    if (!cambiato) break
  }
  const massimo = Math.max(0, ...[...liv.entries()].filter(([k]) => collegati.has(k)).map(([, v]) => v))
  for (const k of chiavi) if (!collegati.has(k)) liv.set(k, massimo + 1)
  return liv
}

// Posizioni a colonne: una colonna per livello, i riquadri impilati con la loro ALTEZZA VERA. L'altezza
// fissa era il difetto visibile a occhio: un gruppo con quattro nomi e due righe di riassunto sfondava il
// riquadro, e il testo finiva scritto fuori dal bordo. Pura/testabile.
export function colonne(elementi = [], { gapX = 44, gapY = 28 } = {}) {
  const perLivello = new Map()
  for (const el of elementi) {
    if (!perLivello.has(el.livello)) perLivello.set(el.livello, [])
    perLivello.get(el.livello).push(el)
  }
  const livelliOrdinati = [...perLivello.keys()].sort((a, b) => a - b)
  const out = new Map()
  let x = 0
  for (const lv of livelliOrdinati) {
    const lista = perLivello.get(lv)
    let y = 0
    for (const el of lista) {
      out.set(el.id, { x, y })
      y += el.h + gapY
    }
    x += Math.max(...lista.map((el) => el.w)) + gapX
  }
  return out
}

// ALTEZZA di un riquadro di gruppo, dal suo contenuto. I numeri seguono il CSS (`.dg-topo-box`): 12+12 di
// padding, la riga del titolo, il blocco dei nomi a 14px di passo, le righe di riassunto a 17. Se questi
// due si scollano, il riquadro torna a essere più piccolo di quello che ci scrivi dentro. Pura.
export function altezzaBox({ nomi = 0, testa = false, altri = 0, righeBody = 1 } = {}) {
  const blocco = nomi > 0 ? (testa ? 14 : 0) + nomi * 14 + (altri > 0 ? 13 : 0) : 0
  return 24 + 20 + (blocco ? 6 + blocco : 0) + 6 + Math.max(1, righeBody) * 17
}

// ALTEZZA di una card di risorsa: due righe di testo, e il nome può andare a capo. Pura.
export function altezzaCard(nome = '', larghezza = 208) {
  const perRiga = Math.floor((larghezza - 62) / 6.4) // 6.4px per carattere in monospazio a 11px
  const righe = Math.max(1, Math.ceil(String(nome).length / Math.max(8, perRiga)))
  return 20 + righe * 15 + 14
}
