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
  STATI_CORSE,
  schemaCorse,
  celleCorsa,
  voceLista,
  nomiLista,
  listeCorseDaScrivere,
  titoloListaCorse,
  MAX_RIGHE_NUOVE_CORSE,
} from '../server/notify/corse.js'
import { regoleSquadre, leggiCanvasHtml, pianoCelle, nuovaMemoriaListe } from '../server/notify/quadro.js'
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
  // Le List accese di default, spente con `0` come quelle del quadro.
  assert.equal(corseConfig({}).liste, true)
  assert.equal(corseConfig({ DADAGUARD_CORSE_LISTE: '0' }).liste, false)
  assert.equal(corseConfig({ DADAGUARD_CORSE_LISTE: 'off' }).liste, false)
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

test('canvasCorse con le List spente: riepilogo col verdetto del SUO sottoinsieme, poi una tabella per account', () => {
  const crons = [cron('production', 'acme-production-cron-a'), cron('staging', 'acme-staging-cron-a', { runs: [] })]
  const c = canvasCorse('data', crons, { ora: ORA, url: DG, t, tabelle: true })
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

test('canvasCorse con le List: solo il riepilogo, cioè verdetto, «Da guardare» e il link alla List', () => {
  const crons = [cron('production', 'acme-production-cron-a', { runs: [{ outcome: 'failed', exitCode: 1, startedAt: ORA - 1000 }] }), cron('staging', 'acme-staging-cron-a')]
  const c = canvasCorse('tutti', crons, { ora: ORA, url: DG, t, lista: { url: 'https://x.slack.com/lists/T1/FL1' } })
  assert.deepEqual(c.modello.sezioni.map((s) => s.titolo), ['Riepilogo'])
  assert.doesNotMatch(c.markdown, /\| Cron \|/, 'niente tabelle: il dettaglio sta nella List')
  assert.equal(
    c.markdown,
    [
      '## Riepilogo',
      '❌ **1 cron fallito** · 2 cron',
      `**Da guardare**: ❌ [a](${DG}/cron?cron=production%2Facme-production-cron-a) (PROD)  |  ultime 24 h · [Lista corse cron TUTTI](https://x.slack.com/lists/T1/FL1) · [Cron su Dadaguard](${DG}/cron)`,
    ].join('\n\n'),
  )
  // Senza List (non ancora creata, o un errore) il riepilogo resta, senza il link.
  assert.doesNotMatch(canvasCorse('tutti', crons, { ora: ORA, url: DG, t }).markdown, /Lista corse/)
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

// ── La List ──────────────────────────────────────────────────────────────────────────────────────

test('la List delle corse: colonne da filtrare dopo il nome, Stato con le parole e i colori della pagina', () => {
  assert.deepEqual(schemaCorse().map((c) => `${c.name}:${c.type}`), ['Cron:text', 'Ambiente:select', 'Stato:select', 'Ultima corsa:text', 'Prossima:text', 'Dettagli:text', 'Codice:text'])
  assert.deepEqual(schemaCorse({ sezione: true }).map((c) => c.key), ['cron', 'ambiente', 'stato', 'sezione', 'ultima', 'prossima', 'dettagli', 'codice'])
  const stato = schemaCorse().find((c) => c.key === 'stato').options.choices
  // I `value` sono i livelli di `statoCron`, dal più grave; le etichette le parole della pagina.
  assert.deepEqual(stato.map((c) => `${c.value}:${c.label}:${c.color}`), ['crit:❌ Fallito:red', 'warn:⚠️ Non partito:yellow', 'info:⏳ In corso:blue', 'ok:✅ Ok:green', 'off:➖ Spento:gray'])
  assert.deepEqual(Object.keys(STATI_CORSE), ['crit', 'warn', 'info', 'ok', 'off'])
  assert.deepEqual(schemaCorse().find((c) => c.key === 'ambiente').options.choices.map((c) => c.value), ['produzione', 'staging', 'altro'])
  assert.equal(titoloListaCorse('data'), 'Lista corse cron DATA')
})

test('voceLista: stato, ultima corsa a orario fisso con la durata, prossima, il perché nei Dettagli, il repository del codice', () => {
  const codice = { codice: 'acme-crons/report', codiceUrl: 'https://github.com/acme/acme-crons/tree/main/report' }
  const ok = voceLista(cron('production', 'acme-production-cron-report', codice), { nome: 'acme-crons/report', ora: ORA, url: DG, t })
  assert.deepEqual(ok, {
    nome: 'acme-crons/report',
    link: `${DG}/cron?cron=production%2Facme-production-cron-report`,
    ambiente: 'produzione',
    stato: 'ok',
    sezione: null,
    ultima: 'oggi 13:00 · 4 min',
    prossima: 'oggi 15:00',
    dettagli: 'n/d',
    codice: 'acme-crons',
    codiceUrl: codice.codiceUrl,
  })
  const c = celleCorsa(ok)
  assert.deepEqual(Object.keys(c), ['cron', 'ambiente', 'stato', 'ultima', 'prossima', 'dettagli', 'codice'])
  assert.deepEqual(c.stato, { firma: 'ok', valore: { select: ['ok'] } })
  // Nome e Codice sono testi col link dentro; la firma è il testo, l'unica cosa che la List rilegge.
  assert.equal(c.cron.firma, 'acme-crons/report')
  assert.equal(c.cron.valore.rich_text[0].elements[0].elements[0].url, ok.link)
  assert.equal(c.codice.valore.rich_text[0].elements[0].elements[0].url, codice.codiceUrl)
  assert.equal(c.dettagli.valore.rich_text[0].elements[0].elements[0].type, 'text')

  const oom = voceLista(cron('staging', 'x', { runs: [{ outcome: 'failed', exitCode: 137, stopReason: 'OutOfMemoryError: killed', startedAt: Date.parse('2026-10-02T21:10:00Z'), durationMs: 45_000 }] }), { ora: ORA, t })
  assert.deepEqual([oom.ambiente, oom.stato, oom.ultima, oom.dettagli, oom.codice], ['staging', 'crit', 'ieri 23:10 · 45 s', 'memoria esaurita', 'n/d'])

  const ripartito = voceLista(cron('production', 'x', { runs: [{ running: true, startedAt: Date.parse('2026-10-03T11:41:00Z') }, { outcome: 'failed', exitCode: 2, startedAt: ORA - 7_200_000 }] }), { ora: ORA, t })
  assert.deepEqual([ripartito.stato, ripartito.ultima, ripartito.dettagli], ['crit', 'In corso dalle 13:41', 'prima: exit 2'])

  const spento = voceLista(cron('management', 'y', { enabled: false, runs: [], nextRunAt: null }), { ora: ORA, t })
  assert.deepEqual([spento.ambiente, spento.stato, spento.ultima, spento.prossima, spento.dettagli], ['altro', 'off', 'n/d', 'Spento', 'Spento di proposito: non è un guasto'])

  const fermo = voceLista(cron('staging', 'z', { runs: [], nextRunAt: null, scheduleMinutes: 5 }), { ora: ORA, t })
  assert.deepEqual([fermo.stato, fermo.prossima, fermo.dettagli], ['warn', 'ogni 5 min', 'Non è partito in questa finestra'])

  // Il reaper piegato nel job: il suo guasto sta nello stato e nei Dettagli del job.
  const conReaper = voceLista(cron('production', 'job', { reaper: cron('production', 'job-reaper', { runs: [{ outcome: 'failed', exitCode: 1, startedAt: ORA - 60_000 }] }) }), { ora: ORA, t })
  assert.equal(conReaper.stato, 'crit')
  assert.match(conReaper.dettagli, /^reaper: Fallito oggi 13:59/)
})

test('nomiLista: il nome del canvas, con l’account accanto solo dove lo stesso ambiente ne ha più d’uno', () => {
  const crons = [cron('production', 'acme-production-cron-a', { codice: 'acme-crons/a' }), cron('staging', 'acme-staging-cron-a', { codice: 'acme-crons/a' })]
  assert.deepEqual([...nomiLista(crons).values()], ['acme-crons/a', 'acme-crons/a'], 'ambienti diversi: la colonna Ambiente li distingue')
  const due = [...crons, cron('prod-data', 'acme-prod-data-cron-a', { codice: 'acme-crons/a' }), cron('management', 'acme-management-cron-b')]
  assert.deepEqual([...nomiLista(due, { etichette: { production: 'principale', 'prod-data': 'dati', management: 'gestione' } }).values()], [
    'acme-crons/a · principale',
    'acme-crons/a',
    'acme-crons/a · dati',
    'b · gestione',
  ])
  // Un account non letto conta lo stesso: i nomi degli altri non cambiano per un giro andato male.
  assert.equal(nomiLista([crons[0]], { problemi: [{ account: 'prod-data' }] }).get(crons[0].key), 'acme-crons/a · production')
  // E conta chi sta in un'altra List: la stessa squadra non rinomina le sue righe quando un cron entra.
  assert.equal(nomiLista([crons[0]], { tutti: due }).get(crons[0].key), 'acme-crons/a · production')
})

test('listeCorseDaScrivere: una List per canale con gli stessi cron del canvas, la Sezione solo in quella di tutti', () => {
  const overview = {
    window: 1440,
    crons: [
      cron('production', 'acme-production-cron-worker-a'),
      cron('production', 'acme-production-cron-report'),
      cron('staging', 'acme-staging-cron-report'),
      cron('production', 'acme-production-cron-ssm-housekeeper'),
      { key: 'prefect/x', name: 'x', type: 'prefect', runs: [] },
    ],
    problems: [],
  }
  const cfg = corseConfig({
    DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI,data=C0DATA',
    DADAGUARD_QUADRO_SQUADRE: 'data=worker-*;infra=ssm-*',
    DADAGUARD_PUBLIC_URL: DG,
  })
  const [tutti, data] = listeCorseDaScrivere({ overview, etichette: { production: 'production', staging: 'staging' } }, cfg, { ora: ORA })
  assert.equal(tutti.titolo, 'Lista corse cron TUTTI')
  assert.deepEqual(tutti.canali, ['C0TUTTI'])
  assert.deepEqual(tutti.righe.map((r) => `${r.ambiente}|${r.nome}|${r.sezione}`), [
    'produzione|report|prodotto',
    'produzione|ssm-housekeeper|infra',
    'produzione|worker-a|prodotto',
    'staging|report|prodotto',
  ])
  assert.deepEqual(tutti.forma.schema.map((c) => c.key).includes('sezione'), true)
  assert.deepEqual(data.righe.map((r) => r.nome), ['worker-a'])
  assert.equal(data.forma.schema.some((c) => c.key === 'sezione'), false)
  assert.deepEqual([...tutti.tieni], [])

  // Un account non letto, o un ambiente senza nessun cron: le sue righe non si cancellano.
  const buco = listeCorseDaScrivere({ overview: { crons: overview.crons.slice(0, 2), problems: [{ account: 'management', error: 'x' }] }, etichette: { production: 'p', staging: 's' } }, cfg, { ora: ORA })
  assert.deepEqual([...buco[0].tieni].sort(), ['altro', 'staging'])
})

// ── Il giro ──────────────────────────────────────────────────────────────────────────────────────

// Un Slack finto, solo canvas: il markdown diventa blocchi con un id ciascuno (una cella di tabella è
// un paragrafo), l'HTML scaricato ha la forma di quello vero, un `replace` con `section_id` cambia il
// solo blocco. Come quello di test/quadro.test.js, ridotto ai canvas.
function slackFinto({ bot = 'UBOT' } = {}) {
  let n = 0
  const nuovoId = () => `temp:C:${++n}`
  const canvas = new Map()
  const liste = new Map()
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
    if (metodo === 'files.info') {
      if (canvas.has(corpo.file)) return { file: { id: corpo.file, title: canvas.get(corpo.file).titolo, url_private_download: `mem://${corpo.file}` } }
      const l = liste.get(corpo.file)
      if (!l) throw new Error('slack files.info: file_not_found')
      return { file: { id: l.id, title: l.titolo, permalink: `https://x.slack.com/lists/T1/${l.id}`, list_metadata: { schema: l.schema } } }
    }
    // Le List, come in test/quadro.test.js: righe, celle, testo riletto in `text`.
    if (metodo === 'auth.test') return { user_id: bot }
    if (metodo === 'files.list') return { files: [...liste.values()].filter((l) => l.user === corpo.user).map((l) => ({ id: l.id, title: l.titolo, created: l.creata, channels: l.canali })) }
    if (metodo === 'slackLists.create') {
      const id = `FL${++n}`
      const schema = corpo.schema.map((c, i) => ({ ...c, id: `Col${i}` }))
      liste.set(id, { id, titolo: corpo.name, user: bot, creata: n, canali: [], schema, righe: new Map() })
      return { list_id: id, list_metadata: { schema } }
    }
    if (metodo === 'slackLists.access.set') {
      liste.get(corpo.list_id).canali.push(...corpo.channel_ids)
      return {}
    }
    const l = liste.get(corpo.list_id)
    if (metodo.startsWith('slackLists.') && !l) throw new Error(`slack ${metodo}: list_not_found`)
    if (metodo === 'slackLists.items.create') {
      const id = `Rec${++n}`
      l.righe.set(id, new Map(corpo.initial_fields.map((f) => [f.column_id, f])))
      return { item: { id } }
    }
    if (metodo === 'slackLists.items.update') {
      for (const c of corpo.cells) l.righe.get(c.row_id).set(c.column_id, c)
      return {}
    }
    if (metodo === 'slackLists.items.delete') {
      l.righe.delete(corpo.id)
      return {}
    }
    if (metodo === 'slackLists.items.list')
      return {
        items: [...l.righe.entries()].map(([id, riga]) => ({
          id,
          fields: [...riga.values()].map((c) => ({
            column_id: c.column_id,
            ...(c.rich_text ? { text: c.rich_text.flatMap((r) => r.elements.flatMap((x) => x.elements.map((e) => e.text))).join('') } : {}),
            ...(c.select ? { select: c.select } : {}),
          })),
        })),
        response_metadata: { next_cursor: '' },
      }
    throw new Error(`metodo non previsto: ${metodo}`)
  }
  const scarica = async (url) => html(canvas.get(url.replace('mem://', '')).blocchi)
  return { api, scarica, canvas, liste, chiamate, html }
}

test('aggiornaCorse: crea il canvas, poi riscrive solo le celle cambiate; uno cancellato a mano si ricrea', async () => {
  const s = slackFinto()
  // Con le List spente il canvas ha le tabelle: è la forma che mette alla prova le celle.
  const cfg = corseConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto', DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI', DADAGUARD_PUBLIC_URL: DG, DADAGUARD_CORSE_LISTE: '0' })
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
  const cfg = corseConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto', DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI', DADAGUARD_CORSE_LISTE: '0' })
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

test('testoAvvisoCorse: fermo e rientrato, con la grammatica del canale; la List si chiama per nome', () => {
  assert.match(testoAvvisoCorse({ ambiente: 'corse-lista-data', tipo: 'fermo', fermoDa: ORA - 20 * 60_000, errore: 'x' }, { ora: ORA }), /^⚠️ `corse cron` \[LISTA DATA\] FERMO · la List non si aggiorna da 20 min/)
  assert.match(testoAvvisoCorse({ ambiente: 'corse-data', tipo: 'fermo', fermoDa: ORA - 20 * 60_000, errore: 'not_in_channel' }, { ora: ORA, url: DG }), /^⚠️ `corse cron` \[DATA\] FERMO · il canvas non si aggiorna da 20 min · ultimo errore: not_in_channel/)
  assert.match(testoAvvisoCorse({ ambiente: 'corse-tutti', tipo: 'rientrato', fermoDa: ORA - 60 * 60_000 }, { ora: ORA }), /^✅ `corse cron` \[TUTTI\] rientrato/)
})

test('statoCron condiviso: la pagina e il canvas usano la stessa funzione', async () => {
  const web = await import('../web/rilasci.js')
  assert.equal(web.statoCron, statoCron)
})

// Le righe di una List dello Slack finto come si leggono: per colonna, il testo o la scelta.
const righeLista = (l) =>
  [...l.righe.values()].map((riga) => Object.fromEntries(l.schema.map((c) => {
    const f = riga.get(c.id)
    return [c.key, f?.select?.[0] ?? f?.rich_text?.flatMap((r) => r.elements.flatMap((x) => x.elements.map((e) => e.text))).join('') ?? null]
  })))
const scritture = (s) => s.chiamate.filter(([m]) => /^slackLists\.(create|items\.(create|update|delete))$/.test(m))

test('aggiornaCorse con le List: una List per canale, poi solo le celle cambiate, i cron nuovi e quelli spariti', async () => {
  const s = slackFinto()
  const cfg = corseConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto', DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI', DADAGUARD_PUBLIC_URL: DG })
  const crons = [cron('production', 'acme-production-cron-a'), cron('production', 'acme-production-cron-b'), cron('staging', 'acme-staging-cron-a')]
  let letture = 0
  const leggi = (lista) => async () => {
    letture++
    return { overview: { window: 1440, crons: lista, problems: [] }, etichette: { production: 'production', staging: 'staging' } }
  }
  const memoria = { ultimi: new Map(), titoli: new Set(), liste: nuovaMemoriaListe() }
  const giro = (lista, extra = {}) => aggiornaCorse(cfg, { api: s.api, scarica: s.scarica, leggiDati: leggi(lista), ora: ORA, ...memoria, ...extra })

  const primo = await giro(crons)
  assert.equal(letture, 1, 'una lettura sola per canvas e List')
  assert.deepEqual(primo.map((e) => `${e.ambiente}:${e.azione}`), ['corse-tutti:creato', 'corse-lista-tutti:creata'])
  const lista = [...s.liste.values()][0]
  assert.equal(lista.titolo, 'Lista corse cron TUTTI')
  assert.deepEqual(lista.canali, ['C0TUTTI'], 'in sola lettura per il suo canale')
  assert.deepEqual(righeLista(lista).map((r) => `${r.cron}|${r.ambiente}|${r.stato}|${r.ultima}`), ['a|produzione|ok|oggi 13:00 · 4 min', 'b|produzione|ok|oggi 13:00 · 4 min', 'a|staging|ok|oggi 13:00 · 4 min'])
  // Il canvas è il riepilogo, col link alla List appena creata.
  const canvasMd = s.chiamate.find(([m]) => m === 'conversations.canvases.create')[1].document_content.markdown
  assert.match(canvasMd, new RegExp(`\\[Lista corse cron TUTTI\\]\\(https://x\\.slack\\.com/lists/T1/${lista.id}\\)`))
  assert.doesNotMatch(canvasMd, /\| Cron \|/)

  // Niente di cambiato: nessuna scrittura, e nemmeno una rilettura della List.
  s.chiamate.length = 0
  assert.deepEqual((await giro(crons)).map((e) => e.azione), ['invariato', 'invariato'])
  assert.equal(s.chiamate.filter(([m]) => m.startsWith('slackLists') || m === 'files.list').length, 0)

  // Un cron fallisce: UNA chiamata con le sole celle cambiate (stato e dettagli; l'ora è la stessa).
  const rotto = crons.map((c, i) => (i === 1 ? { ...c, runs: [{ outcome: 'failed', exitCode: 3, startedAt: Date.parse('2026-10-03T11:00:00Z'), durationMs: 240_000 }] } : c))
  s.chiamate.length = 0
  const [, el] = await giro(rotto)
  assert.equal(el.azione, 'aggiornata')
  assert.deepEqual(scritture(s).map(([m]) => m), ['slackLists.items.update'])
  assert.deepEqual(scritture(s)[0][1].cells.map((c) => c.select?.[0] ?? c.rich_text?.[0]?.elements[0].elements[0].text), ['crit', 'exit 3'])

  // Un cron nuovo e uno sparito: una riga creata, una tolta, le altre ferme.
  s.chiamate.length = 0
  await giro([rotto[1], rotto[2], cron('production', 'acme-production-cron-c')])
  assert.deepEqual(scritture(s).map(([m]) => m).sort(), ['slackLists.items.create', 'slackLists.items.delete'])
  assert.deepEqual(righeLista(lista).map((r) => `${r.cron}|${r.ambiente}`), ['b|produzione', 'a|staging', 'c|produzione'])

  // Un ambiente senza nessun cron è una lettura andata male: le sue righe restano.
  s.chiamate.length = 0
  await giro([rotto[1], cron('production', 'acme-production-cron-c')])
  assert.equal(scritture(s).length, 0)
})

test('aggiornaCorse con le List: dopo un riavvio la ritrova, cancellata a mano la ricrea, le righe nuove hanno un tetto per giro', async () => {
  const s = slackFinto()
  const cfg = corseConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'xoxb-finto', DADAGUARD_CORSE_CANALI: 'tutti=C0TUTTI,data=C0DATA', DADAGUARD_QUADRO_SQUADRE: 'data=worker-*' })
  const crons = ['a', 'b', 'c', 'worker-d', 'worker-e'].map((n) => cron('production', `acme-production-cron-${n}`))
  const leggi = async () => ({ overview: { window: 1440, crons: [...crons], problems: [] }, etichette: { production: 'production' } })
  const giro = (liste, maxRigheNuove) => aggiornaCorse(cfg, { api: s.api, scarica: s.scarica, leggiDati: leggi, ora: ORA, liste, maxRigheNuove })

  // Il tetto vale per giro in tutte le List insieme: la prima si prende il budget, la seconda aspetta.
  const memoria = nuovaMemoriaListe()
  const primo = (await giro(memoria, 4)).filter((e) => e.ambiente.startsWith('corse-lista-'))
  assert.deepEqual(primo.map((e) => `${e.ambiente}:${e.nuove}+${e.restano}`), ['corse-lista-tutti:4+1', 'corse-lista-data:0+2'])
  await giro(memoria, 4)
  assert.deepEqual([...s.liste.values()].map((l) => `${l.titolo}:${l.righe.size}`), ['Lista corse cron TUTTI:5', 'Lista corse cron DATA:2'])
  assert.ok(MAX_RIGHE_NUOVE_CORSE >= 20)

  // Riavvio: memoria vuota. Le List si ritrovano dal titolo e dal canale, nessuna riga nuova né cella.
  s.chiamate.length = 0
  const dopo = (await giro(nuovaMemoriaListe())).filter((e) => e.ambiente.startsWith('corse-lista-'))
  assert.deepEqual(dopo.map((e) => e.azione), ['invariato', 'invariato'])
  assert.equal(scritture(s).length, 0, 'le firme rilette tornano con quelle calcolate')

  // Cancellata a mano: il primo giro che ci scrive sbaglia sull'id che aveva e butta la memoria, il
  // secondo non la ritrova fra i file del bot e la ricrea, con tutte le righe.
  const vecchia = [...s.liste.values()].find((l) => l.titolo === 'Lista corse cron DATA')
  s.liste.delete(vecchia.id)
  crons[4] = { ...crons[4], runs: [{ outcome: 'failed', exitCode: 1, startedAt: ORA - 1000 }] }
  const rotta = (await giro(memoria)).find((e) => e.ambiente === 'corse-lista-data')
  assert.equal(rotta.azione, 'errore')
  const rifatta = (await giro(memoria)).find((e) => e.ambiente === 'corse-lista-data')
  assert.equal(rifatta.azione, 'creata')
  const rinata = [...s.liste.values()].find((l) => l.titolo === 'Lista corse cron DATA')
  assert.notEqual(rinata.id, vecchia.id)
  assert.deepEqual(righeLista(rinata).map((r) => `${r.cron}|${r.stato}`), ['worker-d|ok', 'worker-e|crit'])
})
