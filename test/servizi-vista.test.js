import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cosaSuccede,
  controlliDi,
  conProblemi,
  passaFiltri,
  opzioniTipo,
  opzioniStato,
  vociChip,
  chipAttivo,
  premiChip,
  quanteTendine,
  linkAltrove,
  sloDi,
  pct,
  diChi,
} from '../web/servizi.js'

// Le regole della pagina Servizi: cosa dice una riga, quali controlli, quali link. Tolleranti ai
// campi che il server non manda ancora.

test('cosaSuccede: vince il dettaglio del server, poi il controllo colpevole', () => {
  assert.equal(cosaSuccede({ dettaglio: 'manca un segreto', checks: { runtime: { summary: 'x' } } }), 'manca un segreto')
  assert.equal(cosaSuccede({ cause: 'liveness', checks: { liveness: { summary: 'HTTP 502' }, runtime: { summary: 'ok' } } }), 'HTTP 502')
  assert.equal(cosaSuccede({ checks: { runtime: { summary: '2/2 istanze' } } }), '2/2 istanze')
  assert.equal(cosaSuccede({}), null)
})

test('controlliDi: ordine fisso, il livello lo dice il server, senza livello resta grigio', () => {
  const c = controlliDi({ checks: { runtime: { status: 'down', livello: 'crit' }, liveness: { status: 'up', livello: 'ok' }, drift: { status: 'unknown' } } })
  assert.deepEqual(
    c.map((x) => [x.chiave, x.livello]),
    [
      ['liveness', 'ok'],
      ['runtime', 'crit'],
      ['drift', 'off'],
    ],
  )
})

// Una flotta piccola con un po' di tutto: e' quella su cui si provano tendine e chip insieme.
const FLOTTA = [
  { name: 'api', type: 'ecs', overall: 'down', livello: 'crit', region: 'eu-west-1', account: { key: 'production' }, managed: true },
  { name: 'worker', type: 'lambda', overall: 'up', livello: 'warn', region: 'eu-west-1', account: { key: 'production' }, managed: false },
  { name: 'nightly', type: 'lambda', overall: 'disabled', livello: 'off', region: 'eu-west-1', account: { key: 'staging' }, checks: { runtime: { schedule: '1440m' } } },
  { name: 'anthropic.claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', type: 'bedrock', overall: 'idle', livello: 'off', region: 'us-east-1', account: { key: 'production' } },
]
const nomi = (f, o) => FLOTTA.filter((s) => passaFiltri(s, f, o)).map((s) => s.name)

test('conProblemi: rossi e arancio, come il verdetto, anche se `overall` dice su', () => {
  assert.deepEqual(FLOTTA.filter(conProblemi).map((s) => s.name), ['api', 'worker'])
})

test('passaFiltri: senza filtri passa tutto, e ogni tendina restringe', () => {
  assert.equal(nomi({}).length, 4)
  assert.deepEqual(nomi({ typeFilter: ['bedrock'] }), ['anthropic.claude-sonnet-4-5'])
  assert.deepEqual(nomi({ statusFilter: ['down', 'disabled'] }), ['api', 'nightly'])
  assert.deepEqual(nomi({ accountFilter: ['staging'] }), ['nightly'])
  assert.deepEqual(nomi({ regionFilter: ['us-east-1'] }), ['anthropic.claude-sonnet-4-5'])
  assert.deepEqual(nomi({ scheduleFilter: 'cron' }), ['nightly'])
  assert.deepEqual(nomi({ scheduleFilter: 'ondemand' }).length, 3)
  // Terraform: «non gestito» e' `false`, non «non si sa» (`managed` assente non passa nessuno dei due).
  assert.deepEqual(nomi({ managedFilter: 'managed' }), ['api'])
  assert.deepEqual(nomi({ managedFilter: 'unmanaged' }), ['worker'])
  assert.deepEqual(nomi({ problemsOnly: true }), ['api', 'worker'])
})

test('passaFiltri: «bedrock» nella ricerca trova i modelli, che nel nome non lo dicono', () => {
  assert.deepEqual(nomi({ nameQuery: 'bedrock' }), ['anthropic.claude-sonnet-4-5'])
  assert.deepEqual(nomi({ nameQuery: 'sonnet' }), ['anthropic.claude-sonnet-4-5'])
})

test('passaFiltri conStato:false ignora stato e problemi ma tiene il resto (base dei chip)', () => {
  assert.deepEqual(nomi({ statusFilter: ['down'], problemsOnly: true, typeFilter: ['lambda'] }, { conStato: false }), ['worker', 'nightly'])
})

test('opzioniTipo: solo i tipi presenti, Bedrock compreso, con l etichetta tradotta', () => {
  const t = (k) => ({ 'type.bedrock': 'Bedrock', 'type.lambda': 'Lambda' })[k] ?? k
  assert.deepEqual(opzioniTipo(FLOTTA, t), [
    { value: 'bedrock', label: 'Bedrock' },
    { value: 'ecs', label: 'ecs' },
    { value: 'lambda', label: 'Lambda' },
  ])
})

test('opzioniStato: dal peggio, solo gli stati presenti', () => {
  assert.deepEqual(
    opzioniStato(FLOTTA).map((o) => o.value),
    ['down', 'idle', 'disabled', 'up'],
  )
})

test('vociChip: con problemi, tutti, poi uno per stato col suo conteggio', () => {
  assert.deepEqual(
    vociChip(FLOTTA).map((v) => [v.key, v.n]),
    [
      ['problemi', 2],
      ['tutti', 4],
      ['down', 1],
      ['idle', 1],
      ['disabled', 1],
      ['up', 1],
    ],
  )
})

test('chipAttivo: un chip solo quando un chip solo rappresenta il filtro', () => {
  assert.equal(chipAttivo({}), 'tutti')
  assert.equal(chipAttivo({ problemsOnly: true }), 'problemi')
  assert.equal(chipAttivo({ statusFilter: ['down'] }), 'down')
  // Due stati dalla tendina, o uno stato piu' «con problemi»: nessun chip premuto, «Tutti» mentirebbe.
  assert.equal(chipAttivo({ statusFilter: ['down', 'idle'] }), '')
  assert.equal(chipAttivo({ statusFilter: ['down'], problemsOnly: true }), '')
})

test('premiChip: scrive gli stessi filtri della tendina, ripremere torna a Tutti', () => {
  assert.deepEqual(premiChip('down', {}), { statusFilter: ['down'], problemsOnly: false })
  assert.deepEqual(premiChip('down', { statusFilter: ['down'] }), { statusFilter: [], problemsOnly: false })
  assert.deepEqual(premiChip('problemi', { statusFilter: ['idle', 'up'] }), { statusFilter: [], problemsOnly: true })
  assert.deepEqual(premiChip('problemi', { problemsOnly: true }), { statusFilter: [], problemsOnly: false })
  assert.deepEqual(premiChip('idle', { problemsOnly: true }), { statusFilter: ['idle'], problemsOnly: false })
  assert.deepEqual(premiChip('tutti', { statusFilter: ['down'], problemsOnly: true }), { statusFilter: [], problemsOnly: false })
})

test('quanteTendine: conta le tendine scelte, non la ricerca ne i chip di problemi', () => {
  assert.equal(quanteTendine({ scheduleFilter: 'all', managedFilter: 'all' }), 0)
  assert.equal(quanteTendine({ typeFilter: ['bedrock'], accountFilter: ['production'], scheduleFilter: 'cron', nameQuery: 'x', problemsOnly: true }), 3)
  assert.equal(quanteTendine({ statusFilter: ['down'], regionFilter: ['eu-west-1'], managedFilter: 'unmanaged' }), 3)
})

test('linkAltrove: link del server tradotti, doppioni tolti, voci senza url saltate', () => {
  const t = (k) => ({ 'svc.altrove.posthog-log': 'Log in PostHog' })[k] ?? k
  const l = linkAltrove({ altrove: [{ chiave: 'posthog-log', url: 'https://x/a', filtro: 'ultima ora' }, { chiave: 'nuovo', url: null }], links: { Console: 'https://x/a' } }, t)
  assert.deepEqual(l, [{ label: 'Log in PostHog', href: 'https://x/a', nota: 'ultima ora' }])
})

test('sloDi: margine sforato e rosso, sotto il 30% arancio, senza obiettivo niente', () => {
  assert.equal(sloDi({}), null)
  assert.equal(sloDi({ budgetErrore: { obiettivo: 0.999, rimasto: -0.2, disponibilita: 0.998 } }).livello, 'crit')
  assert.equal(sloDi({ budgetErrore: { obiettivo: 0.999, rimasto: 0.2 } }).livello, 'warn')
  assert.equal(sloDi({ slo: 0.995 }).rimasto, null)
  assert.equal(pct(0.999, 'it', 2), '99,9')
  assert.equal(pct(0.995, 'en', 2), '99.5')
})

test('diChi: senza team, canale e runbook la sezione non c e', () => {
  assert.equal(diChi({}), null)
  assert.deepEqual(diChi({ team: 'pagamenti', slack: '#pagamenti' }), { team: 'pagamenti', slack: '#pagamenti', runbook: null })
})
