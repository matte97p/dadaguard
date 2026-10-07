import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { binnaSalute, caricoContainer, contenitoriDi, settimanaDiSalute, storiaAvvii } from '../server/teleport.js'
import { componiFlotta, comandoMemoria, comandiDevEnv, azioneDi, LIVELLO, andamentoFlotta, immagineInPari, riepilogoFlotta, MEM_LIBERA_BASSA_GB } from '../server/flotta.js'
import { soglieDevEnv, SOGLIE_DEV_ENV } from '../server/accessi.js'
import { linkPagina } from '../server/notify/slack.js'
import { demoFlotta } from '../server/demo.js'
import { fraseProblema, fraseAzione, valoreSerie, storiaImmagini, TIPI_PROBLEMA, TIPI_AZIONE, celleMac, azioniFlotta, COLONNE, COLONNA_DEL_PROBLEMA } from '../web/flotta.js'

// Il dizionario del frontend e' un `.jsx` senza JSX dentro: node non importa quell'estensione, quindi
// lo si carica dal suo testo, che e' esattamente il modulo che il browser riceve.
const { makeT } = await import(
  'data:text/javascript,' + encodeURIComponent(readFileSync(new URL('../web/i18n.jsx', import.meta.url), 'utf8'))
)

// La pagina Flotta (07/10/2026): una card per Mac, con il problema a parole e l'azione che lo
// risolve. Le prove difendono le tre cose che la rendono credibile: un campo che manca e' «non lo so»
// e mai zero, la gravita' e l'ordine sono quelli giusti (il Mac che ha perso lavoro per memoria finita
// e' il primo), e l'andamento di sette giorni dice il caso PEGGIORE di ogni ora.

// Mercoledi' 07/10/2026 alle 12 UTC.
const ADESSO = Date.UTC(2026, 9, 7, 12)
const ORA = 3_600_000
const GIORNO = 24 * ORA

// La riga vera di un Mac con colima e tre OOM, con persona e macchina cambiate (il repo e' pubblico).
const RIGA = {
  utente: 'RossiTizio',
  macchina: 'MacBook-Pro-di-Tizio',
  lato: 'host',
  creata: '2026-10-07T11:54:30.305Z',
  salute: {
    mac: { ram_gb: 24.0, swap_usata_mb: 12808 },
    docker: { desktop: 'Docker Engine - Community', vm_mem_gb: 11.7, vm_cpu: 4 },
    vm: { oom_kill: 3, mem_disponibile_gb: 4.3 },
    app_mb: { backend: 3742, frontend: 1147 },
    container: { uccisi_per_memoria: ['dev'], uso: { dev: { mem_mb: 4957, cpu_pct: 301 } } },
  },
}
const ev = (timestamp, riga) => ({ timestamp, message: JSON.stringify(riga) })
const conSalute = (dentro = {}, fuori = {}) => ({ ...RIGA, ...fuori, salute: { ...RIGA.salute, ...dentro } })
// Prima della riga vera, una riga di due ore fa con il contatore a zero: la VM e' la stessa, e i tre
// OOM sono NATI fra le due righe.
const PRIMA = conSalute({ vm: { oom_kill: 0, mem_disponibile_gb: 6.1 }, mac: { ram_gb: 24, swap_usata_mb: 4096 } })
const EVENTI = [ev(ADESSO - 2 * ORA, PRIMA), ev(ADESSO - 5 * 60_000, RIGA)]

// ── Le serie ──────────────────────────────────────────────────────────────────────────────────────

test('binnaSalute: un punto per ora su sette giorni, e le ore senza righe restano null (non zero)', () => {
  const { punti, passoMs, macchine } = binnaSalute(EVENTI, { adesso: ADESSO })
  assert.equal(punti, 168)
  assert.equal(passoMs, ORA)
  const s = macchine['MacBook-Pro-di-Tizio']
  for (const k of ['mem', 'oom', 'swap', 'cpu']) assert.equal(s[k].length, 168)
  // Le due righe stanno nelle ore -2 e -1 rispetto al punto corrente (l'ora delle 12, ancora vuota).
  assert.deepEqual(s.mem.slice(-3), [6.1, 4.3, null])
  assert.deepEqual(s.swap.slice(-3), [4, 12.5, null])
  assert.deepEqual(s.cpu.slice(-3), [301, 301, null])
  // Gli OOM sono quelli NATI nell'ora: la prima riga apre il contatore (zero), la seconda ne porta tre.
  assert.deepEqual(s.oom.slice(-3), [0, 3, null])
  assert.equal(s.mem.slice(0, 100).every((v) => v === null), true)
})

test('binnaSalute: dentro l ora vince il caso PEGGIORE, e il contatore OOM si segue anche fuori finestra', () => {
  const r = (oom, mem, swap) => conSalute({ vm: { oom_kill: oom, mem_disponibile_gb: mem }, mac: { swap_usata_mb: swap } })
  const eventi = [
    // Otto giorni fa: fuori dalla finestra, ma e' da li' che il contatore riparte.
    ev(ADESSO - 8 * GIORNO, r(5, 6, 0)),
    ev(ADESSO - 90 * 60_000, r(5, 6, 1024)),
    ev(ADESSO - 75 * 60_000, r(7, 2.5, 3072)),
    ev(ADESSO - 70 * 60_000, r(7, 5, 2048)),
    // La VM e' ripartita: il contatore scende, e il valore nuovo conta tutto.
    ev(ADESSO - 30 * 60_000, r(1, 5, 0)),
  ]
  const s = binnaSalute(eventi, { adesso: ADESSO }).macchine['MacBook-Pro-di-Tizio']
  assert.deepEqual(s.mem.slice(-3), [2.5, 5, null])
  assert.deepEqual(s.swap.slice(-3), [3, 0, null])
  assert.deepEqual(s.oom.slice(-3), [2, 1, null])
})

test('caricoContainer: la somma dei cpu_pct, e null quando la riga non porta il blocco', () => {
  assert.equal(caricoContainer(RIGA.salute), 301)
  assert.equal(caricoContainer({ container: { uso: { a: { cpu_pct: 20 }, b: { cpu_pct: '5' }, c: {} } } }), 25)
  assert.equal(caricoContainer({ container: {} }), null)
  assert.equal(caricoContainer({}), null)
})

test('contenitoriDi: dal piu pesante, e i campi che mancano restano null', () => {
  assert.deepEqual(contenitoriDi({ redis: { mem_mb: 90 }, dev: { mem_mb: 4957, cpu_pct: 301 }, x: {} }), [
    { nome: 'dev', memMb: 4957, cpuPct: 301 },
    { nome: 'redis', memMb: 90, cpuPct: null },
    { nome: 'x', memMb: null, cpuPct: null },
  ])
  assert.deepEqual(contenitoriDi(undefined), [])
})

test('settimanaDiSalute: le 24 ore, le ultime righe dei sette giorni e la serie, da una lettura sola', () => {
  const vecchia = ev(ADESSO - 3 * GIORNO, { ...RIGA, macchina: 'mac-spento' })
  const s = settimanaDiSalute([...EVENTI, vecchia], { adesso: ADESSO, troncato: true })
  // Il Mac spento da tre giorni non e' fra quelli delle 24 ore, ma la sua ultima riga si sa.
  assert.deepEqual(s.macchine.map((m) => m.macchina), ['MacBook-Pro-di-Tizio'])
  assert.equal(s.macchine[0].oomNuovi, 3)
  assert.deepEqual(s.macchine[0].contenitori, [{ nome: 'dev', memMb: 4957, cpuPct: 301 }])
  assert.equal(s.ultime['mac-spento'], ADESSO - 3 * GIORNO)
  assert.equal(s.ultime['MacBook-Pro-di-Tizio'], ADESSO - 5 * 60_000)
  assert.equal(s.conOom, 1)
  assert.equal(s.troncato, true)
  assert.ok(s.serie.macchine['mac-spento'])
})

test('storiaAvvii: host e container della stessa macchina sono una storia sola, dal piu recente, con un tetto', () => {
  const avvii = new Map([
    ['m1/host', [{ quando: 1, esito: 'ok' }, { quando: 5, esito: 'ko' }]],
    ['m1/container', [{ quando: 3, esito: 'ok' }]],
    ['m2/host', Array.from({ length: 20 }, (_, i) => ({ quando: i }))],
  ])
  const s = storiaAvvii(avvii)
  assert.deepEqual(s.m1.map((a) => a.quando), [5, 3, 1])
  assert.equal(s.m2.length, 12)
  assert.equal(s.m2[0].quando, 19)
})

// ── La composizione ───────────────────────────────────────────────────────────────────────────────

const flottaDi = (eventi, heartbeat = {}, opts = {}) =>
  componiFlotta({ heartbeat, salute: settimanaDiSalute(eventi, { adesso: ADESSO }) }, { adesso: ADESSO, ...opts })

test('componiFlotta: la riga vera e una card urgente, con l OOM prima, poi l app pesante e il motore', () => {
  const f = flottaDi(EVENTI)
  assert.equal(f.totale, 1)
  assert.equal(f.daSistemare, 1)
  const [m] = f.macchine
  assert.equal(m.livello, 'crit')
  assert.deepEqual(m.problemi.map((p) => `${p.livello}:${p.tipo}`), ['crit:oom', 'warn:app-pesante', 'info:motore-non-supportato'])
  assert.deepEqual(m.problemi[0].uccisi, ['dev'])
  assert.equal(m.problemi[0].quante, 3)
  assert.deepEqual([m.problemi[1].app, m.problemi[1].gb, m.problemi[1].sogliaGb], ['backend', 3.7, 3])
  // Senza un obiettivo della VM, l'azione per l'OOM parte dall'app che pesa di piu'.
  assert.deepEqual(m.problemi[0].azione, { k: 'riavviaApp', app: 'backend', gb: 3.7, comando: null })
  assert.deepEqual([m.vm.gb, m.vm.obiettivoGb, m.vm.ramMacGb, m.vm.disponibileGb], [11.7, null, 24, 4.3])
  assert.equal(m.motore, null)
  assert.equal(m.motoreIncerto, true)
  assert.equal(m.swapGb, 12.5)
  assert.equal(m.utente, 'RossiTizio')
  assert.ok(m.serie)
})

test('componiFlotta: con l obiettivo e colima, l azione dell OOM e la memoria della VM, col comando', () => {
  const eventi = EVENTI.map((e) => {
    const r = JSON.parse(e.message)
    r.salute.docker = { ...r.salute.docker, motore: 'colima', vm_mem_impostata_gb: 12, vm_mem_obiettivo_gb: 14 }
    return ev(e.timestamp, r)
  })
  const [m] = flottaDi(eventi).macchine
  assert.deepEqual(m.problemi.map((p) => p.tipo), ['oom', 'vm-sotto-obiettivo', 'app-pesante', 'motore-non-supportato'])
  assert.deepEqual(m.problemi[0].azione, { k: 'memoriaVm', gb: 14, motore: 'colima', comando: 'colima stop && colima start --memory 14' })
  assert.equal(m.problemi[1].azione.comando, 'colima stop && colima start --memory 14')
  // Docker Desktop non ha un comando: l'azione resta una frase.
  assert.equal(comandoMemoria('docker-desktop', 14), null)
  assert.equal(comandoMemoria('orbstack', 14), 'orb config set memory_mib 14336')
  assert.equal(comandoMemoria('colima', null), null)
})

test('componiFlotta: un Mac col dev-env vecchio non manda la salute, e non e ne sano ne malato per finta', () => {
  const f = componiFlotta(
    { heartbeat: { macchine: [{ macchina: 'mac-vecchio', lato: 'host', utente: 'a', esito: 'ok', toolMancanti: 0, quando: ADESSO - ORA }] }, salute: settimanaDiSalute([], { adesso: ADESSO }) },
    { adesso: ADESSO },
  )
  const [m] = f.macchine
  assert.equal(m.livello, 'ok')
  assert.equal(m.saluteAssente, true)
  assert.equal(m.oom, null)
  assert.deepEqual(m.vm, { gb: null, impostataGb: null, obiettivoGb: null, ramMacGb: null, disponibileGb: null, cpu: null })
  assert.equal(m.serie, null)
  assert.equal(f.daSistemare, 0)
})

const DIGEST = { nuovo: 'sha256:45486f792f3f0f2a7d8ad363b7b72528', vecchio: 'sha256:36b245a818c0f6b370feb916fca1374e' }
const host = (macchina, dentro = {}) => ({ macchina, lato: 'host', utente: macchina, esito: 'ok', toolMancanti: 0, quando: ADESSO - ORA, ...dentro })

test('componiFlotta: immagine indietro per DATA oltre la soglia della config, e per VERSIONE solo se la config la attende', () => {
  const iso = (g) => new Date(ADESSO - g * GIORNO).toISOString()
  const macchine = [
    host('nuovo', { immagine: DIGEST.nuovo, creata: iso(1) }),
    host('vecchio', { immagine: DIGEST.vecchio, creata: iso(12) }),
    host('quasi', { immagine: DIGEST.vecchio, creata: iso(5) }),
  ]
  const f = componiFlotta({ heartbeat: { macchine } }, { adesso: ADESSO })
  const tipi = (n) => f.macchine.find((m) => m.macchina === n).problemi.map((p) => p.tipo)
  assert.deepEqual(tipi('vecchio'), ['immagine-indietro'])
  assert.equal(f.macchine.find((m) => m.macchina === 'vecchio').problemi[0].giorni, 11)
  assert.deepEqual(tipi('quasi'), [])
  // La soglia arriva dalla config.
  const stretta = componiFlotta({ heartbeat: { macchine } }, { adesso: ADESSO, soglie: { giorniIndietro: 3 } })
  assert.deepEqual(stretta.macchine.find((m) => m.macchina === 'quasi').problemi.map((p) => p.tipo), ['immagine-indietro'])
  // Senza date e senza versione attesa, un digest diverso NON e' un'accusa (31/08/2026).
  const senzaDate = [host('a', { immagine: DIGEST.nuovo, quando: ADESSO }), host('b', { immagine: DIGEST.vecchio })]
  assert.equal(componiFlotta({ heartbeat: { macchine: senzaDate } }, { adesso: ADESSO }).daSistemare, 0)
  // Con la versione attesa in config si', e la notizia «non ce l'ha nessuno» e' di flotta.
  const conAttesa = componiFlotta({ heartbeat: { macchine: senzaDate, attesa: DIGEST.nuovo } }, { adesso: ADESSO })
  assert.deepEqual(conAttesa.macchine.find((m) => m.macchina === 'b').problemi.map((p) => p.tipo), ['immagine-indietro'])
  assert.equal(conAttesa.tuttiIndietro, false)
  assert.equal(componiFlotta({ heartbeat: { macchine: senzaDate, attesa: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaa' } }, { adesso: ADESSO }).tuttiIndietro, true)
})

test('componiFlotta: tool mancanti e avvio storto, e un dev-env fermo non si ridice come avvio storto', () => {
  const macchine = [
    host('tool', { toolMancanti: 2, toolMancantiNomi: ['jq', 'gh'] }),
    host('storto', { esito: 'parziale' }),
    host('fermo', { esito: 'ko' }),
  ]
  const bloccate = [{ macchina: 'fermo', lato: 'host', classe: 'porta-occupata', dettaglio: 'porta 5432 in uso', quando: ADESSO - ORA }]
  const f = componiFlotta({ heartbeat: { macchine, bloccate } }, { adesso: ADESSO, comandi: { aggiorna: './dev update', doctor: './dev doctor' } })
  const di = (n) => f.macchine.find((m) => m.macchina === n)
  assert.deepEqual(di('tool').problemi.map((p) => [p.tipo, p.nomi]), [['tool-mancanti', ['jq', 'gh']]])
  assert.equal(di('tool').problemi[0].azione.comando, './dev update')
  assert.deepEqual(di('storto').problemi.map((p) => [p.tipo, p.esito]), [['avvio-storto', 'parziale']])
  assert.deepEqual(di('fermo').problemi.map((p) => `${p.livello}:${p.tipo}`), ['crit:dev-fermo'])
  assert.equal(di('fermo').problemi[0].azione.comando, './dev doctor')
  // Il fermo e' urgente, quindi in cima.
  assert.equal(f.macchine[0].macchina, 'fermo')
})

test('componiFlotta: le note (motore, opt-out) non fanno contare un Mac fra quelli da sistemare', () => {
  const r = conSalute({
    vm: { oom_kill: 0, mem_disponibile_gb: 5 },
    app_mb: { backend: 900 },
    docker: { motore: 'colima', vm_mem_gb: 8 },
    uso: { opt_out: ['X_NO_MIGRATE'] },
  })
  const f = flottaDi([ev(ADESSO - 10 * 60_000, r)])
  assert.equal(f.macchine[0].livello, 'info')
  assert.equal(f.daSistemare, 0)
  assert.deepEqual(f.macchine[0].problemi.map((p) => p.tipo), ['motore-non-supportato', 'opt-out-attivi'])
})

test('componiFlotta: i segnali del canale diventano problemi della card, con le stesse soglie', () => {
  const r = conSalute({
    vm: { oom_kill: 0, mem_disponibile_gb: 5 },
    app_mb: { backend: 900 },
    docker: { motore: 'docker-desktop', vm_mem_gb: 8 },
    uso: { doctor: { quando: new Date(ADESSO - ORA).toISOString(), ok: 20, ko: 2, falliti: ['porte', 'login'] }, bloccati_mac: 12, sul_mac: 1 },
    container: { non_sani: ['db: unhealthy'] },
  })
  const f = flottaDi([ev(ADESSO - 40 * 60_000, r), ev(ADESSO - 20 * 60_000, r)])
  const [m] = f.macchine
  assert.deepEqual(m.problemi.map((p) => p.tipo), ['container', 'doctor-ko', 'lavoro-sul-mac'])
  assert.deepEqual(m.problemi[1].falliti, ['porte', 'login'])
  assert.equal(m.problemi[2].quante, 26)
  // Un nome di container con spazi o due punti non finisce in un comando.
  assert.equal(m.problemi[0].azione.comando, null)
  assert.equal(azioneDi({ tipo: 'container', nomi: ['db', 'kong'] }).comando, 'docker restart db kong')
  // Con una soglia piu' alta, i comandi sul Mac tornano sotto.
  const alta = componiFlotta({ heartbeat: {}, salute: settimanaDiSalute([ev(ADESSO - 40 * 60_000, r), ev(ADESSO - 20 * 60_000, r)], { adesso: ADESSO }) }, { adesso: ADESSO, soglie: { comandiSulMac: 50 } })
  assert.equal(alta.macchine[0].problemi.some((p) => p.tipo === 'lavoro-sul-mac'), false)
})

test('componiFlotta: un errore di lettura si dice, e non diventa una flotta vuota «in ordine» senza parole', () => {
  const f = componiFlotta({ heartbeat: { errore: 'AccessDenied' }, salute: { errore: 'timeout' } }, { adesso: ADESSO })
  assert.deepEqual(f.errori, ['AccessDenied', 'timeout'])
  assert.equal(f.totale, 0)
  assert.equal(componiFlotta({ heartbeat: {}, salute: null }).saluteConfigurata, false)
})

test('soglie: appPesanteMb ha un default di 3 GB e si cambia dalla config', () => {
  assert.equal(SOGLIE_DEV_ENV.appPesanteMb, 3072)
  assert.equal(soglieDevEnv({}).appPesanteMb, 3072)
  assert.equal(soglieDevEnv({ soglieDevEnv: { appPesanteMb: '4096' } }).appPesanteMb, 4096)
  assert.equal(soglieDevEnv({ soglieDevEnv: { appPesanteMb: 'tanto' } }).appPesanteMb, 3072)
  const alta = flottaDi(EVENTI, {}, { soglie: { appPesanteMb: 4096 } })
  assert.equal(alta.macchine[0].problemi.some((p) => p.tipo === 'app-pesante'), false)
})

test('comandiDevEnv: solo stringhe non vuote, e senza config nessun comando inventato', () => {
  assert.deepEqual(comandiDevEnv({}), { aggiorna: null, doctor: null, salute: null, dentro: null })
  assert.deepEqual(comandiDevEnv({ devEnvComandi: { aggiorna: ' ./x update ', doctor: '', salute: 3 } }), { aggiorna: './x update', doctor: null, salute: null, dentro: null })
})

// ── Le frasi ──────────────────────────────────────────────────────────────────────────────────────

test('frasi: ogni tipo di problema e ogni azione del server ha la sua frase in IT e EN', () => {
  assert.deepEqual([...TIPI_PROBLEMA].sort(), Object.keys(LIVELLO).sort())
  const src = readFileSync(new URL('../server/flotta.js', import.meta.url), 'utf8')
  const azioni = new Set([...src.matchAll(/k: '([A-Za-z]+)'/g)].map((m) => m[1]))
  assert.deepEqual([...azioni].filter((k) => !TIPI_AZIONE.includes(k)), [])
  for (const lang of ['it', 'en']) {
    const t = makeT(lang)
    for (const tipo of TIPI_PROBLEMA) assert.notEqual(t(`flotta.p.${tipo}`), `flotta.p.${tipo}`, `${lang}: flotta.p.${tipo}`)
    for (const k of TIPI_AZIONE) assert.notEqual(t(`flotta.a.${k}`), `flotta.a.${k}`, `${lang}: flotta.a.${k}`)
  }
})

test('frasi: la card della riga vera si legge, in italiano e in inglese, senza trattino lungo', () => {
  const [m] = flottaDi(EVENTI).macchine
  const it = makeT('it')
  const en = makeT('en')
  assert.equal(fraseProblema(m.problemi[0], it, 'it'), '3 processi uccisi per memoria nelle ultime 24 ore: colpito dev')
  assert.equal(fraseProblema(m.problemi[0], en, 'en'), '3 processes killed for memory in the last 24 hours: hit dev')
  assert.equal(fraseProblema(m.problemi[1], it, 'it'), 'backend tiene 3,7 GB, sopra la soglia di 3 GB')
  assert.equal(fraseProblema(m.problemi[2], it, 'it'), 'Motore di Docker non supportato: colima o OrbStack')
  assert.equal(fraseAzione(m.problemi[0].azione, it, 'it'), 'Riavvia backend, che tiene 3,7 GB: è la memoria che torna per prima.')
  assert.equal(fraseAzione({ k: 'memoriaVm', gb: 14, motore: 'docker-desktop' }, en, 'en'), 'Give the VM 14 GB in Docker Desktop: Settings, Resources, Memory.')
  assert.equal(fraseProblema({ tipo: 'immagine-indietro', giorni: 1 }, it), 'Immagine indietro di 1 giorno')
  assert.equal(fraseProblema({ tipo: 'immagine-indietro', giorni: null }, it), 'Immagine diversa da quella attesa')
  for (const p of m.problemi) assert.equal(fraseProblema(p, it, 'it').includes(String.fromCharCode(0x2014)), false)
})

test('valoreSerie: ultimo, minimo, massimo e totale, ignorando le ore senza righe', () => {
  assert.deepEqual(valoreSerie([null, 3, 1, null, 2], 'min'), { punti: 3, ultimo: 2, min: 1, max: 3, totale: null })
  assert.deepEqual(valoreSerie([0, 3, null, 1], 'somma').totale, 4)
  assert.deepEqual(valoreSerie([null, null]), { punti: 0, ultimo: null, min: null, max: null, totale: 0 })
})

test('storiaImmagini: una voce per immagine, con la data di costruzione e da quando e in uso', () => {
  const s = storiaImmagini([
    { quando: 50, immagine: 'B', creata: null },
    { quando: 40, immagine: 'B', creata: '2026-10-05' },
    { quando: 30, immagine: 'A', creata: '2026-09-20' },
    { quando: 20, immagine: 'A' },
    { quando: 10 },
  ])
  assert.deepEqual(s, [
    { immagine: 'B', creata: '2026-10-05', dal: 40 },
    { immagine: 'A', creata: '2026-09-20', dal: 20 },
  ])
})

// ── I link del canale ─────────────────────────────────────────────────────────────────────────────

test('linkPagina: gli avvisi sul dev-env aprono il Mac nella Flotta, gli accessi la loro voce', () => {
  const u = 'https://dg'
  assert.equal(linkPagina({ tipo: 'scrittura', bersaglio: 'postgres' }, u), '<https://dg/accessi#scritture|Accessi>')
  assert.equal(linkPagina({ tipo: 'ssh', bersaglio: 'mac-di-x' }, u), '<https://dg/accessi#ssh|Accessi>')
  assert.equal(linkPagina({ tipo: 'oom', bersaglio: 'Mac di x' }, u), '<https://dg/flotta?mac=Mac%20di%20x|Flotta>')
  assert.equal(linkPagina({ tipo: 'guasto', bersaglio: 'dev-env', macchina: 'm1' }, u), '<https://dg/flotta?mac=m1|Flotta>')
  assert.equal(linkPagina({ tipo: 'versione', bersaglio: 'dev-env' }, u), '<https://dg/flotta|Flotta>')
})

// ── La demo ───────────────────────────────────────────────────────────────────────────────────────

test('demo: la flotta passa dalle funzioni vere e mostra un caso per Mac', () => {
  const f = demoFlotta(ADESSO)
  assert.equal(f.totale, 7)
  assert.equal(f.daSistemare, 4)
  const di = (n) => f.macchine.find((m) => m.macchina === n)
  const kim = di('kim-macbook')
  assert.equal(f.macchine[0], kim)
  assert.equal(kim.livello, 'crit')
  assert.equal(kim.oom.nuovi, 3)
  assert.equal(kim.vm.gb, 11.7)
  assert.equal(kim.vm.obiettivoGb, 14)
  assert.deepEqual(kim.app[0], { nome: 'backend', gb: 3.7 })
  assert.equal(di('sam-macbook').problemi.find((p) => p.tipo === 'immagine-indietro').giorni, 11)
  assert.ok(di('sam-macbook').problemi.some((p) => p.tipo === 'tool-mancanti'))
  assert.deepEqual(di('noa-macbook').problemi.map((p) => p.tipo).sort(), ['avvio-storto', 'doctor-ko', 'opt-out-attivi'])
  assert.deepEqual(di('rin-macbook').problemi.map((p) => p.tipo), ['lavoro-sul-mac'])
  for (const n of ['alex-macbook', 'lee-macbook', 'eli-macbook']) assert.equal(di(n).livello, 'ok', n)
  // Sette giorni di andamento: le curve hanno qualcosa da disegnare.
  assert.ok(kim.serie.mem.filter((v) => v != null).length > 150)
})

// ── Il cruscotto: i conti sulla flotta e la matrice ───────────────────────────────────────────────

// Due Mac per 48 ore: «a» sempre acceso, «b» spento il primo giorno. Gli OOM di «a» nascono nell'ora
// 30; il contatore di «b» non arriva mai.
const serieFinta = () => {
  const punti = 48
  const vuota = () => Array(punti).fill(null)
  const a = { mem: vuota().map((_, i) => 5 - (i >= 30 ? 4 : 0)), oom: vuota().map((_, i) => (i === 30 ? 2 : 0)), swap: vuota(), cpu: vuota() }
  const b = { mem: vuota().map((_, i) => (i >= 24 ? 3 : null)), oom: vuota(), swap: vuota(), cpu: vuota() }
  return { inizio: ADESSO - 47 * ORA, passoMs: ORA, punti, macchine: { a, b } }
}

test('andamentoFlotta: per ora il minimo (e di chi), la mediana, gli OOM e i Mac accesi; un ora vuota non e zero', () => {
  const a = andamentoFlotta({ serie: serieFinta() })
  assert.equal(a.punti, 48)
  // Il primo giorno «b» e' spento: la mediana e' quella di «a» da solo, e i Mac accesi sono uno.
  assert.equal(a.memMediana[0], 5)
  assert.equal(a.attivi[0], 1)
  assert.equal(a.memMin[40], 1)
  assert.equal(a.memMinChi[40], 'a')
  assert.equal(a.memMediana[40], 2)
  assert.equal(a.oom[30], 2)
  // Nessun Mac manda il contatore: «non lo so», non «nessun OOM».
  const solo = andamentoFlotta({ serie: { ...serieFinta(), macchine: { b: serieFinta().macchine.b } } })
  assert.equal(solo.oom[30], null)
  assert.equal(solo.memMin[0], null)
  assert.equal(solo.attivi[0], 0)
  assert.equal(andamentoFlotta({ serie: null }), null)
})

test('andamentoFlotta: i giorni sono blocchi di 24 ore che finiscono adesso, con l OOM e i Mac accesi', () => {
  const { giorni } = andamentoFlotta({ serie: serieFinta() })
  assert.equal(giorni.punti, 2)
  assert.equal(giorni.passoMs, GIORNO)
  assert.deepEqual(giorni.attivi, [1, 2])
  assert.deepEqual(giorni.oom, [0, 2])
  assert.deepEqual(giorni.conOom, [0, 1])
  assert.deepEqual(giorni.memMin, [5, 1])
  // Senza avvii l'immagine non si sa: null, non zero per cento.
  assert.deepEqual(giorni.inPari, [null, null])
})

test('immagineInPari: rigioca gli avvii con la data piu recente vista FINO A quel momento, per lato', () => {
  const d = (g) => new Date(ADESSO - g * GIORNO).toISOString()
  const avvii = [
    { macchina: 'x', lato: 'host', quando: ADESSO - 5 * GIORNO, creata: d(20) },
    { macchina: 'y', lato: 'host', quando: ADESSO - 5 * GIORNO, creata: d(19) },
    // Il giorno dopo esce un'immagine nuova, e «y» la prende: «x» resta dietro di 18 giorni.
    { macchina: 'y', lato: 'host', quando: ADESSO - 2 * GIORNO, creata: d(2) },
    // Il container di «z» non dice la data: «z» non si conta.
    { macchina: 'z', lato: 'container', quando: ADESSO - 2 * GIORNO, creata: null },
  ]
  assert.deepEqual(immagineInPari(avvii, ADESSO - 4 * GIORNO), { inPari: 2, conImmagine: 2 })
  assert.deepEqual(immagineInPari(avvii, ADESSO), { inPari: 1, conImmagine: 2 })
  assert.deepEqual(immagineInPari([], ADESSO), { inPari: 0, conImmagine: 0 })
})

test('riepilogoFlotta: i numeri in cima sono gli stessi della matrice, e un dato che manca e null', () => {
  const f = demoFlotta(ADESSO)
  const r = f.riepilogo
  assert.equal(r.oom24h, 3)
  assert.equal(r.conOom24h, 1)
  assert.equal(r.urgenti, 1)
  assert.equal(r.memMinima.macchina, 'kim-macbook')
  assert.equal(r.memMinima.bassa, r.memMinima.gb < MEM_LIBERA_BASSA_GB)
  assert.equal(r.inPari, r.conImmagine - 1)
  // L'ultimo giorno dell'andamento e' la tessera: la stessa regola, lo stesso numero.
  assert.equal(f.andamento.giorni.inPari.at(-1), r.inPari)
  assert.equal(f.andamento.giorni.conImmagine.at(-1), r.conImmagine)
  const vuoto = riepilogoFlotta([{ macchina: 'm', oom: null, problemi: [], immagine: {}, livello: 'ok' }], null, { adesso: ADESSO })
  assert.equal(vuoto.oom24h, null)
  assert.equal(vuoto.memMinima, null)
})

test('matrice: ogni tipo di problema ha la sua colonna, e ogni colonna esiste', () => {
  assert.deepEqual(Object.keys(COLONNA_DEL_PROBLEMA).sort(), Object.keys(LIVELLO).sort())
  for (const c of Object.values(COLONNA_DEL_PROBLEMA)) assert.ok(COLONNE.includes(c), c)
})

test('matrice: le celle di kim dicono il problema col livello, quelle di un Mac senza salute sono «non lo so»', () => {
  const f = demoFlotta(ADESSO)
  const it = makeT('it')
  const di = (n) => Object.fromEntries(celleMac(f.macchine.find((m) => m.macchina === n), it, 'it', ADESSO).map((c) => [c.k, c]))
  const kim = di('kim-macbook')
  assert.deepEqual(COLONNE, Object.keys(kim))
  assert.equal(kim.oom.livello, 'crit')
  assert.equal(kim.oom.valore, '3')
  assert.equal(kim.vm.livello, 'warn')
  assert.equal(kim.vm.valore, '12/14')
  assert.ok(kim.vm.barra > 80 && kim.vm.barra < 100)
  assert.equal(kim.motore.livello, 'info')
  assert.equal(kim.app.valore, 'backend 3,7 GB')
  assert.match(kim.oom.titolo, /processi uccisi/)
  // lee ha chiuso il Mac ieri: niente salute nelle 24 ore, quindi trattini e non zeri.
  const lee = di('lee-macbook')
  for (const k of ['vm', 'oom', 'doctor', 'sulMac', 'app']) assert.equal(lee[k].livello, null, k)
  assert.equal(lee.oom.valore, null)
  // Un Mac in ordine all'obiettivo non ha la barra della VM: sei barre piene non dicono niente.
  assert.equal(di('alex-macbook').vm.barra, null)
  assert.equal(di('alex-macbook').vm.livello, 'ok')
})

test('azioniFlotta: una voce per azione, coi Mac che la chiedono, nell ordine del piu grave', () => {
  const a = azioniFlotta(demoFlotta(ADESSO).macchine)
  assert.deepEqual(a.map((x) => x.k), ['memoriaVm', 'doctor', 'aggiorna', 'dentroContainer'])
  assert.deepEqual(a[0].macchine, ['kim-macbook'])
  assert.equal(a[0].livello, 'crit')
  const it = makeT('it')
  for (const x of a) assert.notEqual(it(`flotta.az.${x.k}`), `flotta.az.${x.k}`)
  for (const k of TIPI_AZIONE) assert.notEqual(makeT('en')(`flotta.az.${k}`), `flotta.az.${k}`, k)
})
