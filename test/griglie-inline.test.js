import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

// GUARDIANO delle colonne in linea. Una riga di lista (`.ui-row`), la sua intestazione (`.ui-thead`) e
// il riquadro a due colonne (`.ui-hero`) prendono le colonne da variabili CSS (`--ui-cols`,
// `--ui-cols-m`, `--ui-hero-cols`), che la media query del telefono in web/ui/ui.css sostituisce.
// Uno `style={{ gridTemplateColumns }}` sullo stesso elemento vince su qualsiasi media query: era il
// guasto per cui sotto gli 860px le righe restavano a cinque colonne e i nomi andavano a capo una
// lettera per riga. Si e' visto solo con uno screenshot a 400px, quindi qui lo si impedisce a monte.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fileWeb(dir = join(root, 'web')) {
  const out = []
  for (const voce of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, voce.name)
    if (voce.isDirectory()) out.push(...fileWeb(p))
    else if (/\.jsx$/.test(voce.name)) out.push(p)
  }
  return out
}

// Il tag JSX di apertura che contiene la posizione `i`: dal `<` prima fino al `>` che lo chiude, saltando
// quelli dentro alle graffe (`=>`, confronti) e alle stringhe.
function tagAttorno(src, i) {
  const inizio = src.lastIndexOf('<', i)
  let profondita = 0
  let stringa = null
  for (let j = inizio + 1; j < src.length; j++) {
    const c = src[j]
    if (stringa) {
      if (c === stringa && src[j - 1] !== '\\') stringa = null
    } else if (c === '"' || c === "'" || c === '`') stringa = c
    else if (c === '{') profondita++
    else if (c === '}') profondita--
    else if (c === '>' && profondita === 0) return src.slice(inizio, j + 1)
  }
  return src.slice(inizio)
}

test('nessuna riga, intestazione o hero ha le colonne in uno stile in linea', () => {
  const colpevoli = []
  for (const f of fileWeb()) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/className=\{?[`'"][^`'"]*\bui-(row|thead|hero)\b/g)) {
      const tag = tagAttorno(src, m.index)
      if (/gridTemplateColumns/.test(tag)) colpevoli.push(`${relative(root, f)}: ${tag.split('\n')[0].trim()}`)
    }
  }
  assert.deepEqual(colpevoli, [], 'usa <Lista griglia grigliaMobile> o stileGriglia(): ' + colpevoli.join('; '))
})
