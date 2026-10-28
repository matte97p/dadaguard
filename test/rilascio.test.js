import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statoRilascio } from '../shared/rilascio.js'

test('statoRilascio: rilascio dopo il fallimento, provato da un giro riuscito, oppure niente', () => {
  assert.equal(statoRilascio({ rilascio: 200, ultimaFallita: 100 }), 'rilasciato')
  assert.equal(statoRilascio({ rilascio: 200, ultimaFallita: 100, ultimaRiuscita: 300 }), 'verificato')
  assert.equal(statoRilascio({ rilascio: 200, ultimaFallita: 100, ultimaRiuscita: 150 }), 'rilasciato', 'una riuscita prima del rilascio non prova la versione nuova')
  assert.equal(statoRilascio({ rilascio: 100, ultimaFallita: 200 }), null, 'fallito dopo il rilascio')
  assert.equal(statoRilascio({ rilascio: 100, ultimaFallita: 100 }), null)
  assert.equal(statoRilascio({ rilascio: null, ultimaFallita: 100 }), null)
  assert.equal(statoRilascio({ rilascio: 200, ultimaFallita: null }), null)
  assert.equal(statoRilascio(), null)
  assert.equal(statoRilascio({ rilascio: '2026-10-21T10:00:00Z', ultimaFallita: new Date('2026-10-21T09:00:00Z') }), 'rilasciato')
})
