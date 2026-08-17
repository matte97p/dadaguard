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
// Questo test guarda gli import del server che escono dalla sua cartella e pretende che la cartella di
// destinazione sia copiata nello stage di runtime.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function jsFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...jsFiles(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

// Le cartelle di primo livello importate dal server con un `../../<cartella>/…`: il doppio salto esce
// da `server/`, quindi quella cartella deve esistere anche nell'immagine.
function cartelleImportateDalServer() {
  const fuori = new Set()
  for (const f of jsFiles('server')) {
    for (const m of readFileSync(f, 'utf8').matchAll(/from '\.\.\/\.\.\/([^/']+)\//g)) fuori.add(m[1])
  }
  return [...fuori].sort()
}

// Lo stage di runtime è l'ULTIMO `FROM`: i `COPY` degli stage precedenti finiscono in un'immagine che
// viene buttata via, quindi contarli darebbe un verde falso.
function copiateNellImmagineFinale() {
  const righe = readFileSync('Dockerfile', 'utf8').split('\n')
  const ultimoFrom = righe.map((r, i) => (/^FROM /.test(r) ? i : -1)).filter((i) => i >= 0).pop() ?? 0
  const copiate = new Set()
  for (const r of righe.slice(ultimoFrom)) {
    const m = r.match(/^COPY (?:--from=\S+\s+)?(\S+)\s/)
    if (m) copiate.add(m[1].replace(/^\.\//, '').replace(/^\/app\//, '').split('/')[0])
  }
  return copiate
}

test("l'immagine copia tutte le cartelle che il server importa", () => {
  const copiate = copiateNellImmagineFinale()
  const mancanti = cartelleImportateDalServer().filter((d) => !copiate.has(d))
  assert.deepEqual(
    mancanti,
    [],
    `il server importa da queste cartelle ma il Dockerfile non le copia nello stage di runtime: ${mancanti.join(', ')}. ` +
      'Il container morirà all\'avvio con ERR_MODULE_NOT_FOUND, dopo che build e test sono passati.',
  )
})

test('il test guarda qualcosa: almeno una cartella condivisa e almeno una copiata', () => {
  assert.ok(cartelleImportateDalServer().length > 0, 'nessun import fuori da server/: il controllo sopra non proverebbe niente')
  assert.ok(copiateNellImmagineFinale().size > 0, 'nessun COPY letto dal Dockerfile: la lettura è rotta')
})
