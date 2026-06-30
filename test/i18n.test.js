// Test di parità i18n e di resolveLang. Runner: `node --test` (built-in, zero dipendenze).
//
// Parità chiavi: NON importiamo i dizionari (in web/i18n.jsx STRINGS è interno, non esportato),
// li leggiamo dai sorgenti e ne estraiamo le chiavi con una regex. Più robusto e disaccoppiato:
// non rompe se l'export cambia, e non tocca i due file i18n (li possiede un altro agente).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// web/i18n.jsx ha estensione .jsx: Node non la carica come modulo ESM (ERR_UNKNOWN_FILE_EXTENSION),
// e non possiamo rinominare/toccare il file (lo possiede un altro agente). Le funzioni di lingua
// (LANGS, browserLang, resolveLang) stanno PRIMA di `const STRINGS` e sono JS puro (zero JSX).
// Isoliamo quel prologo e lo importiamo come modulo via data: URI — così testiamo il VERO codice.
const webSrc = readFileSync(join(root, 'web/i18n.jsx'), 'utf8')
const prologue = webSrc.slice(0, webSrc.indexOf('const STRINGS'))
const langModule = await import(
  'data:text/javascript,' + encodeURIComponent(prologue)
)
const { resolveLang } = langModule
assert.equal(typeof resolveLang, 'function', 'resolveLang non estratta da web/i18n.jsx')

// Estrae il corpo del dizionario `<lang>: { ... }` bilanciando le graffe.
function extractBlock(src, lang) {
  const head = new RegExp('(^|\\n)[ \\t]*' + lang + ':\\s*\\{')
  const m = head.exec(src)
  assert.ok(m, `blocco "${lang}" non trovato`)
  const open = src.indexOf('{', m.index)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return src.slice(open + 1, j)
  }
  throw new Error(`blocco "${lang}" non bilanciato`)
}

// Chiavi di primo livello: stringa quotata seguita da ":" a inizio riga.
function keysOf(block) {
  const keys = new Set()
  const re = /(?:^|\n)\s*(?:'([^']+)'|"([^"]+)")\s*:/g
  let m
  while ((m = re.exec(block))) keys.add(m[1] ?? m[2])
  return keys
}

function assertParity(file) {
  const src = readFileSync(join(root, file), 'utf8')
  const it = keysOf(extractBlock(src, 'it'))
  const en = keysOf(extractBlock(src, 'en'))
  assert.ok(it.size > 0, `${file}: nessuna chiave IT estratta`)
  const onlyIt = [...it].filter((k) => !en.has(k))
  const onlyEn = [...en].filter((k) => !it.has(k))
  assert.deepEqual(onlyIt, [], `${file}: chiavi solo in IT`)
  assert.deepEqual(onlyEn, [], `${file}: chiavi solo in EN`)
  assert.equal(it.size, en.size, `${file}: conteggio chiavi IT/EN diverso`)
}

test('server/i18n.js — IT ed EN hanno lo stesso set di chiavi', () => {
  assertParity('server/i18n.js')
})

test('web/i18n.jsx — IT ed EN hanno lo stesso set di chiavi', () => {
  assertParity('web/i18n.jsx')
})

test('resolveLang — preferenza salvata vince sempre', () => {
  assert.equal(resolveLang('en', 'local'), 'en')
  assert.equal(resolveLang('it', 'cloud'), 'it')
})

test('resolveLang — default IT in locale (senza preferenza)', () => {
  assert.equal(resolveLang(null, 'local'), 'it')
  assert.equal(resolveLang(undefined, 'local'), 'it')
})

test('resolveLang — preferenza non valida è ignorata', () => {
  // 'fr' non è in LANGS: cade sul default del mode (local → it).
  assert.equal(resolveLang('fr', 'local'), 'it')
})

test('resolveLang — in cloud segue il browser (en se navigator assente)', () => {
  // In ambiente Node `navigator` non c'è: browserLang() ripiega su 'en'.
  assert.equal(resolveLang(null, 'cloud'), 'en')
})
