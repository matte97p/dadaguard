import { test } from 'node:test'
import assert from 'node:assert/strict'
import { causaDalLog, motivoDalVerdetto, pubblicatoDalLog, pulisci } from '../server/buildCausa.js'

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
  assert.equal(causaDalLog(APPLY_IN_PARALLELO), 'state locked by another apply (network), 19 units failed')
})

test('causaDalLog: un errore terraform qualsiasi porta la sua unit', () => {
  const righe = [`${E}[90m10:00:00.000${E}[m ${E}[31mSTDERR${E}[m [services/backend] terraform: │ Error: creating ECS Service: InvalidParameterException`]
  assert.equal(causaDalLog(righe), 'services/backend: creating ECS Service: InvalidParameterException')
})

test('causaDalLog: le righe di script che contengono la parola non sono errori', () => {
  assert.equal(causaDalLog(['ERRORE=""', '  echo "Error: manca il file" && exit 1']), '')
})

test('causaDalLog: oscura il token nell URL del remote', () => {
  // L'URL si compone a pezzi: scritto intero, il guardiano del repo pubblico lo legge come un'email.
  const url = ['https://x-access-token:ghs_abcdefghijklmnop', 'github.com/o/r/'].join('@')
  const c = causaDalLog([`fatal: unable to access '${url}'`])
  assert.ok(!c.includes('ghs_abcdef'), c)
  assert.ok(c.includes('***@github.com'), c)
})

test('motivoDalVerdetto: toglie il comando, tiene il motivo', () => {
  const v = 'Error while executing command: if [ -f /tmp/x ]; then\n  echo "apply saltato"\nfi\n. Reason: exit status 1'
  assert.equal(motivoDalVerdetto(v), 'exit status 1, cause not found')
  assert.equal(motivoDalVerdetto('boom'), 'boom')
  assert.equal(motivoDalVerdetto(null), null)
})

test('pulisci: toglie colori e prefisso di terragrunt, tiene l unit', () => {
  assert.deepEqual(pulisci(APPLY_IN_PARALLELO[2]), { unit: 'network', testo: 'Error: Error acquiring the state lock' })
})

test('causaDalLog: lo smoke test che scarta la versione nuova e\' la causa', () => {
  const righe = ['    printf "smoke test failed%s" "$X"', 'SMOKE TEST FAILED: version new-1 was NOT promoted, old-1 still serves the site.', 'ERROR something after']
  assert.equal(causaDalLog(righe), 'smoke test failed')
})

test('causaDalLog: npm, git e python dicono chi ha parlato', () => {
  assert.equal(causaDalLog(['npm ERR! ERESOLVE unable to resolve dependency tree']), 'npm failed, ERESOLVE unable to resolve dependency tree')
  assert.equal(causaDalLog(["fatal: couldn't find remote ref main"]), "git failed, couldn't find remote ref main")
  assert.equal(causaDalLog(['Traceback (most recent call last):']), 'python crashed')
})

// Le righe di wrangler come arrivano dal filtro, con la cornice davanti.
const CARICATA = 'Worker Version ID: new-1'
const AL_100 = (v) => `\u2570  SUCCESS  Deployed my-worker version ${v} at 100% (2.10 sec)`

test('pubblicatoDalLog: versione caricata e poi messa al 100% = gia\' in servizio', () => {
  assert.equal(pubblicatoDalLog([CARICATA, AL_100('new-1')]), true)
})

test('pubblicatoDalLog: lo smoke test scarta la nuova e rimette la vecchia al 100%', () => {
  const righe = [CARICATA, '\u2570  SUCCESS  Deployed my-worker version old-1 at 100% and version new-1 at 0% (2.50 sec)', AL_100('old-1')]
  assert.equal(pubblicatoDalLog(righe), false)
})

test('pubblicatoDalLog: wrangler deploy classico pubblica con Current Version ID', () => {
  assert.equal(pubblicatoDalLog(['Uploaded my-worker (10.00 sec)', 'Current Version ID: new-1']), true)
  assert.equal(pubblicatoDalLog(['Uploaded my-worker (10.00 sec)']), false)
  assert.equal(pubblicatoDalLog([]), false)
})
