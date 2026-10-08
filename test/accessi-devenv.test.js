import { test } from 'node:test'
import assert from 'node:assert/strict'
import { riassumiSalute, motoreDocker, leggiUltime } from '../server/teleport.js'
import { segnali, daAnnunciare, soglieDevEnv, inizioPeriodo, SOGLIE_DEV_ENV, GIORNO_MS, ORA_MS, SETTIMANA_MS } from '../server/accessi.js'
import { messaggioAccessi } from '../server/notify/slack.js'
import { usoDellaMacchina } from '../shared/devEnv.js'

// Gli avvisi sul dev-env del 07/10/2026: immagine vecchia, agent della salute muto, motore di Docker
// non ammesso, VM sotto l'obiettivo, opt-out accesi, comandi dei repo sul Mac, doctor con dei KO. Le
// prove difendono le tre cose che li rendono leggibili: un campo che manca non e' zero, un avviso a
// cadenza non torna a ogni giro (ne' dopo un rilascio, ne' dopo un giro senza dati), e l'agent muto
// non si confonde con un Mac chiuso.

// Mercoledi' 07/10/2026 alle 15 UTC: la settimana degli avvisi e' partita lunedi' 05/10 alle 07 UTC.
const ADESSO = Date.UTC(2026, 9, 7, 15)
const LUNEDI = Date.UTC(2026, 9, 5, 7)

// La riga vera di un Mac con colima e tre OOM, con persona e macchina cambiate (il repo e' pubblico):
// niente `motore`, niente obiettivo, niente `uso`. E' la forma di tutte le macchine prima dell'update.
const RIGA_COLIMA = {
  utente: 'RossiTizio',
  macchina: 'MacBook-Pro-di-Tizio',
  lato: 'host',
  creata: '2026-10-07T11:54:30.305Z',
  salute: {
    mac: { ram_gb: 24.0 },
    docker: { desktop: 'Docker Engine - Community', vm_mem_gb: 11.7, vm_cpu: 4 },
    vm: { oom_kill: 3 },
    container: { uccisi_per_memoria: ['dev'] },
  },
}
const ev = (timestamp, riga) => ({ timestamp, message: JSON.stringify(riga) })
const conSalute = (salute, dentro = {}) => ({ ...RIGA_COLIMA, ...dentro, salute: { ...RIGA_COLIMA.salute, ...salute } })

const base = (dentro = {}) => ({ configurato: true, audit: {}, heartbeat: {}, salute: null, ...dentro })
const mac = (dentro = {}) => ({
  macchina: 'mac-di-tizio',
  utente: 'tizio',
  quando: ADESSO - 10 * 60_000,
  oomNuovi: 0,
  nonSani: [],
  nonSaniGiri: 0,
  motore: null,
  motoreCandidati: [],
  ...dentro,
})
const di = (tipo, out) => out.filter((s) => s.tipo === tipo)

// ── Lettura della riga ─────────────────────────────────────────────────────────────────────────────

test('riassumiSalute: la riga di colima senza i campi nuovi dice «non lo so», non zero', () => {
  const [m] = riassumiSalute([ev(ADESSO - 60_000, RIGA_COLIMA)])
  assert.equal(m.motore, null)
  assert.deepEqual(m.motoreCandidati, ['colima', 'orbstack'])
  assert.equal(m.vmMemGb, 11.7)
  assert.equal(m.vmMemObiettivoGb, null)
  assert.equal(m.vmMemImpostataGb, null)
  assert.equal(m.vmCpu, 4)
  assert.equal(m.optOut, null)
  assert.equal(m.doctor, null)
  assert.equal(m.comandiMac, null)
})

test('riassumiSalute: i campi nuovi si leggono, e i comandi sul Mac si sommano sulla finestra', () => {
  const uso = (b, f, extra = {}) => ({ uso: { bloccati_mac: b, sul_mac: f, ...extra } })
  const [m] = riassumiSalute([
    ev(1, conSalute(uso(3, 1))),
    ev(2, conSalute({ uso: {} })),
    ev(3, conSalute({
      docker: { motore: 'docker-desktop', vm_mem_obiettivo_gb: 14, vm_mem_impostata_gb: 14.0, vm_mem_gb: 13.6 },
      ...uso(5, 0, { opt_out: ['X_NO_MIGRATE'], doctor: { quando: '2026-10-07T10:00:00Z', ok: 20, warn: 2, ko: 1, falliti: ['docker'] } }),
    })),
  ])
  assert.equal(m.motore, 'docker-desktop')
  assert.equal(m.vmMemObiettivoGb, 14)
  assert.equal(m.vmMemImpostataGb, 14)
  assert.deepEqual(m.optOut, ['X_NO_MIGRATE'])
  assert.deepEqual(m.doctor, { quando: '2026-10-07T10:00:00Z', ok: 20, warn: 2, ko: 1, falliti: ['docker'] })
  assert.deepEqual(m.comandiMac, { bloccati: 8, forzati: 1 })
})

test('motoreDocker: dichiarato vince, poi si deduce da desktop, altrimenti niente', () => {
  assert.deepEqual(motoreDocker({ motore: 'orbstack', desktop: 'Docker Engine - Community' }).motoreCandidati, ['orbstack'])
  assert.equal(motoreDocker({ desktop: 'Docker Desktop 4.47.0 (206054)' }).motore, 'docker-desktop')
  assert.deepEqual(motoreDocker({ desktop: 'Docker Engine - Community' }), { motore: null, motoreCandidati: ['colima', 'orbstack'], desktop: 'Docker Engine - Community' })
  assert.deepEqual(motoreDocker({}).motoreCandidati, [])
  assert.deepEqual(motoreDocker(undefined).motoreCandidati, [])
})

test('leggiUltime: il massimo di Insights in millisecondi o come data UTC senza fuso', () => {
  const riga = (macchina, ultima) => [{ field: 'macchina', value: macchina }, { field: 'ultima', value: ultima }]
  assert.deepEqual(leggiUltime([riga('a', '1759830000000'), riga('b', '2026-10-07 10:00:00.000'), riga('c', 'boh'), [{ field: 'ultima', value: '1' }]]), {
    a: 1759830000000,
    b: Date.UTC(2026, 9, 7, 10),
  })
})

// ── Soglie e periodi ──────────────────────────────────────────────────────────────────────────────

test('soglieDevEnv: default, valori validi, e un valore che non e un numero tiene il default', () => {
  assert.deepEqual(soglieDevEnv({}), { ...SOGLIE_DEV_ENV, motoriAmmessi: ['docker-desktop'] })
  const s = soglieDevEnv({ soglieDevEnv: { giorniIndietro: 3, motoriAmmessi: ['Docker-Desktop', 'orbstack'], vmSottoGb: '1', comandiSulMac: 'tanti' } })
  assert.equal(s.giorniIndietro, 3)
  assert.deepEqual(s.motoriAmmessi, ['docker-desktop', 'orbstack'])
  assert.equal(s.vmSottoGb, 1)
  assert.equal(s.comandiSulMac, 10)
  // Una riga lasciata senza valore non spegne la soglia.
  assert.equal(soglieDevEnv({ soglieDevEnv: { giorniIndietro: null, motoriAmmessi: [] } }).giorniIndietro, 7)
  assert.deepEqual(soglieDevEnv({ soglieDevEnv: { motoriAmmessi: [] } }).motoriAmmessi, ['docker-desktop'])
})

test('inizioPeriodo: la settimana parte il lunedi alle 07 UTC, il giorno alle 07 UTC', () => {
  assert.equal(inizioPeriodo(ADESSO, SETTIMANA_MS), LUNEDI)
  assert.equal(inizioPeriodo(LUNEDI - 1, SETTIMANA_MS), LUNEDI - SETTIMANA_MS)
  assert.equal(inizioPeriodo(ADESSO, GIORNO_MS), Date.UTC(2026, 9, 7, 7))
  assert.equal(inizioPeriodo(Date.UTC(2026, 9, 7, 6), GIORNO_MS), Date.UTC(2026, 9, 6, 7))
})

// ── 1. immagine-vecchia ───────────────────────────────────────────────────────────────────────────

const hb = (macchina, creata, dentro = {}) => ({ macchina, lato: 'host', utente: 'tizio', utenti: ['tizio'], immagine: 'sha256:' + 'a'.repeat(64), creata, quando: ADESSO - ORA_MS, ...dentro })

test('immagine-vecchia: piu di N giorni dietro la piu nuova in giro parla, per macchina', () => {
  const macchine = [hb('nuovo', '2026-10-07T11:54:30Z'), hb('vecchio', '2026-09-28T11:00:00Z', { utenti: ['caio'] }), hb('pari', '2026-10-01T12:00:00Z')]
  const out = di('immagine-vecchia', segnali(base({ heartbeat: { macchine } }), { adesso: ADESSO }))
  assert.equal(out.length, 1)
  assert.equal(out[0].chiave, 'immagine-vecchia:vecchio')
  assert.equal(out[0].giorni, 9)
  assert.deepEqual(out[0].chi, ['caio'])
  assert.equal(out[0].quando, LUNEDI)
  assert.equal(out[0].calmaMs, SETTIMANA_MS)
})

test('immagine-vecchia: la soglia si cambia, e l host e il container della stessa macchina sono una riga', () => {
  const macchine = [
    hb('nuovo', '2026-10-07T11:54:30Z'),
    hb('pari', '2026-10-01T12:00:00Z'),
    hb('pari', '2026-10-01T12:00:00Z', { lato: 'container', quando: ADESSO - 2 * ORA_MS }),
  ]
  assert.deepEqual(di('immagine-vecchia', segnali(base({ heartbeat: { macchine } }), { adesso: ADESSO })), [])
  const tre = di('immagine-vecchia', segnali(base({ heartbeat: { macchine } }), { adesso: ADESSO, soglie: { giorniIndietro: 3 } }))
  assert.deepEqual(tre.map((s) => s.chiave), ['immagine-vecchia:pari'])
})

test('immagine-vecchia: senza creata non si accusa nessuno', () => {
  const macchine = [hb('nuovo', '2026-10-07T11:54:30Z'), hb('senza', null), hb('rotta', 'ieri')]
  assert.deepEqual(di('immagine-vecchia', segnali(base({ heartbeat: { macchine } }), { adesso: ADESSO })), [])
  assert.deepEqual(di('immagine-vecchia', segnali(base({ heartbeat: {} }), { adesso: ADESSO })), [])
})

// ── 2. salute-muta ────────────────────────────────────────────────────────────────────────────────

// Una macchina che ha parlato tre giorni fa e si e' avviata ieri, e un'altra che parla oggi.
const muta = ({ ultimaSalute = ADESSO - 3 * GIORNO_MS, avvio = ADESSO - GIORNO_MS, altre = true, ultime } = {}) =>
  base({
    heartbeat: { macchine: [hb('muta', null, { quando: avvio, utenti: ['tizio'] }), hb('sana', null, { utenti: ['caio'] })] },
    salute: {
      macchine: altre ? [mac({ macchina: 'sana', utente: 'caio' })] : [],
      ultime: ultime === undefined ? { muta: ultimaSalute, sana: ADESSO - 10 * 60_000 } : ultime,
    },
  })

test('salute-muta: avviata dopo l ultima riga, zitta da piu di un giorno, e le altre parlano', () => {
  const out = di('salute-muta', segnali(muta(), { adesso: ADESSO }))
  assert.equal(out.length, 1)
  assert.equal(out[0].chiave, 'salute-muta:muta')
  assert.equal(out[0].oreZitta, 72)
  assert.equal(out[0].oreDallAvvio, 24)
  assert.deepEqual(out[0].chi, ['tizio'])
  // Lo stesso silenzio si dice una volta: il `quando` e' l'ultima riga, non il giro.
  assert.equal(out[0].quando, ADESSO - 3 * GIORNO_MS)
})

test('salute-muta: un Mac chiuso dopo l ultima riga NON e un agent rotto', () => {
  // L'ultimo avvio e' PRIMA dell'ultima riga: niente prova che il Mac sia stato acceso dopo.
  assert.deepEqual(di('salute-muta', segnali(muta({ avvio: ADESSO - 4 * GIORNO_MS + ORA_MS, ultimaSalute: ADESSO - 2 * GIORNO_MS }), { adesso: ADESSO })), [])
  // Avvio piu' vecchio di tre giorni.
  assert.deepEqual(di('salute-muta', segnali(muta({ avvio: ADESSO - 4 * GIORNO_MS, ultimaSalute: ADESSO - 5 * GIORNO_MS }), { adesso: ADESSO })), [])
  // Avvio di dieci minuti fa: l'agent non ha ancora avuto il tempo di parlare.
  assert.deepEqual(di('salute-muta', segnali(muta({ avvio: ADESSO - 10 * 60_000 }), { adesso: ADESSO })), [])
  // Una riga nelle ultime 24 ore: un giro saltato non e' un guasto.
  assert.deepEqual(di('salute-muta', segnali(muta({ ultimaSalute: ADESSO - 20 * ORA_MS, avvio: ADESSO - 2 * ORA_MS }), { adesso: ADESSO })), [])
})

test('salute-muta: non si arma per chi non ha mai mandato una riga, ne quando tacciono tutti', () => {
  // Nessuna riga nei sette giorni: il dev-env con l'agent riparato non e' ancora arrivato li'.
  assert.deepEqual(di('salute-muta', segnali(muta({ ultime: { sana: ADESSO - 60_000 } }), { adesso: ADESSO })), [])
  // Tacciono tutti: e' il log group o la lettura, non l'agent di una persona.
  assert.deepEqual(di('salute-muta', segnali(muta({ altre: false }), { adesso: ADESSO })), [])
  // La lettura dei sette giorni non e' tornata: l'allarme resta spento.
  assert.deepEqual(di('salute-muta', segnali(muta({ ultime: null }), { adesso: ADESSO })), [])
  assert.deepEqual(di('salute-muta', segnali(base({ salute: { errore: 'AccessDenied' } }), { adesso: ADESSO })), [])
})

// ── 3. motore-non-supportato ──────────────────────────────────────────────────────────────────────

test('motore-non-supportato: colima dichiarato parla, Docker Desktop no', () => {
  const out = di('motore-non-supportato', segnali(base({ salute: { macchine: [mac({ motore: 'colima', motoreCandidati: ['colima'] })] } }), { adesso: ADESSO }))
  assert.equal(out.length, 1)
  assert.equal(out[0].chiave, 'motore-non-supportato:mac-di-tizio')
  assert.equal(out[0].livello, 'info')
  assert.equal(out[0].quando, LUNEDI)
  assert.equal(out[0].calmaMs, SETTIMANA_MS)
  const dd = mac({ motore: 'docker-desktop', motoreCandidati: ['docker-desktop'] })
  assert.deepEqual(di('motore-non-supportato', segnali(base({ salute: { macchine: [dd] } }), { adesso: ADESSO })), [])
})

test('motore-non-supportato: dedotto da «Docker Engine» parla finche nessuno dei due e ammesso', () => {
  const [m] = riassumiSalute([ev(ADESSO - 60_000, RIGA_COLIMA)])
  const dati = base({ salute: { macchine: [m] } })
  const out = di('motore-non-supportato', segnali(dati, { adesso: ADESSO }))
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].candidati, ['colima', 'orbstack'])
  assert.deepEqual(out[0].chi, ['RossiTizio'])
  // Con OrbStack ammesso «colima o OrbStack» non e' un'accusa che si possa fare.
  assert.deepEqual(di('motore-non-supportato', segnali(dati, { adesso: ADESSO, soglie: { motoriAmmessi: ['docker-desktop', 'orbstack'] } })), [])
})

test('motore-non-supportato: senza motore ne desktop non si dice niente', () => {
  assert.deepEqual(di('motore-non-supportato', segnali(base({ salute: { macchine: [mac()] } }), { adesso: ADESSO })), [])
})

// ── 4. vm-sotto-obiettivo ─────────────────────────────────────────────────────────────────────────

test('vm-sotto-obiettivo: impostata due GB sotto l obiettivo parla, un GB no', () => {
  const sotto = di('vm-sotto-obiettivo', segnali(base({ salute: { macchine: [mac({ vmMemImpostataGb: 12, vmMemGb: 11.6, vmMemObiettivoGb: 14 })] } }), { adesso: ADESSO }))
  assert.equal(sotto.length, 1)
  assert.equal(sotto[0].vmGb, 12)
  assert.equal(sotto[0].stimata, false)
  assert.equal(sotto[0].obiettivoGb, 14)
  assert.equal(sotto[0].calmaMs, SETTIMANA_MS)
  assert.deepEqual(di('vm-sotto-obiettivo', segnali(base({ salute: { macchine: [mac({ vmMemImpostataGb: 13, vmMemObiettivoGb: 14 })] } }), { adesso: ADESSO })), [])
})

test('vm-sotto-obiettivo: senza impostata si stima dalla vista piu mezzo GB', () => {
  // 11.7 + 0.5 = 12.2, 1.8 sotto 14: non basta. 11.4 + 0.5 = 11.9, 2.1 sotto: basta.
  assert.deepEqual(di('vm-sotto-obiettivo', segnali(base({ salute: { macchine: [mac({ vmMemGb: 11.7, vmMemObiettivoGb: 14 })] } }), { adesso: ADESSO })), [])
  const out = di('vm-sotto-obiettivo', segnali(base({ salute: { macchine: [mac({ vmMemGb: 11.4, vmMemObiettivoGb: 14 })] } }), { adesso: ADESSO }))
  assert.equal(out.length, 1)
  assert.equal(out[0].stimata, true)
  assert.equal(out[0].vmGb, 11.9)
})

test('vm-sotto-obiettivo: senza obiettivo (la riga di colima) non si confronta niente', () => {
  const [m] = riassumiSalute([ev(ADESSO - 60_000, RIGA_COLIMA)])
  assert.deepEqual(di('vm-sotto-obiettivo', segnali(base({ salute: { macchine: [m] } }), { adesso: ADESSO })), [])
})

// ── 5. opt-out-attivi ─────────────────────────────────────────────────────────────────────────────

test('opt-out-attivi: un elenco non vuoto parla, con i nomi ordinati e la loro impronta', () => {
  const out = di('opt-out-attivi', segnali(base({ salute: { macchine: [mac({ optOut: ['X_NO_MIGRATE', 'X_NO_GUARDIE', 'X_NO_MIGRATE'] })] } }), { adesso: ADESSO }))
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].nomi, ['X_NO_GUARDIE', 'X_NO_MIGRATE'])
  assert.equal(out[0].impronta, 'X_NO_GUARDIE,X_NO_MIGRATE')
  assert.equal(out[0].calmaMs, SETTIMANA_MS)
})

test('opt-out-attivi: vuoto o assente non parla', () => {
  assert.deepEqual(di('opt-out-attivi', segnali(base({ salute: { macchine: [mac({ optOut: [] }), mac({ macchina: 'b', optOut: null })] } }), { adesso: ADESSO })), [])
})

// ── 6. lavoro-sul-mac ─────────────────────────────────────────────────────────────────────────────

test('lavoro-sul-mac: bloccati piu forzati nelle 24 ore sopra la soglia parla, una volta al giorno', () => {
  const out = di('lavoro-sul-mac', segnali(base({ salute: { macchine: [mac({ comandiMac: { bloccati: 7, forzati: 3 } })] } }), { adesso: ADESSO }))
  assert.equal(out.length, 1)
  assert.equal(out[0].quante, 10)
  assert.equal(out[0].quando, Date.UTC(2026, 9, 7, 7))
  assert.equal(out[0].calmaMs, GIORNO_MS)
  assert.deepEqual(di('lavoro-sul-mac', segnali(base({ salute: { macchine: [mac({ comandiMac: { bloccati: 7, forzati: 2 } })] } }), { adesso: ADESSO })), [])
  // La soglia si cambia.
  assert.equal(di('lavoro-sul-mac', segnali(base({ salute: { macchine: [mac({ comandiMac: { bloccati: 4, forzati: 0 } })] } }), { adesso: ADESSO, soglie: { comandiSulMac: 4 } })).length, 1)
})

test('lavoro-sul-mac: senza i campi non si conta niente', () => {
  assert.deepEqual(di('lavoro-sul-mac', segnali(base({ salute: { macchine: [mac({ comandiMac: null })] } }), { adesso: ADESSO })), [])
})

// ── 7. doctor-ko ──────────────────────────────────────────────────────────────────────────────────

test('doctor-ko: dei KO sull ultimo doctor parlano, con i controlli falliti e l istante del doctor', () => {
  const doctor = { quando: '2026-10-07T10:00:00Z', ok: 20, warn: 2, ko: 1, falliti: ['docker'] }
  const out = di('doctor-ko', segnali(base({ salute: { macchine: [mac({ doctor })] } }), { adesso: ADESSO }))
  assert.equal(out.length, 1)
  assert.equal(out[0].quante, 1)
  assert.deepEqual(out[0].falliti, ['docker'])
  assert.equal(out[0].quando, Date.UTC(2026, 9, 7, 10))
})

test('doctor-ko: zero KO, senza data o di piu di una settimana fa non parla', () => {
  const con = (doctor) => di('doctor-ko', segnali(base({ salute: { macchine: [mac({ doctor })] } }), { adesso: ADESSO }))
  assert.deepEqual(con({ quando: '2026-10-07T10:00:00Z', ok: 22, warn: 0, ko: 0, falliti: [] }), [])
  assert.deepEqual(con({ quando: null, ko: 2, falliti: ['a'] }), [])
  assert.deepEqual(con({ quando: '2026-09-20T10:00:00Z', ko: 2, falliti: ['a'] }), [])
  assert.deepEqual(con(null), [])
})

test('doctor-ko: lo stesso doctor si dice una volta, uno nuovo riparla', () => {
  const giro = (quando) => segnali(base({ salute: { macchine: [mac({ doctor: { quando, ko: 1, falliti: ['docker'] } })] } }), { adesso: ADESSO })
  const primo = daAnnunciare(giro('2026-10-07T10:00:00Z'), {}, { adesso: ADESSO })
  assert.equal(di('doctor-ko', primo.nuovi).length, 1)
  assert.deepEqual(di('doctor-ko', daAnnunciare(giro('2026-10-07T10:00:00Z'), primo.stato, { adesso: ADESSO + 3 * ORA_MS }).nuovi), [])
  assert.equal(di('doctor-ko', daAnnunciare(giro('2026-10-07T14:00:00Z'), primo.stato, { adesso: ADESSO + 3 * ORA_MS }).nuovi).length, 1)
})

// ── La cadenza: una volta alla settimana, e non di piu' ───────────────────────────────────────────

const motoreColima = (adesso, dentro = {}) =>
  segnali(base({ salute: { macchine: [mac({ motore: 'colima', motoreCandidati: ['colima'], ...dentro })] } }), { adesso })

test('cadenza: un avviso settimanale non torna a ogni giro, e torna la settimana dopo', () => {
  const primo = daAnnunciare(motoreColima(ADESSO), {}, { adesso: ADESSO })
  assert.equal(primo.nuovi.length, 1)
  let stato = primo.stato
  // Giri ogni cinque minuti per tutto il resto della settimana, con il nome che cambia (il heartbeat
  // manda a volte l'utente di Teleport e a volte quello del Mac): zero messaggi.
  for (const dopo of [5 * 60_000, 31 * 60_000, GIORNO_MS, 4 * GIORNO_MS]) {
    const g = daAnnunciare(motoreColima(ADESSO + dopo, { utente: dopo % 2 ? 'tizio' : 'tizio-locale' }), stato, { adesso: ADESSO + dopo })
    assert.deepEqual(g.nuovi, [], `dopo ${dopo}`)
    stato = g.stato
  }
  // Lunedi' dopo, ma meno di sette giorni dal messaggio: aspetta.
  const lunediDopo = LUNEDI + SETTIMANA_MS + ORA_MS
  assert.deepEqual(daAnnunciare(motoreColima(lunediDopo), stato, { adesso: lunediDopo }).nuovi, [])
  // Sette giorni dal messaggio: si ridice.
  const settimanaDopo = ADESSO + SETTIMANA_MS
  assert.equal(daAnnunciare(motoreColima(settimanaDopo), stato, { adesso: settimanaDopo }).nuovi.length, 1)
})

test('cadenza: dopo un rilascio (stato vuoto) si prende nota e si ridice il periodo dopo, non al giro dopo', () => {
  const zero = daAnnunciare(motoreColima(ADESSO), null, { adesso: ADESSO })
  assert.deepEqual(zero.nuovi, [])
  const giro = daAnnunciare(motoreColima(ADESSO + 5 * 60_000), zero.stato, { adesso: ADESSO + 5 * 60_000 })
  assert.deepEqual(giro.nuovi, [])
  const lunediDopo = LUNEDI + SETTIMANA_MS + 60_000
  assert.equal(daAnnunciare(motoreColima(lunediDopo), giro.stato, { adesso: lunediDopo }).nuovi.length, 1)
})

test('cadenza: un giro senza la salute non fa dimenticare l avviso', () => {
  const primo = daAnnunciare(motoreColima(ADESSO), {}, { adesso: ADESSO })
  // Lettura fallita: nessun segnale. L'avviso settimanale resta in stato.
  const buco = daAnnunciare([], primo.stato, { adesso: ADESSO + 5 * 60_000 })
  assert.ok(buco.stato['motore-non-supportato:mac-di-tizio'])
  // Torna: e' la stessa chiave di prima, e tace.
  assert.deepEqual(daAnnunciare(motoreColima(ADESSO + 10 * 60_000), buco.stato, { adesso: ADESSO + 10 * 60_000 }).nuovi, [])
  // Passata la settimana dal messaggio la voce esce dallo stato, come gli altri segnali.
  assert.ok(daAnnunciare([], buco.stato, { adesso: ADESSO + SETTIMANA_MS - 1 }).stato['motore-non-supportato:mac-di-tizio'])
  assert.equal(daAnnunciare([], buco.stato, { adesso: ADESSO + SETTIMANA_MS }).stato['motore-non-supportato:mac-di-tizio'], undefined)
})

test('cadenza: gli opt-out si ridicono subito se l insieme cambia', () => {
  const giro = (adesso, optOut) => segnali(base({ salute: { macchine: [mac({ optOut })] } }), { adesso })
  const primo = daAnnunciare(giro(ADESSO, ['X_NO_MIGRATE']), {}, { adesso: ADESSO })
  assert.equal(primo.nuovi.length, 1)
  assert.deepEqual(daAnnunciare(giro(ADESSO + ORA_MS, ['X_NO_MIGRATE']), primo.stato, { adesso: ADESSO + ORA_MS }).nuovi, [])
  const cambiato = daAnnunciare(giro(ADESSO + ORA_MS, ['X_NO_GUARDIE', 'X_NO_MIGRATE']), primo.stato, { adesso: ADESSO + ORA_MS })
  assert.equal(cambiato.nuovi.length, 1)
  assert.deepEqual(cambiato.nuovi[0].nomi, ['X_NO_GUARDIE', 'X_NO_MIGRATE'])
})

test('cadenza: la calma e la forma dello stato degli altri segnali non cambiano', () => {
  // Uno stato di una versione precedente, senza `calmaMs`: non viene tenuto quando il segnale manca.
  const { stato } = daAnnunciare([], { 'oom:mac': { quando: 5, detto: ADESSO } }, { adesso: ADESSO })
  assert.deepEqual(stato, {})
})

// ── I messaggi ────────────────────────────────────────────────────────────────────────────────────

const msg = (segnale) => messaggioAccessi({ livello: 'attenzione', bersaglio: 'mac-di-tizio', chi: ['tizio'], ...segnale }, { publicUrl: 'https://dg' })

test('messaggi: una riga sola, la persona, il numero e il link al Mac nella Flotta, senza trattino lungo', () => {
  const tutti = [
    msg({ tipo: 'immagine-vecchia', giorni: 9 }),
    msg({ tipo: 'salute-muta', oreZitta: 31, oreDallAvvio: 2 }),
    msg({ tipo: 'motore-non-supportato', livello: 'info', motore: 'colima', candidati: ['colima'], ammessi: ['docker-desktop'] }),
    msg({ tipo: 'motore-non-supportato', livello: 'info', motore: null, candidati: ['colima', 'orbstack'], ammessi: ['docker-desktop'] }),
    msg({ tipo: 'vm-sotto-obiettivo', livello: 'info', vmGb: 11.9, stimata: true, obiettivoGb: 14 }),
    msg({ tipo: 'opt-out-attivi', livello: 'info', nomi: ['X_NO_MIGRATE', 'X_`BAD`'] }),
    msg({ tipo: 'lavoro-sul-mac', quante: 14, bloccati: 11, forzati: 3 }),
    msg({ tipo: 'doctor-ko', quante: 2, falliti: ['docker', 'doppler'] }),
  ]
  for (const m of tutti) {
    assert.equal(m.includes('\n'), false, m)
    assert.equal(m.includes(String.fromCharCode(0x2014)), false, m)
    assert.match(m, /\(tizio\)/, m)
    assert.match(m, /<https:\/\/dg\/flotta\?mac=mac-di-tizio\|Flotta>$/, m)
  }
  assert.match(tutti[0], /IMMAGINE DEL DEV-ENV VECCHIA \(tizio\): costruita 9 giorni prima/)
  assert.match(tutti[1], /SALUTE DEL DEV-ENV MUTA \(tizio\): nessuna riga da 31 ore, ma il dev-env è partito 2 ore fa/)
  assert.match(tutti[2], /^ℹ️ `mac-di-tizio` MOTORE DI DOCKER NON SUPPORTATO \(tizio\): `colima` · ammessi: docker-desktop/)
  assert.match(tutti[3], /non Docker Desktop \(colima o orbstack\)/)
  assert.match(tutti[4], /VM DEL DEV-ENV SOTTO L'OBIETTIVO \(tizio\): 11\.9 circa GB su 14/)
  // Un backtick che arriva da un'altra macchina non apre un code span.
  assert.match(tutti[5], /`X_NO_MIGRATE`, `X_'BAD'`/)
  assert.match(tutti[6], /SUL MAC INVECE CHE NEL CONTAINER \(tizio\): 14 volte in 24 ore, 11 fermate prima di partire, 3 eseguite lo stesso sul Mac · di solito/)
  assert.match(tutti[7], /DOCTOR DEL DEV-ENV KO \(tizio\): 2 controlli falliti · `docker, doppler`/)
})

// ── La pagina ─────────────────────────────────────────────────────────────────────────────────────

test('pagina: usoDellaMacchina mostra solo quel che la riga porta', () => {
  const [colima] = riassumiSalute([ev(ADESSO - 60_000, RIGA_COLIMA)])
  assert.deepEqual(usoDellaMacchina(colima), {
    motore: null,
    motoreIncerto: true,
    obiettivoGb: null,
    optOut: [],
    doctorKo: 0,
    doctorFalliti: [],
    sulMac: 0,
    bloccati: 0,
    forzati: 0,
  })
  const pieno = usoDellaMacchina(mac({ motore: 'docker-desktop', vmMemObiettivoGb: 14, optOut: ['B', 'A'], doctor: { ko: 1, falliti: ['docker'] }, comandiMac: { bloccati: 3, forzati: 1 } }))
  assert.equal(pieno.motore, 'docker-desktop')
  assert.equal(pieno.motoreIncerto, false)
  assert.equal(pieno.obiettivoGb, 14)
  assert.deepEqual(pieno.optOut, ['A', 'B'])
  assert.equal(pieno.doctorKo, 1)
  assert.equal(pieno.sulMac, 4)
  assert.equal(usoDellaMacchina(null).sulMac, 0)
})
