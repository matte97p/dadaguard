import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNoise } from '../web/logNoise.js'

// Le righe di piattaforma Lambda sono contorno e restano nascoste: START/END/REPORT/INIT non dicono
// niente di quello che il job ha fatto.
test('START/END/REPORT/INIT sono rumore', () => {
  for (const riga of [
    'START RequestId: 426a9be1-18c4-418b-b8b7-91ada4d5306f Version: $LATEST',
    'END RequestId: 426a9be1-18c4-418b-b8b7-91ada4d5306f',
    'REPORT RequestId: 426a9be1\tDuration: 812.11 ms\tBilled Duration: 813 ms\tMemory Size: 512 MB\tMax Memory Used: 210 MB',
    'INIT_START RequestId: 426a9be1 Runtime Version: python:3.13',
    'XRAY RequestId: 426a9be1 TraceId: 1-abc',
  ]) {
    assert.equal(isNoise(riga), true, riga.slice(0, 40))
  }
})

// Il caso per cui esiste questo modulo: una Lambda uccisa DAL RUNTIME non scrive nessuna eccezione, e
// il verdetto sta sulla REPORT. Se la nascondi, il pannello dei log di un cron rosso è vuoto, che è
// esattamente quello che è successo il 06/09/2026 su una Lambda schedulata in produzione, tre
// tentativi su tre in Runtime.OutOfMemory e «Nessun evento nella finestra» a schermo.
test('la REPORT che dichiara un errore NON è rumore', () => {
  for (const riga of [
    'REPORT RequestId: 426a9be1\tDuration: 31644.88 ms\tMemory Size: 512 MB\tMax Memory Used: 512 MB\tStatus: error\tError Type: Runtime.OutOfMemory',
    'REPORT RequestId: 426a9be1\tDuration: 300000.00 ms\tStatus: timeout',
    'END RequestId: 426a9be1 Task timed out after 300.00 seconds',
    'REPORT RequestId: 426a9be1\tStatus: error\tError Type: Runtime exited with error: signal: killed',
  ]) {
    assert.equal(isNoise(riga), false, riga.slice(0, 60))
  }
})

// Una riga applicativa non è mai rumore, anche quando nomina la parola REPORT.
test('le righe applicative passano sempre', () => {
  for (const riga of [
    '[INFO]\t2026-09-05T09:34:17.247Z\t426a9be1\tClickHouse returned 250901 award row(s)',
    '[ERROR] KeyError: cf_norm',
    'REPORT generato per 3 fondi',
    '',
  ]) {
    assert.equal(isNoise(riga), false, riga.slice(0, 40))
  }
})

// Il pannello passa `e.message` grezzo: può avere spazi davanti (indentazione di un traceback) e può
// essere assente. Nessuno dei due deve far cadere il filtro.
test('regge messaggio assente e spazi davanti', () => {
  assert.equal(isNoise(undefined), false)
  assert.equal(isNoise(null), false)
  assert.equal(isNoise('   START RequestId: abc'), true)
  assert.equal(isNoise('   REPORT RequestId: abc\tStatus: error'), false)
})
