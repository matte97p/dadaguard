// Il canvas delle corse dei cron in Slack (server/notify/corse.js) deve dire quello che dice la pagina
// Cron: stesso stato per cron, stesso verdetto, stesse parole. Qui si inchiodano il filtro per squadra
// (con le regole del quadro dei deploy), l'ordine delle sezioni e delle righe, il paragrafo «Da
// guardare», le parole uguali ai due dizionari e il giro che crea il canvas e poi ne riscrive le sole
// celle cambiate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  corseConfig,
  squadraCron,
  cronDelCanale,
  rigaCorsa,
  verdettoTesto,
  sezioniCorse,
  daGuardare,
  canvasCorse,
  canvasCorseDaScrivere,
  aggiornaCorse,
  durataCorsaTesto,
  linkCron,
  titoloCorse,
  testoAvvisoCorse,
  TUTTI,
} from '../server/notify/corse.js'
import { regoleSquadre, leggiCanvasHtml, pianoCelle } from '../server/notify/quadro.js'
import { contaCron, verdettoCron, statoCron } from '../shared/cron.js'
import { makeT, hasKey } from '../server/i18n.js'

const ORA = Date.parse('2026-10-03T12:00:00Z')
const DG = 'https://dg.example.com'
const t = makeT('it')
const ok = (startedAt, ms = 240_000) => ({ outcome: 'ok', startedAt: Date.parse(startedAt), endedAt: Date.parse(startedAt) + ms, durationMs: ms })
const cron = (account, name, extra = {}) => ({
  key: `${account}/${name}`,
  name,
  account,
  type: 'lambda',
  function: name,
  enabled: true,
  nextRunAt: Date.parse('2026-10-03T13:00:00Z'),
  runs: [ok('2026-10-03T11:00:00Z')],
  ...extra,
})

// ── Configurazione ───────────────────────────────────────────────────────────────────────────────

test('corseConfig: un canale per chiave, `tutti` o una squadra del quadro; una squadra ignota si scarta', () => {
  const cfg = corseConfig({
    DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto',
    DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI, Data=C0DATA ,fantasma=C0X,=C0Y,vuoto=',
    DADAGUARD_QUADRO_SQUADRE: 'data=Scraper,worker-*',
  })
  assert.deepEqual(cfg.canali, [
    { chiave: 'tutti', canale: 'C0TUTTI' },
    { chiave: 'data', canale: 'C0DATA' },
  ])
  assert.deepEqual(cfg.ignote, ['fantasma'])
  assert.equal(cfg.intervalMs, 300_000)
  // Spento senza la variabile: nessun canale, e `startCorse` non parte.
  assert.deepEqual(corseConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto' }).canali, [])
  // Il minimo regge: un giro ogni 10 secondi sui log non si accetta.
  assert.equal(corseConfig({ DADAGUARD_CORSE_INTERVAL: '10' }).intervalMs, 120_000)
})

// ── Squadre ──────────────────────────────────────────────────────────────────────────────────────

test('squadraCron: le stesse regole del quadro, prima il repository dell’immagine poi i glob sul nome breve', () => {
  const regole = regoleSquadre({ data: ['scraper', 'worker-*'], plat: ['report-*'], altra: ['scraper-image'] })
  // Repository dell'immagine (cron ECS): vince sul glob di un'altra squadra.
  assert.equal(squadraCron({ name: 'acme-production-cron-report-mensile', type: 'ecs-scheduled', immagine: 'Scraper' }, regole), 'data')
  // Glob sul nome breve, senza `<org>-<env>-` né `cron-`.
  assert.equal(squadraCron({ name: 'acme-production-cron-worker-sync', function: 'acme-production-cron-worker-sync' }, regole), 'data')
  assert.equal(squadraCron({ name: 'acme-staging-cron-report-mensile' }, regole), 'plat')
  // Il nome della famiglia vale come quello dello schedule.
  assert.equal(squadraCron({ name: 'acme-production-nightly', family: 'acme-production-worker-nightly' }, regole), 'data')
  // Di nessuno.
  assert.equal(squadraCron({ name: 'acme-production-cron-pulizia' }, regole), undefined)
})

test('cronDelCanale: `tutti` ha tutto, una squadra solo i suoi; ognuno sta in una squadra sola', () => {
  const crons = [
    cron('production', 'acme-production-cron-worker-a'),
    cron('production', 'acme-production-cron-report-b'),
    cron('staging', 'acme-staging-cron-worker-a'),
    cron('production', 'acme-production-cron-pulizia', { type: 'ecs-scheduled', immagine: 'scraper' }),
  ]
  const squadre = { data: ['scraper', 'worker-*'], plat: ['report-*', 'worker-a'] }
  assert.equal(cronDelCanale(crons, TUTTI, squadre).length, 4)
  assert.deepEqual(
    cronDelCanale(crons, 'data', squadre).map((c) => c.name),
    ['acme-production-cron-worker-a', 'acme-staging-cron-worker-a', 'acme-production-cron-pulizia'],
  )
  // `worker-a` risponde anche al glob di plat, ma la prima squadra scritta vince, come nel quadro.
  assert.deepEqual(cronDelCanale(crons, 'plat', squadre).map((c) => c.name), ['acme-production-cron-report-b'])
  assert.deepEqual(cronDelCanale(crons, 'nessuno', squadre), [])
})

// ── Stato, verdetto e parole ─────────────────────────────────────────────────────────────────────

test('verdetto: le stesse frasi della pagina («1 cron fallito, 3 in corso»)', () => {
  const crons = [
    cron('production', 'a', { runs: [{ outcome: 'failed', exitCode: 1, startedAt: ORA - 3_600_000, endedAt: ORA - 3_500_000 }] }),
    cron('production', 'b', { runs: [{ running: true, outcome: 'running', startedAt: ORA - 60_000 }] }),
    cron('production', 'c', { runs: [{ running: true, outcome: 'running', startedAt: ORA - 60_000 }] }),
    cron('staging', 'd', { runs: [{ running: true, outcome: 'running', startedAt: ORA - 60_000 }] }),
    cron('staging', 'e', { runs: [] }),
  ]
  assert.deepEqual(contaCron(crons), { totale: 5, falliti: 1, nonPartiti: 1, inCorso: 3 })
  assert.equal(verdettoTesto(crons, { t }).testo, '❌ **1 cron fallito**, 3 in corso')
  assert.equal(verdettoTesto(crons.slice(4), { t }).testo, '⚠️ **1 cron non è partito**')
  assert.equal(verdettoTesto(crons.slice(1, 3), { t }).testo, '⏳ **2 cron in corso**, gli altri a posto')
  assert.equal(verdettoTesto([cron('production', 'f')], { t }).testo, '✅ **Tutti i cron sono a posto**')
  assert.equal(verdettoCron({ falliti: 2, nonPartiti: 1 }).resto[0], 'rilasci.cron.v.eNonPartiti')
})

// La stessa interpolazione dei due dizionari (`interpolate` in web/i18n.jsx e server/i18n.js).
const rendi = (s, vars) => {
  let out = String(s).replace(/\{(\w+)#([^#{}]*)#([^{}]*)\}/g, (_, k, uno, altri) => (Number(vars?.[k]) === 1 ? uno : altri))
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
  return out
}

test('le chiavi del canvas hanno nel dizionario del server lo STESSO testo della pagina, in it e en', () => {
  // Il dizionario del web non si importa (è JSX): si legge come testo. La prima occorrenza di una
  // chiave è nel blocco italiano, la seconda in quello inglese.
  const web = readFileSync(new URL('../web/i18n.jsx', import.meta.url), 'utf8')
  const src = readFileSync(new URL('../server/notify/corse.js', import.meta.url), 'utf8') + readFileSync(new URL('../shared/cron.js', import.meta.url), 'utf8')
  const usate = new Set([...src.matchAll(/'((?:rilasci\.cron|runs)\.[a-zA-Z.]+)'/g)].map((m) => m[1]))
  for (const s of ['crit', 'warn', 'info', 'ok', 'off']) usate.add(`rilasci.cron.stato.${s}`)
  assert.ok(usate.size > 10, `poche chiavi trovate: ${[...usate]}`)
  for (const k of usate) {
    const nelWeb = [...web.matchAll(new RegExp(`'${k.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g'))].map((m) => m[1])
    assert.equal(nelWeb.length, 2, `${k}: attesa una volta in it e una in en nel web`)
    for (const [i, lang] of ['it', 'en'].entries()) {
      assert.ok(hasKey(lang, k), `${k} manca nel dizionario server (${lang})`)
      // Si confronta il testo RESO, al singolare e al plurale: è quello che si legge.
      for (const vars of [{ n: 1, code: 9, quando: 'Q', d: 'D' }, { n: 2, code: 9, quando: 'Q', d: 'D' }])
        assert.equal(makeT(lang)(k, vars), rendi(nelWeb[i].replace(/\\'/g, "'"), vars), `${k} (${lang}): server e pagina dicono cose diverse`)
    }
  }
})

test('rigaCorsa: stato, ultima corsa a orario fisso, prossima, link al cron', () => {
  const r = rigaCorsa(cron('production', 'acme-production-cron-report'), { ora: ORA, url: DG, t })
  assert.equal(r.nome, 'report')
  assert.equal(r.link, `${DG}/cron?cron=production%2Facme-production-cron-report`)
  assert.deepEqual(r.celle, [`[**report**](${DG}/cron?cron=production%2Facme-production-cron-report)`, '✅ Ok', 'Ok oggi 13:00, 4 min', 'oggi 15:00'])

  const fallito = rigaCorsa(cron('production', 'x', { runs: [{ outcome: 'failed', exitCode: 137, stopReason: 'OutOfMemoryError: killed', startedAt: Date.parse('2026-10-02T21:10:00Z') }] }), { ora: ORA, t })
  assert.deepEqual(fallito.celle.slice(1, 3), ['❌ Fallito', 'Fallito ieri 23:10 · memoria esaurita'])

  // In corso dopo un fallimento: è ancora rosso (come sulla pagina), e il motivo si vede.
  const ripartito = rigaCorsa(
    cron('production', 'x', { runs: [{ running: true, outcome: 'running', startedAt: Date.parse('2026-10-03T11:41:00Z') }, { outcome: 'failed', exitCode: 2, startedAt: ORA - 7_200_000 }] }),
    { ora: ORA, t },
  )
  assert.equal(ripartito.stato, 'crit')
  assert.equal(ripartito.celle[2], 'In corso dalle 13:41 · prima: exit 2')

  const spento = rigaCorsa(cron('staging', 'y', { enabled: false, runs: [], nextRunAt: null }), { ora: ORA, t })
  assert.deepEqual(spento.celle.slice(1), ['➖ Spento', 'Spento di proposito: non è un guasto', 'Spento'])

  const nonPartito = rigaCorsa(cron('staging', 'z', { runs: [], nextRunAt: null, scheduleMinutes: 5, error: 'ThrottlingException: rate exceeded' }), { ora: ORA, t })
  assert.deepEqual(nonPartito.celle.slice(1), ['⚠️ Non partito', 'Non è partito in questa finestra · errore: ThrottlingException: rate exceeded', 'ogni 5 min'])

  // Un `|` arrivato da fuori non rompe la tabella.
  assert.ok(rigaCorsa(cron('production', 'w', { runs: [{ outcome: 'failed', stopReason: 'a | b', startedAt: ORA - 1000 }] }), { ora: ORA, t }).celle[2].includes('a \\| b'))
})

test('durataCorsaTesto: secondi, minuti, ore', () => {
  assert.equal(durataCorsaTesto(45_000), '45 s')
  assert.equal(durataCorsaTesto(6 * 60_000), '6 min')
  assert.equal(durataCorsaTesto(80 * 60_000), '1 h 20 min')
  assert.equal(durataCorsaTesto(120 * 60_000), '2 h')
  assert.equal(durataCorsaTesto(null), null)
  assert.equal(linkCron({ key: 'a/b' }, null), null)
})

// ── Ordine ───────────────────────────────────────────────────────────────────────────────────────

test('sezioni: produzione prima di staging, righe in ordine di nome (non di stato: la tabella non si muove)', () => {
  const crons = [
    cron('staging', 'acme-staging-cron-b'),
    cron('production', 'acme-production-cron-zeta', { runs: [{ outcome: 'failed', exitCode: 1, startedAt: ORA - 1000 }] }),
    cron('production', 'acme-production-cron-alfa'),
    cron('management', 'acme-management-cron-c'),
  ]
  const s = sezioniCorse(crons, { etichette: { production: 'Produzione', staging: 'Staging', management: 'Gestione' }, ora: ORA, t })
  assert.deepEqual(s.map((x) => x.titolo), ['Produzione', 'Staging', 'Gestione'])
  assert.deepEqual(s[0].righe.map((r) => r.nome), ['alfa', 'zeta'])
  assert.equal(s[0].sintesi, '❌ **1 cron fallito** · 2 cron')
  // Due account nello stesso ambiente: il titolo dice anche quale.
  const due = sezioniCorse([cron('production', 'a'), cron('prod-data', 'b')], { etichette: { production: 'principale', 'prod-data': 'dati' }, ora: ORA, t })
  assert.deepEqual(due.map((x) => x.titolo), ['Produzione · dati', 'Produzione · principale'])
})

test('sezioni: un account non letto ha la sua sezione senza righe, che tollera quelle che il canvas ha', () => {
  const s = sezioniCorse([cron('production', 'a')], { problemi: [{ account: 'staging', error: 'AccessDenied' }], ora: ORA, t })
  assert.deepEqual(s.map((x) => [x.titolo, x.righe.length, x.tollera]), [
    ['Produzione', 1, false],
    ['Staging', 0, true],
  ])
  assert.match(s[1].sintesi, /cron non letti.*AccessDenied/)
})

test('daGuardare: falliti, poi non partiti, poi in corso; produzione prima di staging', () => {
  const crons = [
    cron('staging', 'acme-staging-cron-uno', { runs: [{ outcome: 'failed', exitCode: 1, startedAt: ORA - 1000 }] }),
    cron('production', 'acme-production-cron-due', { runs: [{ running: true, startedAt: ORA - 1000 }] }),
    cron('production', 'acme-production-cron-tre', { runs: [] }),
    cron('production', 'acme-production-cron-quattro', { runs: [{ outcome: 'failed', exitCode: 1, startedAt: ORA - 1000 }] }),
    cron('production', 'acme-production-cron-sano'),
  ]
  const s = sezioniCorse(crons, { ora: ORA, t })
  assert.equal(daGuardare(s), '**Da guardare**: ❌ quattro (PROD) · ❌ uno (STAGING) · ⚠️ tre (PROD) · ⏳ due (PROD)')
  assert.equal(daGuardare(s, { max: 2 }), '**Da guardare**: ❌ quattro (PROD) · ❌ uno (STAGING) e altri 2')
  assert.equal(daGuardare(sezioniCorse([cron('production', 'a')], { ora: ORA, t })), 'Da guardare: niente')
})

// ── Canvas ───────────────────────────────────────────────────────────────────────────────────────

test('canvasCorse: riepilogo col verdetto del SUO sottoinsieme, poi una tabella per account', () => {
  const crons = [cron('production', 'acme-production-cron-a'), cron('staging', 'acme-staging-cron-a', { runs: [] })]
  const c = canvasCorse('data', crons, { ora: ORA, url: DG, t })
  assert.equal(c.titolo, titoloCorse('data'))
  assert.equal(c.titolo, 'Corse cron DATA')
  assert.deepEqual(c.modello.sezioni.map((s) => s.titolo), ['Riepilogo', 'Produzione', 'Staging'])
  assert.equal(c.modello.sezioni[0].sintesi, '⚠️ **1 cron non è partito** · 2 cron')
  assert.match(c.markdown, /^## Riepilogo\n\n⚠️ \*\*1 cron non è partito\*\*/)
  assert.match(c.markdown, /\| Cron \| Stato \| Ultima corsa \| Prossima \|/)
  assert.match(c.markdown, /\[Cron su Dadaguard\]\(https:\/\/dg\.example\.com\/cron\)/)
  // Un canvas di squadra senza cron non dice «tutti a posto».
  assert.match(canvasCorse('plat', [], { ora: ORA, t }).markdown, /nessun cron/)
})

test('canvasCorseDaScrivere: UNA lettura, un canvas per canale, ognuno col verdetto dei soli suoi cron', () => {
  const overview = {
    window: 1440,
    crons: [
      cron('production', 'acme-production-cron-worker-a', { runs: [{ outcome: 'failed', exitCode: 1, startedAt: ORA - 1000 }] }),
      cron('production', 'acme-production-cron-report'),
      { key: 'prefect/x', name: 'x', type: 'prefect', runs: [] },
    ],
    problems: [],
  }
  const cfg = corseConfig({
    DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto',
    DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI,data=C0DATA,plat=C0PLAT',
    DADAGUARD_QUADRO_SQUADRE: 'data=worker-*;plat=report*',
    DADAGUARD_PUBLIC_URL: DG,
  })
  const out = canvasCorseDaScrivere({ overview, etichette: {} }, cfg, { ora: ORA })
  assert.deepEqual(out.map((c) => [c.chiave, c.canale, c.conti.totale, c.livello]), [
    ['tutti', 'C0TUTTI', 2, 'crit'],
    ['data', 'C0DATA', 1, 'crit'],
    ['plat', 'C0PLAT', 1, 'ok'],
  ])
})

// ── Il giro ──────────────────────────────────────────────────────────────────────────────────────

// Un Slack finto, solo canvas: il markdown diventa blocchi con un id ciascuno (una cella di tabella è
// un paragrafo), l'HTML scaricato ha la forma di quello vero, un `replace` con `section_id` cambia il
// solo blocco. Come quello di test/quadro.test.js, ridotto ai canvas.
function slackFinto() {
  let n = 0
  const nuovoId = () => `temp:C:${++n}`
  const canvas = new Map()
  const chiamate = []
  const mdInHtml = (md) =>
    String(md)
      .replace(/\\\|/g, '\u0000')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, '<lnk href="$2">$1</lnk>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\u0000/g, '|')
  const blocchiDa = (titolo, md) => [
    { tipo: 'h1', id: nuovoId(), md: titolo },
    ...md.split('\n\n').map((parte) => {
      if (parte.startsWith('## ')) return { tipo: 'h2', id: nuovoId(), md: parte.slice(3) }
      if (parte.startsWith('|'))
        return {
          tipo: 'table',
          righe: parte
            .split('\n')
            .filter((l) => !/^\|-/.test(l))
            .map((l) => l.slice(2, -2).split(/ (?<!\\)\| /).map((c) => ({ id: nuovoId(), md: c }))),
        }
      return { tipo: 'p', id: nuovoId(), md: parte }
    }),
  ]
  const html = (blocchi) =>
    blocchi
      .map((b) =>
        b.tipo === 'table'
          ? `<table>${b.righe.map((r) => `<tr>${r.map((c) => `<td><p id="${c.id}" class="line">${mdInHtml(c.md)}</p></td>`).join('')}</tr>`).join('')}</table>`
          : b.tipo === 'p'
            ? `<p id="${b.id}" class="line">${mdInHtml(b.md)}</p>`
            : `<${b.tipo} id="${b.id}">${mdInHtml(b.md)}</${b.tipo}>`,
      )
      .join('')
  const trova = (blocchi, id) => blocchi.flatMap((b) => (b.tipo === 'table' ? b.righe.flat() : [b])).find((x) => x.id === id)
  const api = async (metodo, corpo) => {
    chiamate.push([metodo, corpo])
    if (metodo === 'conversations.info')
      return { channel: { properties: { tabs: [...canvas.values()].filter((c) => c.canale === corpo.channel).map((c) => ({ type: 'canvas', label: c.titolo, data: { file_id: c.id, shared_ts: c.ts } })) } } }
    if (metodo === 'conversations.canvases.create') {
      const id = `F${++n}`
      canvas.set(id, { id, canale: corpo.channel_id, titolo: corpo.title, ts: String(n), blocchi: blocchiDa(corpo.title, corpo.document_content.markdown) })
      return { canvas_id: id }
    }
    if (metodo === 'canvases.access.set') return {}
    if (metodo === 'canvases.edit') {
      const c = canvas.get(corpo.canvas_id)
      const [m] = corpo.changes
      if (m.operation === 'rename') c.titolo = m.title_content.markdown
      else if (!m.section_id) c.blocchi = blocchiDa(c.titolo, m.document_content.markdown)
      else trova(c.blocchi, m.section_id).md = m.document_content.markdown
      return {}
    }
    if (metodo === 'files.info') return { file: { id: corpo.file, title: canvas.get(corpo.file).titolo, url_private_download: `mem://${corpo.file}` } }
    throw new Error(`metodo non previsto: ${metodo}`)
  }
  const scarica = async (url) => html(canvas.get(url.replace('mem://', '')).blocchi)
  return { api, scarica, canvas, chiamate, html }
}

test('aggiornaCorse: crea il canvas, poi riscrive solo le celle cambiate; uno cancellato a mano si ricrea', async () => {
  const s = slackFinto()
  const cfg = corseConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto', DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI', DADAGUARD_PUBLIC_URL: DG })
  const crons = [cron('production', 'acme-production-cron-a'), cron('production', 'acme-production-cron-b'), cron('staging', 'acme-staging-cron-a')]
  const leggi = (lista) => async () => ({ overview: { window: 1440, crons: lista, problems: [] }, etichette: {} })
  const ultimi = new Map()
  const titoli = new Set()
  const giro = (lista, ora = ORA) => aggiornaCorse(cfg, { api: s.api, scarica: s.scarica, leggiDati: leggi(lista), ora, ultimi, titoli })

  const [primo] = await giro(crons)
  assert.equal(primo.azione, 'creato')
  assert.equal(primo.ambiente, 'corse-tutti')
  const id = primo.canvas

  // Niente di cambiato: nessuna chiamata di scrittura.
  s.chiamate.length = 0
  assert.equal((await giro(crons))[0].azione, 'invariato')
  assert.ok(!s.chiamate.some(([m]) => m === 'canvases.edit'))

  // Un cron fallisce: cambiano la sua cella di stato e di ultima corsa, il verdetto del riepilogo, il
  // «Da guardare» e la sintesi della sua sezione. Le righe non si spostano, quindi niente riscrittura.
  const rotto = crons.map((c, i) => (i === 1 ? { ...c, runs: [{ outcome: 'failed', exitCode: 3, startedAt: ORA - 60_000 }] } : c))
  s.chiamate.length = 0
  const [e] = await giro(rotto)
  assert.equal(e.azione, 'celle')
  assert.equal(e.celle, 5)
  const edits = s.chiamate.filter(([m]) => m === 'canvases.edit').map(([, c]) => c.changes[0])
  assert.ok(edits.every((x) => x.section_id), 'solo modifiche per cella')
  assert.ok(edits.some((x) => x.document_content.markdown === '❌ Fallito'))
  // Quello che si legge ora nel canvas è il modello del giro: nessuna cella da riscrivere.
  const modello = canvasCorseDaScrivere({ overview: { window: 1440, crons: rotto, problems: [] }, etichette: {} }, cfg, { ora: ORA })[0].modello
  assert.deepEqual(pianoCelle(modello, leggiCanvasHtml(s.html(s.canvas.get(id).blocchi))), [])

  // Cancellato a mano: la scheda sparisce dal canale, e al giro dopo il canvas rinasce.
  s.canvas.delete(id)
  const [rinato] = await giro(rotto, ORA + 1000)
  assert.equal(rinato.azione, 'creato')
  assert.notEqual(rinato.canvas, id)

  // Un cron nuovo cambia la forma: il canvas si riscrive intero, una volta.
  const [nuovo] = await giro([...rotto, cron('production', 'acme-production-cron-c')])
  assert.equal(nuovo.azione, 'riscritto')
})

test('aggiornaCorse: il tetto di modifiche vale per giro, il resto va al giro dopo', async () => {
  const s = slackFinto()
  const cfg = corseConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto', DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI' })
  const crons = ['a', 'b', 'c', 'd'].map((n) => cron('production', `acme-production-cron-${n}`))
  const leggi = (lista) => async () => ({ overview: { window: 1440, crons: lista, problems: [] }, etichette: {} })
  const ultimi = new Map()
  await aggiornaCorse(cfg, { api: s.api, scarica: s.scarica, leggiDati: leggi(crons), ora: ORA, ultimi })
  const rotti = crons.map((c) => ({ ...c, runs: [{ outcome: 'failed', exitCode: 1, startedAt: ORA - 1000 }] }))
  const [e] = await aggiornaCorse(cfg, { api: s.api, scarica: s.scarica, leggiDati: leggi(rotti), ora: ORA, ultimi, maxModifiche: 3 })
  assert.equal(e.celle, 3)
  assert.ok(e.restano > 0)
  const [poi] = await aggiornaCorse(cfg, { api: s.api, scarica: s.scarica, leggiDati: leggi(rotti), ora: ORA, ultimi })
  assert.equal(poi.restano, 0)
})

test('testoAvvisoCorse: fermo e rientrato, con la grammatica del canale', () => {
  assert.match(testoAvvisoCorse({ ambiente: 'corse-data', tipo: 'fermo', fermoDa: ORA - 20 * 60_000, errore: 'not_in_channel' }, { ora: ORA, url: DG }), /^⚠️ `corse cron` \[DATA\] FERMO · il canvas non si aggiorna da 20 min · ultimo errore: not_in_channel/)
  assert.match(testoAvvisoCorse({ ambiente: 'corse-tutti', tipo: 'rientrato', fermoDa: ORA - 60 * 60_000 }, { ora: ORA }), /^✅ `corse cron` \[TUTTI\] rientrato/)
})

test('statoCron condiviso: la pagina e il canvas usano la stessa funzione', async () => {
  const web = await import('../web/rilasci.js')
  assert.equal(web.statoCron, statoCron)
})
