import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demoSecurity } from '../server/demo.js'

// La pagina Sicurezza era bilingue a metà: severità e categorie si traducevano (stanno nel FE), la
// riga che dice QUAL È il problema no — era una frase italiana scritta a mano dentro `security.js`,
// e con la UI in inglese restava italiana. Si vedeva solo guardando la pagina in inglese, cioè quasi
// mai: il difetto è emerso registrando il video demo.
//
// Questo test guarda il percorso demo perché è quello che gira senza AWS, ma le frasi sono le stesse
// chiavi del percorso vero (`server/i18n.js`, namespace `sec.`): se qualcuno torna a scrivere una
// stringa a mano in una delle due strade, la lingua smette di cambiare e questo test cade.
//
// La copertura delle chiavi (esistono in it E en?) la fa già `i18n-server.test.js`.

const dettagli = (lang) => demoSecurity(lang).findings.map((f) => f.detail)

test('i findings di sicurezza cambiano lingua', () => {
  const it = dettagli('it')
  const en = dettagli('en')
  assert.equal(it.length, en.length, 'le due lingue devono avere gli stessi finding')
  assert.notDeepEqual(it, en, 'i dettagli in inglese sono identici a quelli in italiano: non stanno passando dal dizionario')
})

// Le parole-spia sono quelle che comparivano nelle frasi scritte a mano. Non è un controllo
// linguistico generale: è l'elenco di ciò che si vedeva davvero in inglese.
const SPIE = ['aperto', 'senza', 'scade', 'scaduto', 'attiva', 'ruotato', 'utente', 'raggiungibile', 'esposto']

test('in inglese non resta niente di italiano nei dettagli', () => {
  for (const d of dettagli('en')) {
    const spia = SPIE.find((w) => d.toLowerCase().includes(w))
    assert.equal(spia, undefined, `dettaglio inglese con parola italiana «${spia}»: ${d}`)
  }
})

test('i numeri finiscono nella frase, in entrambe le lingue', () => {
  for (const lang of ['it', 'en']) {
    for (const d of dettagli(lang)) {
      assert.ok(!/\{\w+\}/.test(d), `segnaposto non interpolato in ${lang}: ${d}`)
    }
    // I giorni sono la parte interpolata: se l'interpolazione salta, questi finding perdono il numero.
    assert.ok(
      dettagli(lang).some((d) => /\d+/.test(d)),
      `nessun dettaglio con un numero in ${lang}`,
    )
  }
})
