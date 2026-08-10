import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VIETATI, ACCOUNT_VIETATI } from './vietati.js'

// Le fixture di contratto sono risposte AWS VERE, e questo repo è PUBBLICO: qualcosa che identifica
// l'infrastruttura di qualcuno non deve entrarci. Il registratore sanifica, ma una regola scritta una
// volta si dimentica — questo test è il guardiano che resta.
//
// Se cade dopo una nuova registrazione: NON allentare il test, aggiungi la regola mancante a
// `sanitize()` in scripts/record-aws-fixtures.mjs e ri-registra.
const DIR = new URL('./fixtures/aws/', import.meta.url).pathname

const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))

test('le fixture registrate esistono (il registratore è stato usato)', () => {
  assert.ok(files.length >= 4, `attese almeno 4 fixture, trovate ${files.length}`)
})

// Una fixture può perdere il suo senso restando valida: `FilterLogEvents` con una finestra diversa
// può tornare una pagina 1 PIENA, e il test di contratto continuerebbe a passare senza provare più
// niente. Le forme che sono il MOTIVO della fixture vanno pretese qui, così una ri-registrazione che
// le perde fallisce a voce alta invece di svuotare i test in silenzio.
test('la forma che conta è ancora nelle fixture (una ri-registrazione non deve svuotarle)', () => {
  const leggi = (n) => JSON.parse(readFileSync(join(DIR, `${n}.json`), 'utf8')).payload
  const p1 = leggi('filter-log-events-page1')
  assert.deepEqual(p1.events, [], 'page1 deve essere LA pagina vuota: è il bug che documenta')
  assert.ok(p1.nextToken, 'page1 deve avere il nextToken: senza, non c’è niente da inseguire')
  const p2 = leggi('filter-log-events-page2')
  assert.ok((p2.events ?? []).length > 0, 'page2 deve contenere il match che page1 non mostrava')

  const s = leggi('get-schedule-timezone')
  assert.ok(s.ScheduleExpressionTimezone, 'lo schedule deve portare un fuso: è il secondo bug')
  assert.notEqual(s.ScheduleExpressionTimezone, 'UTC', 'e non deve essere UTC, altrimenti non prova nulla')

  const m = leggi('get-metric-data-weekday-cron')
  const giorni = new Set(m.MetricDataResults[0].Timestamps.map((t) => new Date(t).getUTCDay()))
  assert.ok(!giorni.has(0) && !giorni.has(6), 'il cron registrato deve essere lun-ven: è il terzo bug')
})

for (const f of files) {
  test(`fixture sanificata: ${f}`, () => {
    const raw = readFileSync(join(DIR, f), 'utf8')
    for (const { re, cosa } of VIETATI) {
      const m = raw.match(re)
      assert.equal(m, null, `${f} contiene ${cosa}: ${m?.[0]}`)
    }
    for (const id of ACCOUNT_VIETATI) {
      assert.ok(!raw.includes(id), `${f} contiene un id account reale (${id})`)
    }
    // ogni fixture dice cosa dimostra: senza la nota, in sei mesi non si capisce perché esiste
    const j = JSON.parse(raw)
    assert.ok(typeof j._nota === 'string' && j._nota.length > 20, `${f} senza _nota che spieghi la forma`)
    assert.ok(j.payload, `${f} senza payload`)
  })
}
