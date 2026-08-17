import { test } from 'node:test'
import assert from 'node:assert/strict'
import { livelli, colonne, altezzaBox, altezzaCard } from '../web/topoLayout.js'

// DOVE VA OGNI RIQUADRO. Prima le colonne erano un elenco scritto nel codice: una convenzione, non una
// lettura dei dati. Qui si prova che il disegno viene dagli archi, e che regge i casi veri (cicli,
// chiamate reciproche, nodi isolati) senza raccontare un flusso che non c'è.

const arco = (a, b, n) => ({ source: a, target: b, ...(n ? { n } : {}) })

test('la colonna è la distanza dal perimetro, e la decide il grafo', () => {
  const liv = livelli(['alb', 'frontend', 'backend', 'cache'], [arco('alb', 'frontend'), arco('frontend', 'backend'), arco('backend', 'cache')])
  assert.deepEqual([liv.get('alb'), liv.get('frontend'), liv.get('backend'), liv.get('cache')], [0, 1, 2, 3])
})

test('due che si chiamano A VICENDA sono pari, non in fila', () => {
  // Il Backend chiama la chat e la chat chiama il Backend, ognuno per l'indirizzo del load balancer
  // interno: due archi veri. Metterli in fila sceglierebbe un verso a caso e lo racconterebbe come il
  // flusso, che è il difetto peggiore di un disegno di architettura.
  const liv = livelli(['backend', 'chat'], [arco('backend', 'chat'), arco('chat', 'backend')])
  assert.equal(liv.get('backend'), liv.get('chat'))
})

test('a maggioranza netta il verso c’è: sette frecce contro una non sono un pareggio', () => {
  // Il load balancer instrada verso sette servizi e uno di loro cita il suo indirizzo: la direzione è
  // quella del load balancer, e senza questa regola un solo arco di ritorno lo spediva in terza colonna.
  const liv = livelli(['ingress', 'app'], [arco('ingress', 'app', 7), arco('app', 'ingress', 1)])
  assert.ok(liv.get('ingress') < liv.get('app'))
})

test('un ciclo non manda la disposizione in tondo per sempre', () => {
  const liv = livelli(['a', 'b', 'c'], [arco('a', 'b'), arco('b', 'c'), arco('c', 'a')])
  for (const k of ['a', 'b', 'c']) assert.ok(Number.isFinite(liv.get(k)) && liv.get(k) <= 12)
})

test('chi non parla con nessuno va in FONDO, non in testa', () => {
  // La prima colonna vuol dire «da qui entra il lavoro». Un certificato o un bucket che nessuno cita non
  // è una porta d'ingresso, e metterlo lì direbbe il contrario di quello che si sa.
  const liv = livelli(['alb', 'app', 'orfano'], [arco('alb', 'app')])
  assert.equal(liv.get('orfano'), 2)
})

test('le colonne impilano con l’ALTEZZA VERA di ogni riquadro', () => {
  // L'altezza fissa era il difetto che si vedeva a occhio: un gruppo con quattro nomi e due righe di
  // riassunto scriveva le ultime righe fuori dal bordo.
  const pos = colonne(
    [
      { id: 'a', livello: 0, w: 224, h: 180 },
      { id: 'b', livello: 0, w: 224, h: 90 },
      { id: 'c', livello: 1, w: 224, h: 120 },
    ],
    { gapX: 44, gapY: 28 },
  )
  assert.deepEqual(pos.get('a'), { x: 0, y: 0 })
  assert.deepEqual(pos.get('b'), { x: 0, y: 208 }, 'il secondo parte SOTTO il primo, alto quanto è')
  assert.deepEqual(pos.get('c'), { x: 268, y: 0 })
})

test('l’altezza segue il contenuto nei due versi', () => {
  const pieno = altezzaBox({ nomi: 4, testa: true, altri: 9, righeBody: 2 })
  const vuoto = altezzaBox({ nomi: 0, righeBody: 1 })
  assert.ok(pieno >= 170, `quattro nomi, testa, «+9» e due righe non stanno in ${pieno}px`)
  assert.ok(vuoto < 110, 'un gruppo con una riga sola resta compatto, sennò la mappa è una fila di vuoti')
  // Un nome che va a capo alza la card: sennò la seconda riga finisce fuori dal bordo.
  assert.ok(altezzaCard('teleport-app-internal-staging') > altezzaCard('backend'))
})
