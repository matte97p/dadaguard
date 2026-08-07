// I costi sono il posto dove un pannello mente più facilmente: i crediti sono REGISTRAZIONI negative,
// non uno sconto, e le tasse si addebitano SOPRA il consumo. Sommare tutto dà "AWS è gratis" oppure un
// consumo gonfiato. Qui si fissano le tre voci separate, il trend e l'attribuzione per tag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateMonth,
  aggregateTrend,
  aggregateComponents,
  isAiService,
  trendRange,
  notCreditsOrTax,
  monthRange,
  buildFilter,
  aggregateCategories,
} from '../server/costs.js'
import { mergeTrend } from '../web/format.js'

const g = (keys, amount) => ({ Keys: keys, Metrics: { UnblendedCost: { Amount: String(amount) } } })
const near = (a, b) => Math.abs(a - b) < 0.001

test('consumo, tasse e crediti restano tre voci distinte', () => {
  const out = aggregateMonth([
    g(['Amazon RDS', 'Usage'], 100),
    g(['Amazon S3', 'Usage'], 20),
    g(['Amazon RDS', 'Tax'], 5),
    g(['', 'Credit'], -110),
  ])
  assert.equal(out.gross, 120) // consumo a listino: le tasse NON sono dentro
  assert.equal(out.tax, 5)
  assert.equal(out.credits, -110)
  assert.equal(out.total, 15) // 120 + 5 − 110 = quanto paghi davvero
  // e la tassa non si è travestita da consumo di RDS
  assert.equal(out.items.find((i) => i.service === 'Amazon RDS').amount, 100)
})

test('un rimborso conta come credito, non come consumo negativo', () => {
  const out = aggregateMonth([g(['Amazon RDS', 'Usage'], 50), g(['Amazon RDS', 'Refund'], -10)])
  assert.equal(out.gross, 50)
  assert.equal(out.credits, -10)
  assert.equal(out.total, 40)
})

test('AI separata: Bedrock e Marketplace, non "un servizio come gli altri"', () => {
  assert.equal(isAiService('Amazon Bedrock'), true)
  assert.equal(isAiService('AWS Marketplace'), true) // i modelli Claude sono fatturati qui
  assert.equal(isAiService('Amazon RDS'), false)
  const out = aggregateMonth([
    g(['Amazon Bedrock', 'Usage'], 700),
    g(['AWS Marketplace', 'Usage'], 100),
    g(['Amazon RDS', 'Usage'], 200),
  ])
  assert.equal(out.aiGross, 800)
  assert.equal(out.infraGross, 200) // senza separarle, l'infra sembrerebbe cresciuta di 5 volte
  assert.equal(out.gross, 1000)
})

test('ogni riga dice se è AI, così il totale viola si verifica riga per riga', () => {
  // Su Cost Explorer i modelli arrivano col loro nome, non come "Bedrock": la riga esisteva già,
  // mancava solo dire quale alimenta il numero AI in cima.
  const out = aggregateMonth([
    g(['Claude Opus 5 (Amazon Bedrock Edition)', 'Usage'], 300),
    g(['Amazon RDS', 'Usage'], 50),
  ])
  const byService = Object.fromEntries(out.items.map((i) => [i.service, i.ai]))
  assert.equal(byService['Claude Opus 5 (Amazon Bedrock Edition)'], true)
  assert.equal(byService['Amazon RDS'], false)
  // Il marcatore non è una seconda regola: somma le stesse righe del totale.
  const flagged = out.items.filter((i) => i.ai).reduce((s, i) => s + i.amount, 0)
  assert.equal(flagged, out.aiGross)
})

test('gli importi sotto il mezzo centesimo non fanno righe', () => {
  const out = aggregateMonth([g(['Amazon RDS', 'Usage'], 10), g(['AWS KMS', 'Usage'], 0.001)])
  assert.equal(out.items.length, 1)
})

test('trendRange: `months` mesi che finiscono col mese corrente, End esclusivo', () => {
  const r = trendRange(new Date('2026-07-28T10:00:00Z'), 13)
  assert.equal(r.start, '2025-07-01') // 13 mesi indietro, incluso luglio 2026
  assert.equal(r.end, '2026-08-01') // primo del mese successivo
  const short = trendRange(new Date('2026-01-15T00:00:00Z'), 3)
  assert.equal(short.start, '2025-11-01') // attraversa il cambio d'anno
  assert.equal(short.end, '2026-02-01')
})

test('il mese in corso è marcato PARZIALE: senza, l’ultimo punto sembra un crollo', () => {
  const rows = aggregateTrend(
    [
      { TimePeriod: { Start: '2026-06-01' }, Groups: [g(['Amazon RDS', 'Usage'], 1000)] },
      { TimePeriod: { Start: '2026-07-01' }, Groups: [g(['Amazon RDS', 'Usage'], 300)] },
    ],
    '2026-07',
  )
  assert.equal(rows[0].partial, false)
  assert.equal(rows[1].partial, true)
  assert.equal(rows[0].month, '2026-06')
})

test('trend: fatturato = consumo + tasse + crediti, mese per mese', () => {
  const rows = aggregateTrend([
    {
      TimePeriod: { Start: '2026-06-01' },
      Groups: [g(['Amazon Bedrock', 'Usage'], 700), g(['Amazon RDS', 'Usage'], 300), g(['', 'Credit'], -900)],
    },
  ])
  assert.equal(rows[0].usage, 1000)
  assert.equal(rows[0].aiUsage, 700)
  assert.equal(rows[0].infraUsage, 300)
  assert.equal(rows[0].invoiced, 100)
})

test('componenti: il tag si spoglia del prefisso, il non-taggato NON si nasconde', () => {
  const out = aggregateComponents(
    [
      g(['component$avvista-db', 'Amazon RDS'], 141),
      g(['component$avvista-db', 'Amazon S3'], 7),
      g(['component$', 'EC2 - Other'], 31), // nessun tag sulla risorsa
      g(['component$teleport', 'Amazon Elastic Load Balancing'], 10),
    ],
    'component',
  )
  assert.deepEqual(
    out.map((c) => c.component),
    ['avvista-db', null, 'teleport'], // ordinati per spesa; `null` = non taggato, resta in lista
  )
  assert.ok(near(out[0].amount, 148))
  assert.deepEqual(out[0].services.map((s) => s.service), ['Amazon RDS', 'Amazon S3'])
})

test('la query dei componenti esclude crediti e tasse, e rispetta il filtro account', () => {
  // Con due soli raggruppamenti ammessi ([TAG, SERVICE]) il tipo di record non arriva: se non lo
  // escludesse la query, un credito negativo verrebbe attribuito a un componente a caso.
  const solo = notCreditsOrTax(undefined)
  assert.deepEqual(solo.Not.Dimensions.Values, ['Credit', 'Refund', 'Tax'])
  const conAccount = notCreditsOrTax({ Dimensions: { Key: 'LINKED_ACCOUNT', Values: ['1'] } })
  assert.equal(conAccount.And.length, 2) // `And` vuole almeno due termini
})

test('monthRange non chiede date future per il mese in corso', () => {
  const r = monthRange('2026-07', new Date('2026-07-28T10:00:00Z'))
  assert.equal(r.start, '2026-07-01')
  assert.equal(r.end, '2026-07-29') // domani, non il primo di agosto
})

test('mergeTrend: somma gli account, e un mese parziale per uno resta parziale per tutti', () => {
  const merged = mergeTrend([
    { months: [{ month: '2026-06', usage: 100, invoiced: 10, aiUsage: 60 }, { month: '2026-07', usage: 50, invoiced: 5, aiUsage: 30, partial: true }] },
    { months: [{ month: '2026-06', usage: 20, invoiced: 2, aiUsage: 0 }, { month: '2026-07', usage: 8, invoiced: 1, aiUsage: 0, partial: true }] },
  ])
  assert.deepEqual(merged.map((m) => m.month), ['2026-06', '2026-07'])
  assert.equal(merged[0].usage, 120)
  assert.equal(merged[0].infraUsage, 60) // 100−60 + 20−0
  assert.equal(merged[1].partial, true)
})

test('buildFilter: zero termini = nessun filtro, uno = nudo, due = And', () => {
  // Un `And` di un solo elemento è un errore di validazione di Cost Explorer, non un filtro più
  // semplice: la forma va scelta in base a quanti termini ci sono davvero.
  assert.equal(buildFilter({}), undefined)
  assert.deepEqual(buildFilter({ accountId: '1' }), { Dimensions: { Key: 'LINKED_ACCOUNT', Values: ['1'] } })
  const due = buildFilter({ accountId: '1', type: 'database' })
  assert.equal(due.And.length, 2)
  assert.deepEqual(due.And[1], { CostCategories: { Key: 'Livello', Values: ['database'] } })
  assert.equal(buildFilter({ accountId: '1', type: 'database', onlyUsage: true }).And.length, 3)
})

test('buildFilter: "all" e il non-categorizzato non diventano un filtro', () => {
  // 'all' = nessuna scelta; '__none__' (non categorizzato) non si esprime come filtro — `Values: ['']`
  // non seleziona nulla — quindi lo si guarda dalla ripartizione, non filtrando.
  assert.equal(buildFilter({ type: 'all' }), undefined)
  assert.equal(buildFilter({ type: '__none__' }), undefined)
  assert.equal(buildFilter({ type: '' }), undefined)
})

test('aggregateCategories: livelli per spesa, non-categorizzato incluso', () => {
  const out = aggregateCategories(
    [
      g(['Livello$compute', 'Amazon ECS'], 142.3),
      g(['Livello$compute', 'AWS Lambda'], 12.4),
      g(['Livello$', 'Amazon CloudFront'], 9.1),
      g(['Livello$database', 'Amazon RDS'], 88),
    ],
    'Livello',
  )
  assert.deepEqual(
    out.map((c) => c.category),
    ['compute', 'database', null],
  )
  assert.ok(near(out[0].amount, 154.7))
  assert.deepEqual(out[0].services.map((s) => s.service), ['Amazon ECS', 'AWS Lambda'])
})
