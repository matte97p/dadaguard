import { test } from 'node:test'
import assert from 'node:assert/strict'
import { andamentoAudit, passoAndamento, FASCE_MAX } from '../server/teleport.js'
import { demoTeleport } from '../server/demo.js'
import { daSistemare, numeriAccessi, passoDetto, proprietariMacchine } from '../web/accessi.js'
import { readFileSync } from 'node:fs'

const { makeT } = await import(
  'data:text/javascript,' + encodeURIComponent(readFileSync(new URL('../web/i18n.jsx', import.meta.url), 'utf8'))
)

// Il cruscotto della pagina Accessi (07/10/2026): le fasce dell'audit (`andamentoAudit`), i cinque
// numeri e il loro colore. Le prove difendono tre cose: le fasce sono quante si leggono e di una misura
// che si dice a voce, uno zero dell'audit e' un fatto ma una fascia fuori dal campione e' «non lo so»,
// e il colore di una tessera e' quello della voce di «da sistemare», non un'altra regola.

const ADESSO = Date.UTC(2026, 9, 7, 12, 0, 0)
const MIN = 60_000
const ORA = 60 * MIN

test('passoAndamento: fino a 36 fasce, di una misura tonda', () => {
  assert.equal(passoAndamento(1), 2 * MIN)
  assert.equal(passoAndamento(6), 10 * MIN)
  assert.equal(passoAndamento(24), ORA)
  assert.equal(passoAndamento(168), 6 * ORA)
  for (const o of [1, 6, 24, 168]) assert.ok((o * ORA) / passoAndamento(o) <= FASCE_MAX)
})

test('andamentoAudit: conteggi per fascia, le persone diverse, e le scritture in prod a parte', () => {
  const e = (fa, tipo, utente, extra = {}) => ({ quando: ADESSO - fa, tipo, utente, ...extra })
  const a = andamentoAudit(
    [
      e(1 * MIN, 'login-fallita', 'sam'),
      e(1.5 * MIN, 'login-fallita', 'sam'),
      e(1 * MIN, 'negato', 'lee'),
      e(30 * MIN, 'scrittura', 'kim', { prod: true }),
      e(30 * MIN, 'scrittura', 'kim', { prod: false }),
      e(50 * MIN, 'ssh', 'rin'),
      e(50 * MIN, 'query', 'alex'),
      // Fuori dalla finestra: non conta.
      e(3 * ORA, 'login-fallita', 'sam'),
    ],
    { adesso: ADESSO, ore: 1 },
  )
  assert.equal(a.punti, 30)
  assert.equal(a.passoMs, 2 * MIN)
  const tot = (k) => a[k].reduce((n, v) => n + v, 0)
  assert.equal(tot('loginFallite'), 2)
  assert.equal(tot('negati'), 1)
  assert.equal(tot('scritture'), 2)
  assert.equal(tot('scrittureProd'), 1)
  assert.equal(tot('ssh'), 1)
  // Le due login fallite e il negato stanno nella stessa fascia (la penultima: l'ultima e' quella
  // appena cominciata): due persone diverse, non tre.
  assert.equal(a.persone.at(-2), 2)
  assert.equal(a.troncato, false)
  assert.ok(a.loginFallite.every((v) => v !== null))
})

test('andamentoAudit: al tetto le fasce prima del primo evento letto sono null, non zero', () => {
  const a = andamentoAudit([{ quando: ADESSO - 10 * MIN, tipo: 'ssh', utente: 'rin' }], { adesso: ADESSO, ore: 1, troncato: true })
  const k = a.ssh.findIndex((v) => v != null)
  assert.ok(k > 20)
  assert.ok(a.ssh.slice(0, k).every((v) => v === null))
  assert.ok(a.persone.slice(0, k).every((v) => v === null))
  assert.equal(a.troncato, true)
})

test('demo: le fasce sommano ai totali delle tessere, in ogni finestra', () => {
  for (const ore of [1, 6, 24, 168]) {
    const { audit } = demoTeleport(ore)
    const tot = (k) => audit.andamento[k].reduce((n, v) => n + (v ?? 0), 0)
    assert.equal(tot('loginFallite'), audit.loginFallite, `${ore}h login`)
    assert.equal(tot('negati'), audit.sessioniDbNegate, `${ore}h negati`)
    const prod = audit.database.filter((d) => d.ambiente === 'prod').reduce((n, d) => n + d.scritture, 0)
    assert.equal(tot('scrittureProd'), prod, `${ore}h prod`)
    assert.equal(tot('ssh'), audit.sessioniSsh, `${ore}h ssh`)
  }
})

test('numeriAccessi: il colore della tessera e la voce piu grave di quel tipo, e senza voce resta grigia', () => {
  const dati = demoTeleport(1)
  const voci = daSistemare(dati.audit, { proprietari: proprietariMacchine(dati.heartbeat) })
  const n = Object.fromEntries(numeriAccessi(dati.audit, voci).map((x) => [x.k, x]))
  assert.equal(n.loginFallite.valore, 4)
  assert.equal(n.loginFallite.livello, 'crit')
  assert.equal(n.scritture.valore, 2)
  assert.equal(n.scritture.livello, 'crit')
  assert.equal(n.ssh.valore, 1)
  assert.equal(n.negati.valore, 2)
  assert.equal(n.negati.livello, 'warn')
  assert.equal(n.persone.livello, null)
  assert.equal(n.persone.forma, 'linea')
  // Tre scritture su staging e nessuna voce: il numero si legge, ma non chiama.
  const staging = numeriAccessi({ database: [{ ambiente: 'staging', scritture: 3 }], persone: [] }, [])
  assert.equal(staging.find((x) => x.k === 'scritture').valore, 0)
  assert.equal(staging.find((x) => x.k === 'scritture').livello, null)
  // Un audit che non e' arrivato: «non lo so», non zero.
  assert.equal(numeriAccessi({}, []).find((x) => x.k === 'loginFallite').valore, null)
})

test('passoDetto: la fascia detta a voce, in italiano e in inglese', () => {
  const it = makeT('it')
  const en = makeT('en')
  assert.equal(passoDetto(2 * MIN, it), '2 min')
  assert.equal(passoDetto(ORA, it), '1 ora')
  assert.equal(passoDetto(6 * ORA, en), '6 hours')
  assert.equal(passoDetto(null, it), '')
})
