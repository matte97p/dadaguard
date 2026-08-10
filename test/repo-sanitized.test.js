import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { violazione } from './vietati.js'

// Il guardiano su TUTTO quello che il repo pubblica: sorgenti, test, docs, esempi, workflow.
//
// Le fixture avevano il loro guardiano, la demo l'ha avuto dopo, e ogni volta la cosa era rientrata
// da un'altra porta — un nome vero in un commento, in una fixture di test, in un esempio del README.
// Il punto non è che qualcuno sbagli: è che il repo è pubblico e chi scrive un test pensa al test,
// non a chi leggerà quel nome su GitHub. Quindi lo controlla una macchina, su tutti i file tracciati.
//
// L'elenco di ciò che non deve comparire sta in `vietati.js`, condiviso con gli altri due guardiani.
// Se questo test cade: NON allentarlo, cambia il nome. Un identificativo inventato prova esattamente
// le stesse cose — e se la forma del nome è ciò che il test dimostra (un prefisso da spogliare, per
// esempio), la si tiene: cambia la parola, non la forma.
//
// I file che DEVONO contenere quelle stringhe sono i guardiani stessi.
// `record-aws-fixtures.mjs` è il sanificatore: per togliere quei nomi deve poterli nominare.
const ESCLUSI = new Set([
  'test/vietati.js',
  'test/repo-sanitized.test.js',
  'test/demo-sanitized.test.js',
  'test/fixtures-sanitized.test.js',
  'scripts/record-aws-fixtures.mjs',
])
const ESTENSIONI = /\.(js|jsx|mjs|cjs|md|ya?ml|json|tf|sh|dockerfile|example)$/i

// `git ls-files`: solo i file TRACCIATI. Quello che non è committato non è pubblicato, e includere
// build/ o node_modules renderebbe il test lentissimo e rumoroso.
const tracciati = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => ESTENSIONI.test(f) || f === 'Dockerfile')
  .filter((f) => !ESCLUSI.has(f))

test('il repo pubblica solo file tracciati, e ce ne sono (il test guarda qualcosa)', () => {
  assert.ok(tracciati.length > 50, `attesi >50 file tracciati, trovati ${tracciati.length}`)
})

test('nessun nome interno nei file tracciati', () => {
  const colpevoli = []
  for (const f of tracciati) {
    let raw
    try {
      raw = readFileSync(f, 'utf8')
    } catch {
      continue // binario o link: niente da leggere
    }
    const v = violazione(raw)
    if (v) colpevoli.push(`${f}: ${v.cosa} → ${v.trovato}`)
  }
  assert.deepEqual(colpevoli, [], `nomi interni nel repo pubblico:\n${colpevoli.join('\n')}`)
})
