import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cosaSuccede, controlliDi, contaChip, passaChip, linkAltrove, sloDi, pct, diChi } from '../web/servizi.js'

// Le regole della pagina Servizi: cosa dice una riga, quali controlli, quali link. Tolleranti ai
// campi che il server non manda ancora.

test('cosaSuccede: vince il dettaglio del server, poi il controllo colpevole', () => {
  assert.equal(cosaSuccede({ dettaglio: 'manca un segreto', checks: { runtime: { summary: 'x' } } }), 'manca un segreto')
  assert.equal(cosaSuccede({ cause: 'liveness', checks: { liveness: { summary: 'HTTP 502' }, runtime: { summary: 'ok' } } }), 'HTTP 502')
  assert.equal(cosaSuccede({ checks: { runtime: { summary: '2/2 istanze' } } }), '2/2 istanze')
  assert.equal(cosaSuccede({}), null)
})

test('controlliDi: ordine fisso, un controllo non letto resta grigio', () => {
  const c = controlliDi({ checks: { runtime: { status: 'down' }, liveness: { status: 'up' }, drift: { status: 'unknown' } } })
  assert.deepEqual(
    c.map((x) => [x.chiave, x.livello]),
    [
      ['liveness', 'ok'],
      ['runtime', 'crit'],
      ['drift', 'off'],
    ],
  )
})

test('chip: problemi = rossi e arancio, spenti = grigi', () => {
  const s = [{ overall: 'down' }, { overall: 'degraded' }, { overall: 'up' }, { overall: 'disabled' }]
  assert.deepEqual(contaChip(s), { problemi: 2, tutti: 4, spenti: 1 })
  assert.equal(passaChip({ livello: 'warn' }, 'problemi'), true)
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
