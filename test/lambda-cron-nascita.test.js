import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lambdaRuntime } from '../server/runtime/lambda.js'
import { makeT } from '../server/i18n.js'

// Una cron appena creata non ha ancora avuto il suo primo orario: zero invocazioni li' non sono un
// giro saltato. Prima suonava GIU' fra l'apply e il primo scatto dello schedule.

const t = makeT('it')
const ORA = 60 * 60 * 1000
const zero = async () => ({ inv: 0, err: 0, thr: 0, dur: 0 })
const cron = (nata, m = zero) =>
  lambdaRuntime(
    { function: 'rossi-dev-digest', schedule: '1h', scheduleExpr: 'cron(0 * * * ? *)' },
    {},
    { metricValues: m, t, lambdaCreatedAt: async () => nata },
  )

test('cron nata dopo il giro atteso: a riposo, non giu', async () => {
  const r = await cron(Date.now() - 60 * 1000)
  assert.equal(r.status, 'idle')
  assert.equal(r.outcome, 'ok')
  assert.match(r.summary, /primo giro non è ancora arrivato/)
})

test('cron nata prima del giro atteso, e mai partita: giu come prima', async () => {
  const r = await cron(Date.now() - 3 * ORA)
  assert.equal(r.status, 'down')
  assert.equal(r.outcome, 'missed')
})

test('nascita sconosciuta: il check resta quello di prima', async () => {
  const r = await cron(null)
  assert.equal(r.status, 'down')
  assert.equal(r.outcome, 'missed')
})

test('con invocazioni la nascita non si chiede nemmeno', async () => {
  let chiesta = false
  const r = await lambdaRuntime(
    { function: 'rossi-dev-digest', schedule: '1h', scheduleExpr: 'cron(0 * * * ? *)' },
    {},
    {
      metricValues: async () => ({ inv: 1, err: 0, thr: 0, dur: 0 }),
      t,
      lambdaCreatedAt: async () => {
        chiesta = true
        return Date.now()
      },
    },
  )
  assert.equal(r.status, 'up')
  assert.equal(chiesta, false)
})
