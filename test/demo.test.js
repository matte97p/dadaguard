import { test } from 'node:test'
import assert from 'node:assert/strict'
import { demoStatus, demoCosts, demoCostTrend, demoBudgets, demoQuotas, demoLogs, demoEvents, demoTopology } from '../server/demo.js'
import { budgetLevel } from '../server/budgets.js'

const ymdOf = (d) => d.toISOString().slice(0, 10)

test('demoStatus: forma valida + ogni check ha uno status', () => {
  const s = demoStatus('it')
  assert.equal(s.mode, 'demo')
  assert.equal(s.capabilities.watchlist, false)
  assert.ok(s.services.length >= 8)
  for (const svc of s.services) {
    assert.ok(svc.name && svc.account?.key && svc.overall, `servizio incompleto: ${svc.name}`)
    assert.ok(Object.keys(svc.checks).length > 0)
    for (const c of Object.values(svc.checks)) assert.ok(c.status, `check senza status in ${svc.name}`)
  }
})

test('demoStatus: copre tutti gli stati chiave (up/degraded/down/disabled)', () => {
  const states = new Set(demoStatus('en').services.map((x) => x.overall))
  for (const st of ['up', 'degraded', 'down', 'disabled']) {
    assert.ok(states.has(st), `la flotta demo non copre lo stato ${st}`)
  }
})

test('demoStatus: bilingue it/en', () => {
  const it = demoStatus('it').services.find((s) => s.name === 'nightly-report').checks.runtime.summary
  const en = demoStatus('en').services.find((s) => s.name === 'nightly-report').checks.runtime.summary
  assert.notEqual(it, en)
})

test('demo drawer: forme coerenti', () => {
  assert.ok(demoCosts().prod.items.length > 0)
  assert.ok(demoQuotas().accounts[0].quotas.length > 0)
  assert.ok(demoLogs().events.length > 0)
  assert.ok(demoEvents().events.length > 0)
})

test('demo costi: periodo, trend e anomalie stanno nel mese che la pagina dichiara', () => {
  const now = new Date()
  const mese = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  for (const [acc, a] of Object.entries(demoCosts())) {
    assert.ok(a.period.start.startsWith(mese), `${acc}: il periodo non è del mese corrente (${a.period.start})`)
    assert.ok(a.period.end <= ymdOf(new Date(now.getTime() + 86_400_000)), `${acc}: MTD che copre giorni futuri (${a.period.end})`)
  }
  const ultimo = demoCostTrend().prod.months.at(-1)
  assert.equal(ultimo.month, mese, 'il trend non finisce col mese corrente')
  assert.ok(ultimo.partial, 'il mese in corso deve essere marcato parziale')
  for (const an of demoBudgets().anomalies) {
    assert.ok(an.start.slice(0, 10) <= ymdOf(now), `anomalia nel futuro: ${an.start}`)
  }
})

test('demo budget: proiezione e livello escono dallo stesso ritmo dei costi, non da cifre a mano', () => {
  const costi = demoCosts()
  const rate = costi.prod.projection.daysInMonth / costi.prod.projection.daysElapsed
  const tutti = Object.values(demoBudgets().accounts).flatMap((a) => a.budgets)
  for (const b of tutti.filter((x) => x.timeUnit === 'MONTHLY')) {
    assert.ok(Math.abs(b.forecast - b.actual * rate) < 0.01, `${b.name}: proiezione scollegata dal run-rate`)
  }
  for (const b of tutti) {
    assert.equal(b.level, budgetLevel(b), `${b.name}: il badge non segue le sue percentuali`)
  }
  // Il lordo demo è la scala di riferimento: un budget d'organizzazione che non la vede era il difetto
  // di prima (4380 $ dichiarati su un lordo di 837,60 $).
  const lordo = Object.values(costi).reduce((s, a) => s + a.gross, 0)
  const org = tutti.find((b) => b.name === 'org-monthly')
  assert.ok(Math.abs(org.actual - lordo) < 0.01, 'org-monthly non misura la spesa demo')
  // La demo deve mostrare tutti e quattro gli stati, o metà del pannello non si vede mai.
  for (const lvl of ['over', 'willOver', 'warn', 'ok']) {
    assert.ok(tutti.some((b) => b.level === lvl), `nessun budget demo in stato ${lvl}`)
  }
})

test('demoTopology: ogni arco punta a un servizio reale o a un extraNode', () => {
  const { edges, extraNodes } = demoTopology()
  const names = new Set(demoStatus('en').services.map((s) => s.name))
  const extraIds = new Set(extraNodes.map((n) => n.id))
  const known = (id) => names.has(id) || extraIds.has(id)
  for (const e of edges) {
    assert.ok(known(e.source), `arco da servizio inesistente: ${e.source}`)
    assert.ok(known(e.target), `arco verso nodo inesistente: ${e.target}`)
    assert.ok(e.vias?.length, `arco senza provenienza: ${e.source}->${e.target}`)
  }
  // la demo deve esercitare tutte le provenienze, legenda inclusa
  const vias = new Set(edges.flatMap((e) => e.vias))
  for (const v of ['declared', 'env', 'event', 'flow', 'iam', 'lb', 'net']) {
    assert.ok(vias.has(v), `la topologia demo non copre la provenienza ${v}`)
  }
})
