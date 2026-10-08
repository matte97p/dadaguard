import { test } from 'node:test'
import assert from 'node:assert/strict'
import { causaDalLog, motivoDalVerdetto, pulisci } from '../server/buildCausa.js'

// Righe vere di un apply IaC fallito (08/10/2026), come le restituisce il filtro: due apply
// dello stesso commit in parallelo, il secondo morto sui lock. Il verdetto di CodeBuild diceva solo
// il comando, cioe' lo script troncato.
const E = '\x1b'
const APPLY_IN_PARALLELO = [
  'ERRORE=""\n',
  `  fail)  TEXT="🔴 apply FAILED, il log dice quali\${DETAIL_ERRORE}" ;;\n`,
  `${E}[90m12:19:44.797${E}[m ${E}[31mSTDERR${E}[m ${E}[38;5;138m[network] ${E}[m${E}[36mterraform: ${E}[m${E}[31m│${E}[0m ${E}[0m${E}[1m${E}[31mError: ${E}[0m${E}[0m${E}[1mError acquiring the state lock${E}[0m\n`,
  `${E}[90m12:20:16.335${E}[m ${E}[31mERROR ${E}[m Run failed: 19 errors occurred:\n`,
  `  ${E}[31m│${E}[0m ${E}[0m${E}[1m${E}[31mError: ${E}[0m${E}[0m${E}[1mError acquiring the state lock${E}[0m\n`,
  '[Container] 2026/10/08 12:20:17.131283 Phase context status code: COMMAND_EXECUTION_ERROR Message: Error while executing command: if [ -f /tmp/rilancio_a_vuoto ]; then\n',
]

test('causaDalLog: i lock dello state dicono quante unit e quale', () => {
  assert.equal(causaDalLog(APPLY_IN_PARALLELO), '19 errori, lock dello state occupato da un altro apply (network)')
})

test('causaDalLog: un errore terraform qualsiasi porta la sua unit', () => {
  const righe = [`${E}[90m10:00:00.000${E}[m ${E}[31mSTDERR${E}[m [services/backend] terraform: │ Error: creating ECS Service: InvalidParameterException`]
  assert.equal(causaDalLog(righe), 'services/backend: creating ECS Service: InvalidParameterException')
})

test('causaDalLog: le righe di script che contengono la parola non sono errori', () => {
  assert.equal(causaDalLog(['ERRORE=""', '  echo "Error: manca il file" && exit 1']), '')
})

test('causaDalLog: oscura il token nell URL del remote', () => {
  const c = causaDalLog(["fatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnop@github.com/o/r/'"])
  assert.ok(!c.includes('ghs_abcdef'), c)
  assert.ok(c.includes('***@github.com'), c)
})

test('motivoDalVerdetto: toglie il comando, tiene il motivo', () => {
  const v = 'Error while executing command: if [ -f /tmp/x ]; then\n  echo "apply saltato"\nfi\n. Reason: exit status 1'
  assert.equal(motivoDalVerdetto(v), 'comando fallito (exit status 1)')
  assert.equal(motivoDalVerdetto('boom'), 'boom')
  assert.equal(motivoDalVerdetto(null), null)
})

test('pulisci: toglie colori e prefisso di terragrunt, tiene l unit', () => {
  assert.deepEqual(pulisci(APPLY_IN_PARALLELO[2]), { unit: 'network', testo: 'Error: Error acquiring the state lock' })
})
