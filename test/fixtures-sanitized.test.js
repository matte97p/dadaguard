import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Le fixture di contratto sono risposte AWS VERE, e questo repo è PUBBLICO: qualcosa che identifica
// l'infrastruttura di qualcuno non deve entrarci. Il registratore sanifica, ma una regola scritta una
// volta si dimentica — questo test è il guardiano che resta.
//
// Se cade dopo una nuova registrazione: NON allentare il test, aggiungi la regola mancante a
// `sanitize()` in scripts/record-aws-fixtures.mjs e ri-registra.
const DIR = new URL('./fixtures/aws/', import.meta.url).pathname

// Cose che non devono comparire. Non è un elenco di segreti (quelli non passano da qui): è l'elenco
// di ciò che RICONDUCE a un'infrastruttura o a una persona.
const VIETATI = [
  { re: /\bcato\b|cato-|\/cato\//i, cosa: 'nome interno dell’organizzazione' },
  { re: /get-cato\.com/i, cosa: 'dominio interno' },
  { re: /avvista/i, cosa: 'nome di prodotto interno' },
  { re: /AWSReservedSSO_(?!Ruolo_0000)/, cosa: 'permission set SSO reale' },
  { re: /assumed-role\/[^/"]*\/(?!persona)[A-Z][a-zA-Z]+(?=["/])/, cosa: 'nome di una persona in una sessione' },
  { re: /@(?!example\.com)[a-z0-9.-]+\.(com|it|dev|net|org)/i, cosa: 'email reale' },
  { re: /hooks\.slack\.com/i, cosa: 'webhook Slack' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, cosa: 'access key' },
]

// Gli id account veri di Cato: se compaiono, la sostituzione non ha funzionato.
const ACCOUNT_VIETATI = ['051986612631', '521595303218', '708895069864']

const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))

test('le fixture registrate esistono (il registratore è stato usato)', () => {
  assert.ok(files.length >= 4, `attese almeno 4 fixture, trovate ${files.length}`)
})

for (const f of files) {
  test(`fixture sanificata: ${f}`, () => {
    const raw = readFileSync(join(DIR, f), 'utf8')
    for (const { re, cosa } of VIETATI) {
      const m = raw.match(re)
      assert.equal(m, null, `${f} contiene ${cosa}: ${m?.[0]}`)
    }
    for (const id of ACCOUNT_VIETATI) {
      assert.ok(!raw.includes(id), `${f} contiene un id account reale (${id})`)
    }
    // ogni fixture dice cosa dimostra: senza la nota, in sei mesi non si capisce perché esiste
    const j = JSON.parse(raw)
    assert.ok(typeof j._nota === 'string' && j._nota.length > 20, `${f} senza _nota che spieghi la forma`)
    assert.ok(j.payload, `${f} senza payload`)
  })
}
