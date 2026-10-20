// La spesa giorno per giorno (Spesa, scheda Andamento): un credito contato come consumo abbassa la
// colonna del servizio, un giorno senza righe che manca dall'asse sembra un buco nei dati, un colore che
// segue la classifica del giorno invece del servizio fa cambiare colore a Bedrock fra lunedi' e martedi',
// e una richiesta senza `accountId` sul payer somma tutta l'org.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer'
import {
  unisciConti,
  ultimi,
  soloServizi,
  totaliGiorno,
  coloriServizi,
  seriePila,
  kpiSpesa,
  tabellaServizi,
  multipliSpesa,
  mediana,
  grigliaGiorni,
  mezzanotte,
  giornoDopo,
  COLORI,
  COLORE_ALTRI,
  ALTRI,
} from '../shared/spesaSerie.js'
import { aggregateDaily, dailyRange, giorniSpesa, getCostDaily, monthEndProjection } from '../server/costs.js'
import { demoCostDaily } from '../server/demo.js'

const gruppo = (servizio, tipo, importo) => ({ Keys: [servizio, tipo], Metrics: { UnblendedCost: { Amount: String(importo) } } })

// Un conto finto: `n` giorni che finiscono `oggi`, un importo al giorno per servizio da una funzione.
function conto(oggi, n, servizi, { crediti = 0 } = {}) {
  const giorni = []
  for (let g = oggi, k = 0; k < n; k++) {
    giorni.unshift(g)
    const d = new Date(`${g}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    g = d.toISOString().slice(0, 10)
  }
  return {
    giorni,
    oggi,
    servizi: Object.entries(servizi).map(([servizio, f]) => ({ servizio, ai: /bedrock/i.test(servizio), valori: giorni.map((g, i) => f(i, g)) })),
    crediti: giorni.map(() => crediti),
    tasse: giorni.map(() => 0),
  }
}

test('finestra: 30 o 90 giorni, e dal primo del mese anche quando il mese è più lungo', () => {
  assert.equal(giorniSpesa('90'), 90)
  assert.equal(giorniSpesa('30'), 30)
  assert.equal(giorniSpesa('7'), 30)
  assert.equal(giorniSpesa('365'), 90, 'un numero libero non diventa una chiave di cache in più')
  assert.equal(giorniSpesa(undefined), 30)
  assert.deepEqual(dailyRange(new Date('2026-10-20T15:00:00Z'), 30), { start: '2026-09-21', end: '2026-10-21' })
  assert.deepEqual(dailyRange(new Date('2026-10-31T15:00:00Z'), 30), { start: '2026-10-01', end: '2026-11-01' }, 'il 31: si parte dal primo, 31 giorni')
  assert.deepEqual(dailyRange(new Date('2026-10-20T15:00:00Z'), 90), { start: '2026-07-23', end: '2026-10-21' })
})

test('aggregateDaily: crediti e tasse fuori dal consumo come nel mese, giorni senza righe a zero', () => {
  const r = aggregateDaily(
    [
      { TimePeriod: { Start: '2026-10-01' }, Groups: [gruppo('Amazon Bedrock', 'Usage', 10), gruppo('Amazon Bedrock', 'Credit', -4), gruppo('Tax', 'Tax', 1), gruppo('Amazon RDS', 'Usage', 2.004)] },
      { TimePeriod: { Start: '2026-10-03' }, Groups: [gruppo('Amazon RDS', 'Usage', 3)] },
    ],
    { start: '2026-10-01', end: '2026-10-04' },
  )
  assert.deepEqual(r.giorni, ['2026-10-01', '2026-10-02', '2026-10-03'], 'il 2 non ha righe e c’è lo stesso')
  assert.deepEqual(r.servizi, [
    { servizio: 'Amazon Bedrock', ai: true, valori: [10, 0, 0] },
    { servizio: 'Amazon RDS', ai: false, valori: [2, 0, 3] },
  ])
  assert.deepEqual(r.crediti, [-4, 0, 0])
  assert.deepEqual(r.tasse, [1, 0, 0])
})

test('getCostDaily: una richiesta DAILY per [SERVICE, RECORD_TYPE], filtrata per account, pagine fuse per giorno', async () => {
  const chiamate = []
  const prima = CostExplorerClient.prototype.send
  CostExplorerClient.prototype.send = async function (cmd) {
    chiamate.push(cmd.input)
    if (!cmd.input.NextPageToken) {
      return { ResultsByTime: [{ TimePeriod: { Start: '2026-10-19' }, Groups: [gruppo('Amazon RDS', 'Usage', 2)] }], NextPageToken: 'p2' }
    }
    return { ResultsByTime: [{ TimePeriod: { Start: '2026-10-19' }, Groups: [gruppo('Amazon Bedrock', 'Usage', 5)] }, { TimePeriod: { Start: '2026-10-20' }, Groups: [gruppo('Amazon Bedrock', 'Usage', 1)] }] }
  }
  try {
    const r = await getCostDaily({ accountId: '111122223333', giorni: 30, now: new Date('2026-10-20T10:00:00Z') })
    assert.equal(chiamate.length, 2, 'una richiesta per pagina, niente di più')
    const q = chiamate[0]
    assert.equal(q.Granularity, 'DAILY')
    assert.deepEqual(q.GroupBy.map((g) => g.Key), ['SERVICE', 'RECORD_TYPE'])
    assert.deepEqual(q.Filter, { Dimensions: { Key: 'LINKED_ACCOUNT', Values: ['111122223333'] } })
    assert.deepEqual(q.TimePeriod, { Start: '2026-09-21', End: '2026-10-21' })
    assert.equal(r.giorni.length, 30)
    assert.equal(r.oggi, '2026-10-20')
    const v = Object.fromEntries(r.servizi.map((s) => [s.servizio, s.valori.slice(-2)]))
    assert.deepEqual(v, { 'Amazon Bedrock': [5, 1], 'Amazon RDS': [2, 0] }, 'il 19 arriva su due pagine e resta un giorno solo')
  } finally {
    CostExplorerClient.prototype.send = prima
  }
})

test('unione degli account: date unite, stesso servizio sommato, oggi il più recente', () => {
  const a = conto('2026-10-20', 3, { 'Amazon RDS': () => 1 }, { crediti: -1 })
  const b = conto('2026-10-20', 2, { 'Amazon RDS': () => 2, 'Amazon S3': () => 0.5 })
  const u = unisciConti([a, b])
  assert.deepEqual(u.giorni, ['2026-10-18', '2026-10-19', '2026-10-20'])
  assert.deepEqual(u.servizi.find((s) => s.servizio === 'Amazon RDS').valori, [1, 3, 3])
  assert.deepEqual(u.servizi.find((s) => s.servizio === 'Amazon S3').valori, [0, 0.5, 0.5])
  assert.deepEqual(u.crediti, [-1, -1, -1])
  assert.equal(u.oggi, '2026-10-20')
  assert.deepEqual(totaliGiorno(u), [1, 3.5, 3.5])
  assert.deepEqual(ultimi(u, 2).giorni, ['2026-10-19', '2026-10-20'])
  const solo = soloServizi(u, ['Amazon S3'])
  assert.deepEqual(solo.servizi.map((s) => s.servizio), ['Amazon S3'])
  assert.deepEqual(solo.crediti, [0, 0, 0], 'i crediti non sono di un servizio: con un filtro spariscono')
})

test('colori: i primi quattro per spesa, il colore segue il servizio anche filtrando', () => {
  const u = conto('2026-10-20', 5, {
    A: () => 50,
    B: () => 40,
    C: () => 30,
    D: () => 20,
    E: (i) => (i === 4 ? 80 : 1), // il piu' caro del giorno 4, ma non della finestra: niente colore
    F: () => 0.5,
  })
  const colori = coloriServizi(u)
  assert.deepEqual([...colori.entries()], [['A', COLORI[0]], ['B', COLORI[1]], ['C', COLORI[2]], ['D', COLORI[3]]])
  const pila = seriePila(u, colori)
  assert.deepEqual(pila.map((p) => p.k), ['A', 'B', 'C', 'D', ALTRI])
  assert.equal(pila.at(-1).colore, COLORE_ALTRI)
  assert.deepEqual(pila.at(-1).valori, [1.5, 1.5, 1.5, 1.5, 80.5])
  assert.equal(pila.at(-1).quanti, 2)
  // Scelto C, C resta del suo colore; scelto E (senza colore), la fetta porta il suo nome, non «Altri».
  assert.deepEqual(seriePila(soloServizi(u, ['C']), colori).map((p) => [p.k, p.colore]), [['C', COLORI[2]]])
  assert.deepEqual(seriePila(soloServizi(u, ['E']), colori).map((p) => [p.k, p.colore]), [['E', COLORE_ALTRI]])
})

test('tessere: mese finora dal primo, proiezione col run-rate del mese, di solito e giorno più caro senza oggi', () => {
  // 25 giorni fino al 10/10: dal 16/09. Ogni giorno 10 $, il 5/10 ne costa 40, oggi (a metà) 2.
  const u = conto('2026-10-10', 25, { 'Amazon RDS': (i, g) => (g === '2026-10-10' ? 2 : g === '2026-10-05' ? 40 : 10) }, { crediti: -1 })
  const k = kpiSpesa(u, 30)
  assert.equal(k.mese.lordo, 9 * 10 + 30 + 2, '1-9 ottobre più il picco del 5 e oggi')
  assert.equal(k.mese.netto, k.mese.lordo - 10, 'dieci giorni di crediti')
  assert.equal(k.mese.giorni, 10)
  assert.equal(k.mese.cumulato.length, 10)
  const atteso = monthEndProjection({ gross: 122, total: 112, period: { start: '2026-10-01', end: '2026-10-11' } })
  assert.equal(k.proiezione.gross, Math.round(atteso.gross * 100) / 100)
  assert.equal(k.proiezione.daysElapsed, 10)
  assert.equal(k.proiezione.andamento.length, 10)
  assert.equal(k.alGiorno.valore, 10, 'la mediana: il picco da 40 e oggi da 2 non la spostano')
  assert.equal(k.alGiorno.andamento.length, 24, 'oggi è escluso')
  assert.deepEqual([k.piuCaro.giorno, k.piuCaro.valore], ['2026-10-05', 40])
})

test('tessere: l’ultimo giorno del mese non c’è niente da proiettare, e il numero resta quello vero', () => {
  const u = conto('2026-10-31', 31, { X: () => 1 })
  const k = kpiSpesa(u, 30)
  assert.equal(k.mese.lordo, 31)
  assert.equal(k.proiezione.chiuso, true)
  assert.equal(k.proiezione.gross, 31)
})

test('tabella: settimana contro la precedente sui giorni interi, quota sul totale di tutti i servizi', () => {
  // 15 giorni: 14 interi + oggi. La settimana prima 1 $ al giorno, l'ultima 2 $.
  const u = conto('2026-10-20', 15, { Cresce: (i) => (i < 7 ? 1 : i < 14 ? 2 : 99), Nuovo: (i) => (i >= 7 && i < 14 ? 1 : 0), Corto: () => 1 })
  const righe = tabellaServizi(u)
  const r = Object.fromEntries(righe.map((x) => [x.servizio, x]))
  assert.equal(righe[0].servizio, 'Cresce')
  assert.equal(r.Cresce.settimana.variazione, 1, 'da 7 a 14 $: il doppio, e i 99 $ di oggi non contano')
  assert.equal(r.Nuovo.settimana.variazione, null)
  assert.equal(r.Nuovo.settimana.nuovo, true)
  assert.equal(r.Corto.settimana.variazione, 0)
  const tot = righe.reduce((s, x) => s + x.totale, 0)
  assert.ok(Math.abs(righe.reduce((s, x) => s + x.quota, 0) - 1) < 1e-9)
  assert.equal(r.Cresce.solito, 1.5)
  // Con un servizio solo in tabella la quota resta sul totale di tutti.
  const solo = tabellaServizi(soloServizi(u, ['Corto']), { base: tot })
  assert.equal(solo[0].quota, 15 / tot)
  // Meno di due settimane intere: niente confronto inventato.
  assert.equal(tabellaServizi(conto('2026-10-20', 8, { X: () => 1 }))[0].settimana.variazione, null)
})

test('piccoli multipli: i più cari, una scala sola, il resto contato', () => {
  const u = conto('2026-10-20', 3, { Caro: () => 300, Medio: () => 30, Poco: () => 3 })
  const m = multipliSpesa(u, { max: 2 })
  assert.deepEqual(m.righe.map((r) => r.servizio), ['Caro', 'Medio'])
  assert.deepEqual(m.dominio, [0, 300])
  assert.equal(m.altri, 1)
  assert.equal(mediana([3, 1, 2]), 2)
  assert.equal(mediana([1, 2, 3, 4]), 2.5)
  assert.equal(mediana([]), null)
})

test('asse: una colonna per giorno dalla mezzanotte locale del primo', () => {
  const g = grigliaGiorni(['2026-10-18', '2026-10-19', '2026-10-20'])
  assert.equal(g.punti, 3)
  assert.equal(g.passoMs, 86_400_000)
  assert.equal(new Date(g.inizio).getHours(), 0)
  assert.equal(new Date(g.inizio).getDate(), 18)
  assert.ok(Number.isNaN(mezzanotte('ieri')))
  assert.equal(giornoDopo('2026-10-31'), '2026-11-01')
})

test('demo: 90 giorni deterministici, un servizio che cresce, il weekend che si vede, il Livello che filtra', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  const d = demoCostDaily(90, undefined, now)
  assert.deepEqual(Object.keys(d), ['prod', 'staging', 'management'])
  assert.equal(d.prod.giorni.length, 90)
  assert.deepEqual(demoCostDaily(90, undefined, now), d, 'stesso giorno, stessi numeri')
  // La finestra di 30 dice gli stessi importi della finestra di 90 per gli stessi giorni.
  const trenta = demoCostDaily(30, undefined, now).prod.servizi.find((s) => s.servizio === 'Amazon Bedrock').valori
  const novanta = d.prod.servizi.find((s) => s.servizio === 'Amazon Bedrock').valori
  assert.deepEqual(trenta, novanta.slice(-30))
  const media = (v) => v.reduce((s, x) => s + x, 0) / v.length
  assert.ok(media(novanta.slice(-15, -1)) > 2 * media(novanta.slice(0, 14)), 'Bedrock cresce')
  const ecs = d.staging.servizi.find((s) => s.servizio === 'Amazon Elastic Container Service')
  const sabato = d.staging.giorni.indexOf('2026-10-17')
  const giovedi = d.staging.giorni.indexOf('2026-10-15')
  assert.ok(ecs.valori[sabato] < ecs.valori[giovedi] * 0.6, 'staging spento nel weekend')
  assert.ok(d.prod.crediti.every((c) => c < 0))
  const llms = demoCostDaily(30, 'llms', now)
  assert.deepEqual(llms.prod.servizi.map((s) => s.servizio), ['Amazon Bedrock'])
  assert.ok(llms.prod.crediti.every((c) => c === 0))
})
