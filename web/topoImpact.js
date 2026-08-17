import { chiaveDi } from './topoGraph.js'

// A COSA SERVE LA PAGINA TOPOLOGIA. Un disegno dell'architettura è carino e non serve a niente se
// risponde solo a «com'è fatto»: quello lo dice meglio un documento, che non va tenuto in sincrono con
// AWS. Questa mappa esiste per due domande che nessun'altra pagina di dadaguard sa rispondere, e sono
// entrambe domande che si fanno mentre qualcosa è rotto:
//
//   1. SE QUESTO SI FERMA, CHI NE SOFFRE?  (raggio d'impatto: chi dipende da lui, anche di rimbalzo)
//   2. QUESTO È ROTTO, DA COSA DIPENDE?    (la causa sta quasi sempre un passo più a valle)
//
// La home dice CHE COSA è rotto. La topologia dice CHI ALTRO ne sta soffrendo e DOVE guardare: è
// l'unica delle due cose che si legge da un grafo e non da un elenco.
//
// VERSO DEGLI ARCHI. In tutte le passate di deduzione l'arco va da chi USA a ciò che è USATO: il
// servizio cita il Redis nella sua configurazione, la state machine invoca il task, il load balancer ha
// bisogno che dietro qualcuno risponda. Quindi: seguire gli archi in avanti dà LE DIPENDENZE di un
// nodo, seguirli all'indietro dà CHI DIPENDE da lui.
//
// I permessi IAM NON propagano. «Questo ruolo potrebbe scrivere su quel bucket» non è un uso: se lo si
// contasse, qualunque servizio con una policy larga risulterebbe a rischio per qualcosa che non tocca
// mai, e la riga «a rischio» diventerebbe rumore da ignorare, che è il modo in cui muoiono gli
// indicatori.
export const VIE_CHE_NON_PROPAGANO = new Set(['iam'])

const usabile = (e) => (e.vias ?? []).some((v) => !VIE_CHE_NON_PROPAGANO.has(v)) || (e.vias ?? []).length === 0

// Liste di adiacenza nei due versi. Pura.
export function adiacenze(edges = []) {
  const avanti = new Map()
  const indietro = new Map()
  for (const e of edges) {
    if (!usabile(e)) continue
    if (!avanti.has(e.source)) avanti.set(e.source, [])
    if (!indietro.has(e.target)) indietro.set(e.target, [])
    avanti.get(e.source).push(e.target)
    indietro.get(e.target).push(e.source)
  }
  return { avanti, indietro }
}

// Chiusura transitiva da un nodo, con guardia sui cicli: due servizi che si citano a vicenda esistono
// (il Backend e la chat lo fanno), e una visita ingenua ci girerebbe dentro per sempre. Pura.
export function raggiungibili(chiave, mappa) {
  const visti = new Set()
  const coda = [chiave]
  while (coda.length) {
    for (const prossimo of mappa.get(coda.shift()) ?? []) {
      if (prossimo === chiave || visti.has(prossimo)) continue
      visti.add(prossimo)
      coda.push(prossimo)
    }
  }
  return visti
}

// Nome leggibile di un nodo, servizi e sistemi fuori da AWS insieme. Pura.
export const nomeNodo = (s) => s?.esterno?.label ?? s?.name ?? ''

// I nodi in difficoltà, per chiave. `unknown` NON è un guasto: sui nodi che arrivano dal grafo prima
// dello stato vale «non l'ho ancora guardato», e propagare quello colorerebbe di allarme mezza mappa
// ogni volta che la pagina si apre. Pura.
export function inDifficolta(servizi = []) {
  const m = new Map()
  for (const s of servizi) if (s.overall === 'down' || s.overall === 'degraded') m.set(chiaveDi(s), nomeNodo(s))
  return m
}

// A RISCHIO: chiave → nomi delle sue dipendenze in difficoltà, anche indirette. Si calcola sulla flotta
// INTERA e non su un ambiente, perché le dipendenze cross-account esistono davvero (una lambda di
// staging che legge il database di produzione) e tagliarle fuori nasconderebbe proprio i casi che
// interessano. Pura.
export function rischi(servizi = [], edges = []) {
  const rotti = inDifficolta(servizi)
  if (rotti.size === 0) return new Map()
  const { avanti } = adiacenze(edges)
  const out = new Map()
  for (const s of servizi) {
    const k = chiaveDi(s)
    if (rotti.has(k)) continue // è lui il problema, non una vittima: sarebbe una riga in doppio
    const colpevoli = [...raggiungibili(k, avanti)].filter((x) => rotti.has(x)).map((x) => rotti.get(x))
    if (colpevoli.length) out.set(k, colpevoli.sort())
  }
  return out
}

// Quanti lo usano DIRETTAMENTE, per chiave. Sulle risorse dove i guasti sono rari (un Redis, un
// database, un sistema di terzi) è l'informazione che ordina: «chi ne dipende» è il motivo per cui quel
// nodo conta, e senza il numero il disegno li mette in fila alfabetica come se fossero equivalenti.
// Diretti e non transitivi: qui si risponde «chi lo usa», e contare i rimbalzi gonfierebbe il numero.
export function usiDiretti(edges = []) {
  const m = new Map()
  for (const e of edges) if (usabile(e)) m.set(e.target, (m.get(e.target) ?? 0) + 1)
  return m
}

// Le due risposte per UN nodo: chi ne soffre se si ferma, e da cosa dipende. Nomi, non chiavi: il
// pannello li mostra e nessuno legge `prod::nome`. Pura.
export function impatto(chiave, servizi = [], edges = []) {
  const { avanti, indietro } = adiacenze(edges)
  const nomi = new Map(servizi.map((s) => [chiaveDi(s), nomeNodo(s)]))
  const nome = (k) => nomi.get(k) ?? String(k).split('::').pop()
  const ordina = (set) => [...set].map(nome).sort()
  return {
    // «A valle» nel senso del danno: se questo si ferma, sono loro a non funzionare più.
    aValle: ordina(raggiungibili(chiave, indietro)),
    dipendenze: ordina(raggiungibili(chiave, avanti)),
  }
}
