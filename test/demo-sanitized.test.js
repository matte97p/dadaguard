import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { violazione } from './vietati.js'
import * as demo from '../server/demo.js'

// La modalità demo è la superficie PIÙ pubblica del repo: `docker run -e DADAGUARD_DEMO=1` la lancia
// chiunque, e quello che mostra finisce in screenshot, GIF e issue di sconosciuti. I dati finti erano
// cresciuti insieme all'app portandosi dietro nomi di servizi veri, budget veri e handle di persone
// vere — plausibili come esempio, e insieme una mappa dello stack di qualcuno.
//
// Le fixture avevano un guardiano da mesi; la demo no. Ora lo stesso elenco vale per entrambe.
//
// Se questo test cade: NON allentarlo. Cambia il dato finto — l'esempio funziona identico con un nome
// inventato, ed è l'unica ragione per cui esiste.

const funzioni = Object.entries(demo).filter(([n, v]) => n.startsWith('demo') && typeof v === 'function')

test('la demo espone le sue funzioni (se il nome cambia, questo test non guarda più niente)', () => {
  assert.ok(funzioni.length >= 15, `attese almeno 15 funzioni demo*, trovate ${funzioni.length}`)
})

// Ogni funzione demo, serializzata: è esattamente ciò che il browser riceve.
for (const [nome, fn] of funzioni) {
  test(`dati demo puliti: ${nome}()`, () => {
    let out
    try {
      out = fn()
    } catch {
      return // qualche demo* vuole argomenti: la coprono i chiamanti sotto
    }
    const v = violazione(JSON.stringify(out))
    assert.equal(v, null, `${nome}() contiene ${v?.cosa}: ${v?.trovato}`)
  })
}

// E il sorgente, non solo l'output: un nome vero in un commento o in un default di parametro è
// pubblico allo stesso modo, e sfuggirebbe al controllo sull'output quando quel ramo non gira.
test('il sorgente della demo è pulito, commenti e default compresi', () => {
  const src = readFileSync(new URL('../server/demo.js', import.meta.url), 'utf8')
  const v = violazione(src)
  assert.equal(v, null, `server/demo.js contiene ${v?.cosa}: ${v?.trovato}`)
})
