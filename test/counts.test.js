// La striscia di conteggi è la prima cosa che si legge: se sbaglia l'ordine o inghiotte uno stato,
// fa concludere "tutto bene" quando non lo è. Qui si fissa l'ordine (dal peggio) e che nessuno stato
// sparisca — nemmeno uno introdotto dal server dopo questo codice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countByStatus, compactBuildReason } from '../web/format.js'

const svc = (overall) => ({ overall })

test('conta e ordina dal peggio al meglio', () => {
  const out = countByStatus([svc('up'), svc('down'), svc('up'), svc('degraded'), svc('idle')])
  assert.deepEqual(out, [
    { status: 'down', count: 1 },
    { status: 'degraded', count: 1 },
    { status: 'idle', count: 1 },
    { status: 'up', count: 2 },
  ])
})

test('gli stati assenti non compaiono: una striscia di zeri non informa', () => {
  assert.deepEqual(countByStatus([svc('up'), svc('up')]), [{ status: 'up', count: 2 }])
})

test('stato mancante = sconosciuto, non sparisce dal conto', () => {
  assert.deepEqual(countByStatus([{}, svc(undefined)]), [{ status: 'unknown', count: 2 }])
})

test('uno stato NUOVO del server finisce in coda, non nel nulla', () => {
  // Il totale della striscia deve sempre fare il totale dei servizi: se un valore ignoto venisse
  // scartato, la somma dei conteggi non tornerebbe e nessuno se ne accorgerebbe.
  const out = countByStatus([svc('up'), svc('draining'), svc('down')])
  assert.deepEqual(out, [
    { status: 'down', count: 1 },
    { status: 'up', count: 1 },
    { status: 'draining', count: 1 },
  ])
  assert.equal(
    out.reduce((n, x) => n + x.count, 0),
    3,
  )
})

test('lista vuota o assente: nessun conteggio, non un errore', () => {
  assert.deepEqual(countByStatus([]), [])
  assert.deepEqual(countByStatus(undefined), [])
})

// compactBuildReason: il muro di shell che CodeBuild restituisce come "messaggio" di una fase morta.
// Sta qui perché è un formattatore (web/format.js), e la sua unica ragione di esistere è che quel muro
// occupava mezzo schermo nella pagina «Adesso» per una riga di elenco.
test('compactBuildReason: tiene l’esito e il comando, butta lo script', () => {
  const muro =
    'COMMAND_EXECUTION_ERROR: Error while executing command: if aws ecs wait services-stable --cluster "$CLUSTER"; then COUNTS=$(aws ecs describe-services) else exit 1 fi . Reason: exit status 1'
  const out = compactBuildReason(muro)
  assert.ok(out.startsWith('exit status 1'), out) // l'esito PRIMA: è la parte che risponde
  assert.ok(!out.includes('describe-services'), out) // il resto dello script no
  assert.ok(out.length <= 90, `${out.length}: ${out}`)
})

test('compactBuildReason: un comando corto resta intero, senza puntini bugiardi', () => {
  assert.equal(compactBuildReason('Error while executing command: npm test. Reason: exit status 1'), 'exit status 1 · npm test')
})

test('compactBuildReason: un messaggio che NON è un comando passa (accorciato solo se lunghissimo)', () => {
  assert.equal(compactBuildReason('Access denied'), 'Access denied')
  assert.equal(compactBuildReason(''), '')
  assert.equal(compactBuildReason(null), '')
  assert.equal(compactBuildReason('y'.repeat(300)).length, 150)
})
