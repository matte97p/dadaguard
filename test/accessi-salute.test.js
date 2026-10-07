import { test } from 'node:test'
import assert from 'node:assert/strict'
import { riassumiSalute } from '../server/teleport.js'
import { segnali, configSalute } from '../server/accessi.js'
import { messaggioAccessi } from '../server/notify/slack.js'
import { appPiuPesanti } from '../shared/devEnv.js'

// La SALUTE delle macchine del dev-env: una riga ogni 15 minuti con memoria e OOM della VM di Docker e
// container non sani. Le prove difendono le due domande che contano, e i due modi muti di sbagliarle:
// `oom_kill` e' un contatore dal boot della VM (leggerne il valore invece della salita direbbe «OOM» a
// ogni giro per sempre), e un container non sano per un giro solo e' un riavvio in corso, non un guasto.

const riga = (quando, macchina, salute, utente = 'gio') => ({ timestamp: quando, message: JSON.stringify({ macchina, utente, salute }) })
const s = (oom, nonSani = [], extra = {}) => ({ vm: { oom_kill: oom }, container: { non_sani: nonSani }, ...extra })

test('riassumiSalute: conta quanto SALE oom_kill, non il suo valore', () => {
  const [m] = riassumiSalute([riga(1, 'mac', s(3)), riga(2, 'mac', s(3)), riga(3, 'mac', s(5))])
  assert.equal(m.oomTotale, 5)
  assert.equal(m.oomNuovi, 2)
  assert.equal(m.oomQuando, 3)
})

test('riassumiSalute: se il contatore scende la VM e ripartita, e si riparte da lui', () => {
  const [m] = riassumiSalute([riga(1, 'mac', s(7)), riga(2, 'mac', s(1)), riga(3, 'mac', s(2))])
  assert.equal(m.oomNuovi, 2)
})

test('riassumiSalute: fermo da sempre = nessun OOM nuovo', () => {
  const [m] = riassumiSalute([riga(1, 'mac', s(4)), riga(2, 'mac', s(4))])
  assert.equal(m.oomNuovi, 0)
  assert.equal(m.oomQuando, null)
})

test('riassumiSalute: i container non sani contano i giri DI FILA dall ultima riga', () => {
  const [m] = riassumiSalute([
    riga(1, 'mac', s(0, ['kong: unhealthy'])),
    riga(2, 'mac', s(0, [])),
    riga(3, 'mac', s(0, ['kong: unhealthy'])),
    riga(4, 'mac', s(0, ['kong: unhealthy', 'db: exited (1)'])),
  ])
  assert.equal(m.nonSaniGiri, 2)
  assert.equal(m.nonSaniDa, 3)
  assert.deepEqual(m.nonSani, ['kong: unhealthy', 'db: exited (1)'])
})

test('riassumiSalute: una macchina per riga, dalla piu recente, e le righe senza salute non contano', () => {
  const out = riassumiSalute([
    riga(1, 'a', s(0)),
    riga(5, 'b', s(0, [], { docker: { vm_mem_gb: 13.6 }, mac: { ram_gb: 24, swap_usata_mb: 32000 }, app_mb: { backend: 1300 } })),
    { timestamp: 9, message: JSON.stringify({ macchina: 'c', esito: 'ok' }) },
    { timestamp: 9, message: 'non json' },
  ])
  assert.deepEqual(out.map((m) => m.macchina), ['b', 'a'])
  assert.equal(out[0].vmMemGb, 13.6)
  assert.equal(out[0].ramMacGb, 24)
  assert.equal(out[0].swapMacMb, 32000)
  assert.deepEqual(out[0].appMb, { backend: 1300 })
})

test('configSalute: esplicita vince, altrimenti si ricava dal heartbeat, altrimenti niente', () => {
  assert.deepEqual(configSalute({ salute: { account: 'x', logGroup: '/a/salute' } }), { account: 'x', logGroup: '/a/salute' })
  assert.deepEqual(configSalute({ heartbeat: { account: 'm', logGroup: '/org/dev-env/heartbeat' } }), { account: 'm', logGroup: '/org/dev-env/salute' })
  // Un heartbeat con un nome diverso non si indovina: meglio nessuna sezione che un log group inventato.
  assert.equal(configSalute({ heartbeat: { account: 'm', logGroup: '/org/battiti' } }), null)
  assert.equal(configSalute({}), null)
})

const base = (salute) => ({ configurato: true, audit: {}, heartbeat: {}, salute })
const mac = (dentro) => ({ macchina: 'mac-di-gio', utente: 'gio', quando: 10, oomNuovi: 0, nonSani: [], nonSaniGiri: 0, ...dentro })

test('segnali: la VM che ha finito la memoria parla, con quanti e quando', () => {
  const out = segnali(base({ macchine: [mac({ oomNuovi: 3, oomQuando: 9, vmMemGb: 7.7, ramMacGb: 24, uccisiPerMemoria: ['realtime'] })] }))
  const oom = out.filter((x) => x.tipo === 'oom')
  assert.equal(oom.length, 1)
  assert.equal(oom[0].chiave, 'oom:mac-di-gio')
  assert.equal(oom[0].quante, 3)
  assert.equal(oom[0].quando, 9)
  assert.deepEqual(oom[0].chi, ['gio'])
})

test('segnali: nessun OOM nuovo, nessuna riga', () => {
  assert.deepEqual(segnali(base({ macchine: [mac({ oomNuovi: 0 })] })).filter((x) => x.tipo === 'oom'), [])
})

test('segnali: un container non sano per UN giro e un riavvio, per due di fila e una riga', () => {
  const uno = segnali(base({ macchine: [mac({ nonSani: ['kong: unhealthy'], nonSaniGiri: 1, nonSaniDa: 10 })] }))
  assert.deepEqual(uno.filter((x) => x.tipo === 'container'), [])
  const due = segnali(base({ macchine: [mac({ nonSani: ['kong: unhealthy'], nonSaniGiri: 2, nonSaniDa: 8 })] }))
  const c = due.filter((x) => x.tipo === 'container')
  assert.equal(c.length, 1)
  assert.equal(c[0].chiave, 'container:mac-di-gio')
  // L'inizio della serie, non l'ultima riga: la stessa serie si dice una volta sola.
  assert.equal(c[0].quando, 8)
  assert.equal(c[0].dettaglio, 'kong: unhealthy')
})

test('segnali: senza salute (config assente o errore) non si inventa niente', () => {
  assert.deepEqual(segnali(base(null)).filter((x) => x.tipo === 'oom' || x.tipo === 'container'), [])
  assert.deepEqual(segnali(base({ errore: 'AccessDenied' })).filter((x) => x.tipo === 'oom' || x.tipo === 'container'), [])
})

test('messaggio: memoria finita dice quanti processi, la VM e chi e stato ucciso', () => {
  const m = messaggioAccessi(
    { tipo: 'oom', livello: 'attenzione', bersaglio: 'mac-di-gio', chi: ['gio'], quante: 3, vmMemGb: 7.7, ramMacGb: 24, uccisi: ['realtime'] },
    { publicUrl: 'https://dg' },
  )
  assert.match(m, /MEMORIA FINITA NEL DEV-ENV/)
  assert.match(m, /3 processi/)
  assert.match(m, /VM da 7\.7 GB su 24 del Mac/)
  assert.match(m, /realtime/)
  assert.equal(m.includes('\n'), false)
})

test('messaggio: container non sani dice quali e da quanti controlli', () => {
  const m = messaggioAccessi(
    { tipo: 'container', livello: 'attenzione', bersaglio: 'mac-di-gio', chi: ['gio'], dettaglio: 'kong: unhealthy', giri: 3 },
    { publicUrl: 'https://dg' },
  )
  assert.match(m, /CONTAINER DEL DEV-ENV NON SANI/)
  assert.match(m, /kong: unhealthy/)
  assert.match(m, /3 controlli di fila/)
})

test('pagina: le app piu pesanti in GB, senza «altro»', () => {
  assert.deepEqual(appPiuPesanti({ altro: 5000, backend: 1327, chat: 253, autopilot: 419 }), [
    { nome: 'backend', gb: 1.3 },
    { nome: 'autopilot', gb: 0.4 },
  ])
  assert.deepEqual(appPiuPesanti({}), [])
})
