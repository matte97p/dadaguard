// Prova di FUMO: carica ogni pagina in un browser vero e falla fallire se la console ha un errore.
//
// Perché esiste, e cosa avrebbe preso: il 31/08/2026 la pagina Accessi è arrivata in produzione con un
// `ReferenceError: Cannot access '…' before initialization` a ogni render, cioè bianca. Il bundler non
// lo vede (non è un errore di sintassi) e le 848 asserzioni nemmeno, perché nessuna RENDERIZZA un
// componente: giravano tutte verdi su una pagina che esplodeva. Questa colma quel buco, e lo colma per
// tutte le pagine, non solo per quella che si è rotta.
//
// Zero dipendenze nuove, di proposito (il repo non ha né Puppeteer né Playwright): Node 22 porta un
// client WebSocket nativo, quindi si parla direttamente col protocollo di Chrome. Un browser di prova
// da 300 MB nel lockfile per leggere la console sarebbe stato il rimedio peggiore del male.
//
// Uso:  npm run smoke            # tutte le pagine
//       npm run smoke -- /accessi /iam
// Env:  SMOKE_CHROME  percorso del browser (default: il primo che si trova)
//       SMOKE_PORT    porta del server di prova (default 3199)
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORTA = Number(process.env.SMOKE_PORT) || 3199
// Sotto questa quantita' di testo dentro `#root` la pagina e' bianca. Venti caratteri: un titolo e una
// riga di intestazione stanno sopra, una pagina che ha sollevato un'eccezione al primo render sta sotto.
const SOGLIA_RENDER = 20
const BASE = `http://127.0.0.1:${PORTA}`
const PAGINE = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/', '/servizi', '/esecuzioni', '/deploy', '/spesa', '/limiti', '/topologia', '/iam', '/accessi', '/sicurezza']

// I browser dove si trovano davvero: sul Mac di chi sviluppa e sui runner della CI.
const CANDIDATI = [
  process.env.SMOKE_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const trovaChrome = () => CANDIDATI.find((p) => existsSync(p))

const attendi = (ms) => new Promise((r) => setTimeout(r, ms))

// Aspetta che qualcosa risponda, invece di dormire un tempo fisso: un `sleep 5` è la prova che diventa
// intermittente sul runner lento e lunga su quello veloce.
async function aspettaChe(cosa, prova, tentativi = 60) {
  for (let i = 0; i < tentativi; i++) {
    try {
      const out = await prova()
      if (out) return out
    } catch {
      /* non è ancora su */
    }
    await attendi(250)
  }
  throw new Error(`${cosa} non è arrivato in tempo`)
}

// ── Il server di prova: modalità demo, quindi zero AWS e dati finti ma completi ────────────────────
function avviaServer() {
  const p = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, DADAGUARD_DEMO: '1', PORT: String(PORTA), LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  p.stdout.resume()
  p.stderr.resume()
  return p
}

// ── Il browser, guidato col protocollo di Chrome ────────────────────────────────────────────────────
function avviaChrome(bin, profilo) {
  return spawn(
    bin,
    [
      '--headless=old', // esce da sé al termine, e non ha bisogno di un display
      '--disable-gpu',
      '--no-sandbox', // sui runner della CI il sandbox non è disponibile
      '--no-first-run',
      '--disable-extensions',
      `--user-data-dir=${profilo}`,
      '--remote-debugging-port=0', // porta libera scelta da Chrome, scritta nel file sotto
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

// La porta vera la scrive Chrome in `DevToolsActivePort` dentro al profilo: chiedergliela evita di
// litigare per una porta fissa quando due prove girano insieme.
async function portaDevTools(profilo) {
  const { readFile } = await import('node:fs/promises')
  return aspettaChe('la porta di DevTools', async () => {
    const testo = await readFile(join(profilo, 'DevToolsActivePort'), 'utf8')
    const porta = Number(testo.split('\n')[0])
    return Number.isFinite(porta) && porta > 0 ? porta : null
  })
}

// Una pagina: apre una scheda, ascolta gli errori, naviga, e aspetta che il render sia FINITO.
//
// ⚠️ Aspettare un tempo fisso non funziona: la prima stesura misurava dopo 400ms e dava «pagina vuota»
// su due pagine su dieci, che sono semplicemente quelle che caricano piu' dati. Una prova che sbaglia
// due volte su dieci non la guarda nessuno, e la volta che ha ragione non le si crede. Quindi si
// aspetta che `#root` abbia del testo, con un tetto, e solo dopo si giudica.
async function provaPagina(portaCdp, percorso) {
  const nuova = await fetch(`http://127.0.0.1:${portaCdp}/json/new?about:blank`, { method: 'PUT' })
  const scheda = await nuova.json()
  const ws = new WebSocket(scheda.webSocketDebuggerUrl)
  const errori = []
  let id = 0
  const attese = new Map()

  await new Promise((ok, ko) => {
    ws.addEventListener('open', ok, { once: true })
    ws.addEventListener('error', () => ko(new Error('non riesco a parlare col browser')), { once: true })
  })

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id != null && attese.has(m.id)) {
      attese.get(m.id)(m.result)
      attese.delete(m.id)
      return
    }
    // Un'eccezione non gestita: e' il caso del ReferenceError, e React la rilancia sempre.
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails
      errori.push(`eccezione: ${String(d?.exception?.description ?? d?.text ?? 'senza descrizione').split('\n')[0]}`)
    }
    // `console.error(...)`: React ci scrive l'errore di render prima di rilanciarlo, e una libreria che
    // si lamenta scrive solo li'.
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      const testo = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
      errori.push(`console.error: ${testo.split('\n')[0].slice(0, 200)}`)
    }
    // Errori del browser stesso: una richiesta fallita, un CSP che blocca, un modulo che non carica.
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      errori.push(`browser: ${String(m.params.entry.text).slice(0, 200)}`)
    }
  })

  const chiedi = (method, params = {}) =>
    new Promise((ok) => {
      const mio = ++id
      attese.set(mio, ok)
      ws.send(JSON.stringify({ id: mio, method, params }))
      setTimeout(() => attese.delete(mio) && ok(null), 10_000)
    })

  await chiedi('Runtime.enable')
  await chiedi('Log.enable')
  await chiedi('Page.enable')
  await chiedi('Page.navigate', { url: `${BASE}${percorso}` })

  // Quanto testo c'e' dentro `#root`: e' la misura del render, e un `#root` vuoto e' il sintomo del
  // guasto anche quando l'eccezione non arriva in console.
  const misura = async () => {
    const r = await chiedi('Runtime.evaluate', {
      expression: 'document.querySelector("#root")?.innerText?.length ?? 0',
      returnByValue: true,
    })
    return r?.result?.value ?? 0
  }

  let lunghezza = 0
  for (let i = 0; i < 60 && lunghezza < SOGLIA_RENDER; i++) {
    lunghezza = await misura()
    if (lunghezza < SOGLIA_RENDER) await attendi(250)
  }
  // Mezzo secondo in piu' a render finito: gli errori che nascono dopo il primo paint (una fetch che
  // torna e un componente che si lamenta) arrivano proprio qui.
  await attendi(500)

  ws.close()
  await fetch(`http://127.0.0.1:${portaCdp}/json/close/${scheda.id}`).catch(() => {})
  return { errori, lunghezza }
}

// ── Il giro ─────────────────────────────────────────────────────────────────────────────────────────
const bin = trovaChrome()
if (!bin) {
  console.error('✗ nessun browser trovato. Passa SMOKE_CHROME=/percorso/al/browser')
  process.exit(2)
}

const profilo = await mkdtemp(join(tmpdir(), 'dadaguard-smoke-'))
const server = avviaServer()
const chrome = avviaChrome(bin, profilo)
let usciteRosse = 0

const chiudi = async () => {
  chrome.kill('SIGKILL')
  server.kill('SIGTERM')
  await rm(profilo, { recursive: true, force: true }).catch(() => {})
}

try {
  await aspettaChe('il server di prova', async () => (await fetch(`${BASE}/healthz`)).ok)
  const portaCdp = await portaDevTools(profilo)

  for (const percorso of PAGINE) {
    const { errori, lunghezza } = await provaPagina(portaCdp, percorso)
    // Una pagina che non scrive niente dentro `#root` è bianca: e' il sintomo del guasto anche quando
    // l'eccezione non arriva fino alla console.
    if (lunghezza < SOGLIA_RENDER) errori.push('la pagina non ha renderizzato niente (#root vuoto)')
    if (errori.length) {
      usciteRosse += 1
      console.log(`✗ ${percorso}`)
      for (const e of [...new Set(errori)].slice(0, 5)) console.log(`    ${e}`)
    } else {
      console.log(`✓ ${percorso}  (${lunghezza} caratteri renderizzati)`)
    }
  }
} finally {
  await chiudi()
}

console.log('')
if (usciteRosse) {
  console.error(`✗ ${usciteRosse} pagine su ${PAGINE.length} con errori in console`)
  process.exit(1)
}
console.log(`✓ ${PAGINE.length} pagine caricate, console pulita`)
