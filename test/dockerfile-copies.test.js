// L'immagine deve contenere TUTTO quello che il server importa. Sembra ovvio, e infatti non lo era:
// `shared/` è nato il 29/06/2026 per condividere una funzione fra server e web, il Dockerfile copiava
// solo `server` e `dist`, e da lì ogni deploy è morto all'avvio con
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/shared/nodeId.js'
//
// Il modo peggiore di sbagliare: `npm test` verde, `docker build` verde, immagine su ECR, e il guasto
// compare solo dentro al container, mentre ECS riavvia il task all'infinito e in produzione resta il
// codice di prima. Il web non lo vede perché vite gli impacchetta quei file dentro `dist/`.
//
// La prova VERA che il server parte dentro all'immagine la fa la CI (`.github/workflows/test.yml`, che
// dal 17/08/2026 costruisce l'immagine e ci importa dentro `server/index.js`). Questo test è il
// controllo veloce che gira anche in locale, senza docker, e che dice PERCHÉ invece di limitarsi a
// fallire: quale cartella manca, e dove.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function jsFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...jsFiles(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

// Ogni specificatore relativo, con le virgolette che capitano e anche nella forma dinamica: contare i
// `../` a mano sbagliava in tutti e due i versi (un `../../../x` catturava `..`, un `../../util/y` che
// resta dentro `server/` chiedeva un COPY che non serve). Qui il path si RISOLVE, come fa node.
const RELATIVI = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g

// Le cartelle di primo livello fuori da `server/` che il server importa: quelle devono esistere anche
// nell'immagine. Quello che resta dentro `server/` arriva già con `COPY server ./server`.
export function cartelleImportateDalServer(base = root) {
  const fuori = new Set()
  for (const f of jsFiles(join(base, 'server'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(RELATIVI)) {
      const rel = relative(base, resolve(dirname(f), m[1]))
      if (rel.startsWith('..')) continue // esce dal repo: non è roba nostra da copiare
      const primo = rel.split(sep)[0]
      if (primo !== 'server') fuori.add(primo)
    }
  }
  return [...fuori].sort()
}

// Cosa finisce nell'immagine FINALE: conta solo l'ultimo stage, perché i `COPY` di uno stage intermedio
// vanno in un'immagine che viene buttata via, e contarli darebbe un verde falso. Le direttive Docker non
// sono case-sensitive e una `COPY` prende più sorgenti e dei flag, quindi si legge tutta la riga: la
// destinazione è l'ultimo pezzo, le sorgenti sono quelle prima.
export function copiateNellImmagineFinale(base = root) {
  const righe = readFileSync(join(base, 'Dockerfile'), 'utf8').split('\n')
  const indiciFrom = righe.map((r, i) => (/^\s*FROM\s/i.test(r) ? i : -1)).filter((i) => i >= 0)
  const copiate = new Map() // sorgente di primo livello → destinazione dichiarata
  for (const r of righe.slice(indiciFrom.at(-1) ?? 0)) {
    const m = r.match(/^\s*COPY\s+(.*)$/i)
    if (!m) continue
    const pezzi = m[1].split(/\s+/).filter((p) => p && !p.startsWith('--'))
    if (pezzi.length < 2) continue
    const dest = pezzi.at(-1)
    for (const src of pezzi.slice(0, -1)) copiate.set(src.replace(/^\.\//, '').split('/')[0], dest)
  }
  return copiate
}

// Dove finisce, dentro all'immagine, una cartella copiata: `./shared` e `/app/shared` vanno bene (la
// WORKDIR è `/app`), `./server/shared` no. Una destinazione sbagliata supera un controllo che guarda
// solo la sorgente, e poi il container muore all'avvio come se il COPY non ci fosse.
export function destinazioneGiusta(cartella, dest) {
  const pulita = dest.replace(/^\/app\//, '').replace(/^\.\//, '').replace(/\/$/, '')
  return pulita === '' || pulita === '.' || pulita === cartella
}

test("l'immagine copia tutte le cartelle che il server importa", () => {
  const copiate = copiateNellImmagineFinale()
  const problemi = []
  for (const d of cartelleImportateDalServer()) {
    if (!copiate.has(d)) problemi.push(`${d}: nessun COPY nello stage di runtime`)
    else if (!destinazioneGiusta(d, copiate.get(d)))
      problemi.push(`${d}: copiata in ${copiate.get(d)}, ma il server la risolve in /app/${d}`)
  }
  assert.deepEqual(
    problemi,
    [],
    `il server importa cartelle che nell'immagine non ci sono (o stanno nel posto sbagliato):\n${problemi.join('\n')}\n` +
      'Il container morirà all\'avvio con ERR_MODULE_NOT_FOUND, dopo che build e test sono passati.',
  )
})

// Le due letture sono la parte fragile, quindi si provano su un finto repo invece che sul nostro: qui
// dentro stanno le varianti che un controllo scritto a occhio non vede, e ognuna è un modo diverso di
// rimettere in piedi lo stesso guasto senza accorgersene.
function finto(dockerfile, importRiga, dove = 'server/topology/deduce.js') {
  const dir = mkdtempSync(join(tmpdir(), 'dadaguard-copies-'))
  mkdirSync(join(dir, dirname(dove)), { recursive: true })
  writeFileSync(join(dir, dove), importRiga)
  writeFileSync(join(dir, 'Dockerfile'), dockerfile)
  return dir
}

const RUNTIME_OK = 'FROM node:22 AS build\nCOPY . .\n\nFROM node:22\nCOPY server ./server\nCOPY shared ./shared\n'

test('gli import si leggono a doppi apici, dinamici e a un livello solo', () => {
  for (const riga of [
    `import { a } from "../../shared/nodeId.js"`,
    `const m = await import('../../shared/nodeId.js')`,
    `export { a } from '../../shared/nodeId.js'`,
  ]) {
    assert.deepEqual(cartelleImportateDalServer(finto(RUNTIME_OK, riga)), ['shared'], riga)
  }
  // un salto solo, da un file in cima a `server/`: esce lo stesso da server/
  assert.deepEqual(
    cartelleImportateDalServer(finto(RUNTIME_OK, `import { a } from '../shared/nodeId.js'`, 'server/index.js')),
    ['shared'],
  )
})

test('quello che resta dentro server/ non si chiede al Dockerfile', () => {
  // `../../util/pool.js` da `server/topology/` è `server/util/`: arriva già con `COPY server ./server`,
  // e pretenderne un COPY suo farebbe fallire la CI su un Dockerfile giusto.
  assert.deepEqual(cartelleImportateDalServer(finto(RUNTIME_OK, `import { p } from '../util/pool.js'`)), [])
  assert.deepEqual(cartelleImportateDalServer(finto(RUNTIME_OK, `import { p } from '../../../fuori/x.js'`)), [])
})

test('il Dockerfile si legge anche minuscolo, con i flag e con più sorgenti', () => {
  const df = 'from node:22 as build\nCOPY . .\n\nfrom node:22\ncopy --chown=node:node shared web ./\n'
  const copiate = copiateNellImmagineFinale(finto(df, `import { a } from '../../shared/nodeId.js'`))
  assert.equal(copiate.get('shared'), './', 'il flag --chown non deve essere scambiato per una sorgente')
  assert.ok(copiate.has('web'), 'la seconda sorgente di un COPY non si perde')
})

test('i COPY di uno stage buttato via non contano', () => {
  const df = 'FROM node:22 AS build\nCOPY shared ./shared\n\nFROM node:22\nCOPY server ./server\n'
  const copiate = copiateNellImmagineFinale(finto(df, `import { a } from '../../shared/nodeId.js'`))
  assert.equal(copiate.has('shared'), false, 'lo stage di build non spedisce niente')
})

test('una destinazione sbagliata non è una cartella copiata', () => {
  assert.equal(destinazioneGiusta('shared', './shared'), true)
  assert.equal(destinazioneGiusta('shared', '/app/shared'), true)
  assert.equal(destinazioneGiusta('shared', './'), true, 'COPY shared ./ mette la cartella in /app/shared')
  assert.equal(destinazioneGiusta('shared', './server/shared'), false)
  assert.equal(destinazioneGiusta('shared', '/app/tmp/altro'), false)
})

test('il test guarda qualcosa: le due letture funzionano davvero', () => {
  assert.ok(
    cartelleImportateDalServer().includes('shared'),
    'atteso almeno `shared` fra gli import fuori da server/: se la lettura degli import si rompe, il controllo sopra diventa vuoto e verde',
  )
  assert.ok(
    copiateNellImmagineFinale().has('server'),
    'atteso `COPY server` nello stage di runtime: se il parser del Dockerfile si rompe, il controllo sopra accusa il Dockerfile invece del parser',
  )
})
