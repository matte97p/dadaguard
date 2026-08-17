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

// Dietro questa riga c'è una PERSONA? Il server lo dice con `actorKind` (vedi server/util/principal.js:
// la sessione dell'ARN distingue una persona da CodeBuild, da GitHub Actions, da una lambda).
// `unknown` non conta come persona: attribuire a un umano un'azione di cui non sappiamo l'autore è il
// modo più rapido di far accusare qualcuno a torto. Righe vecchie senza il campo → si assume persona,
// perché prima era l'unico caso previsto e togliere righe è peggio che tenerne una imprecisa.
export const humanActor = (b) => b?.actorKind == null || b.actorKind === 'human'

// Azione fatta A MANO = una di quelle sopra FATTA DA UNA PERSONA, o una build lanciata fuori dalla CI.
// Senza il filtro sull'attore il contatore diceva «12 azioni a mano» dove undici erano `update-service`
// del deploy: il numero esiste per far notare le poche volte in cui qualcuno tocca la produzione, e
// gonfiarlo con l'automazione lo rende inutile.
export const isByHand = (b) => (isManualRestart(b) && humanActor(b)) || b?.trigger === 'hotfix' || b?.trigger === 'manuale'
export const FAILED_STATUSES = ['FAILED', 'FAULT', 'TIMED_OUT']
