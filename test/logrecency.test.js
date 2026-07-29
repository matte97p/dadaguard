import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backwardSlices, readSlice, HEALTH_LINE } from '../server/logs.js'

// CloudWatch finto: restituisce le pagine dichiarate, una per chiamata.
const fakeCw = (...pages) => {
  let i = 0
  return {
    send: async () => {
      const events = pages[i++] ?? []
      return { events, nextToken: i < pages.length ? `t${i}` : undefined }
    },
  }
}
const ev = (ts, message) => ({ timestamp: ts, message })

// "Log recenti" deve dire le righe PIÙ RECENTI. FilterLogEvents pagina dal più vecchio, quindi
// chiedere 100 righe alla finestra intera dava le 100 più VECCHIE: su agentic-chat staging (3 nodi ALB
// che fanno health-check ogni 10s, ~1000 righe/h) il tetto si esauriva nei primi 90 secondi della
// finestra da 1h — e l'attività di adesso non compariva affatto.
// Le fette a ritroso sono il meccanismo che lo evita: qui si fissano copertura, ordine e costo.

test('le fette partono da adesso e vanno a ritroso', () => {
  const s = backwardSlices(60)
  assert.equal(s[0][0], 0) // la prima fetta tocca il presente
  for (let i = 1; i < s.length; i++) assert.equal(s[i][0], s[i - 1][1]) // contigue, senza buchi
})

test('le fette coprono tutta la finestra e non la superano', () => {
  for (const minutes of [1, 5, 60, 360, 1440, 2880]) {
    const s = backwardSlices(minutes)
    assert.equal(s[0][0], 0)
    assert.equal(s[s.length - 1][1], minutes, `finestra ${minutes} non coperta fino in fondo`)
    for (const [from, to] of s) assert.ok(to > from && to <= minutes)
  }
})

test('la prima fetta è piccola: sui servizi densi basta una chiamata per gli ultimi 100 eventi', () => {
  assert.deepEqual(backwardSlices(60)[0], [0, 1])
})

test('le fette crescono: 48h senza match si coprono in una ventina di chiamate, non in seicento', () => {
  const s = backwardSlices(2880)
  assert.ok(s.length <= 25, `48h in ${s.length} fette: troppe chiamate`)
  const naive = 2880 / 1
  assert.ok(s.length < naive / 20)
})

test('finestra di un minuto: una fetta sola', () => {
  assert.deepEqual(backwardSlices(1), [[0, 1]])
})

test('readSlice tiene le righe più recenti PER TIMESTAMP, non le ultime arrivate', () => {
  // Un servizio ECS con 3 task = 3 flussi letti in parallelo: l'ordine che CloudWatch restituisce non
  // è quello degli orologi. Chi arriva per ultimo non è chi è successo per ultimo.
  return readSlice(fakeCw([ev(300, 'terza'), ev(100, 'prima'), ev(200, 'seconda')]), {}, 2, { pages: 0 }).then((r) => {
    assert.deepEqual(
      r.events.map((e) => e.message),
      ['seconda', 'terza'],
    )
    assert.equal(r.more, true) // 'prima' è stata scartata: la risposta è troncata
  })
})

test('readSlice pagina fino in fondo alla fetta: i più recenti stanno nell ultima pagina', () => {
  return readSlice(fakeCw([ev(100, 'vecchia')], [ev(200, 'nuova')]), {}, 1, { pages: 0 }).then((r) => {
    assert.deepEqual(
      r.events.map((e) => e.message),
      ['nuova'],
    )
  })
})

test('readSlice scarta gli health check e li conta', () => {
  const page = [
    ev(100, 'INFO:     10.0.66.94:41352 - "GET /health HTTP/1.1" 200 OK'),
    ev(200, '[turn] Task done'),
    ev(300, 'INFO:     10.0.93.178:55304 - "GET /health HTTP/1.1" 200 OK'),
  ]
  return readSlice(fakeCw(page), {}, 100, { pages: 0 }).then((r) => {
    assert.deepEqual(
      r.events.map((e) => e.message),
      ['[turn] Task done'],
    )
    assert.equal(r.skipped, 2)
  })
})

test('readSlice con skipHealth disattivato restituisce tutto', () => {
  const page = [ev(100, 'INFO: - "GET /health HTTP/1.1" 200 OK'), ev(200, '[turn] Task done')]
  return readSlice(fakeCw(page), {}, 100, { pages: 0 }, { skipHealth: false }).then((r) => {
    assert.equal(r.events.length, 2)
    assert.equal(r.skipped, 0)
  })
})

// L'altra metà del problema: le righe di health-check sono ~90% del log di un servizio HTTP sano e da
// sole esaurivano il tetto. Si scartano alla fonte, quindi il pattern deve essere STRETTO: una riga
// applicativa buttata via è un'informazione perduta senza che nessuno lo sappia.
test('HEALTH_LINE riconosce gli access log di health-check (ALB → target)', () => {
  for (const line of [
    '16:13:51 INFO:     10.0.66.94:41352 - "GET /health HTTP/1.1" 200 OK',
    'INFO:     10.0.93.178:55304 - "HEAD /healthz HTTP/1.1" 200 OK',
    '10.0.105.11 - - "GET /readyz HTTP/1.1" 200 3',
  ]) {
    assert.ok(HEALTH_LINE.test(line), `non riconosciuta: ${line}`)
  }
})

test('HEALTH_LINE non tocca le righe applicative', () => {
  for (const line of [
    '15:13:26 INFO:main:[1920c5cb] [turn] ResultMessage stop_reason=end_turn num_turns=1 cost=$0.3232',
    '15:13:12 INFO:agent:[-] Session chat_c1 created (prewarm=True) for user … Active sessions: 2',
    'ERROR:main: health check failed: upstream timeout', // parla di health check, NON è un health check
    'INFO:     10.0.66.94 - "GET /healthy-tenders HTTP/1.1" 200 OK', // rotta applicativa che inizia per health
    'INFO:     10.0.66.94 - "POST /health HTTP/1.1" 200 OK', // non è una sonda: una POST lì è roba da guardare
  ]) {
    assert.ok(!HEALTH_LINE.test(line), `scartata per errore: ${line}`)
  }
})
