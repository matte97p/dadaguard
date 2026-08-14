// Le AZIONI A MANO e gli stati di fallimento: due tabelle che pagina e raggruppamento devono leggere
// allo stesso modo. Stavano nel .jsx, quindi il modulo testabile non poteva importarle senza tirarsi
// dietro JSX (e antd, e React) dentro `node --test`.
//
// Le azioni che NON sono build: un riavvio forzato, l'apertura o la chiusura a mano di una porta su un
// security group (break-glass), una shell aperta dentro a un container. Nessuna ha fasi, durata, log né
// tasso di successo da calcolare, e ognuna ha una frase sua: senza, cadevano tutte nel ramo del riavvio
// e la pagina diceva «stessa immagine, nessuna build» sopra un break-glass.
export const AZIONI_A_MANO = {
  restart: { tag: 'blue', frase: 'deploys.sameImage' },
  'sg-open': { tag: 'error', frase: 'deploys.sgOpen' },
  'sg-close': { tag: 'success', frase: 'deploys.sgClose' },
  exec: { tag: 'warning', frase: 'deploys.exec' },
}
export const isManualRestart = (b) => Boolean(AZIONI_A_MANO[b?.kind])
// Azione fatta a mano = una di quelle sopra, o una build lanciata fuori dalla CI.
export const isByHand = (b) => isManualRestart(b) || b?.trigger === 'hotfix' || b?.trigger === 'manuale'
export const FAILED_STATUSES = ['FAILED', 'FAULT', 'TIMED_OUT']
