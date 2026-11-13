import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PREDEFINITO,
  statoDaQuery,
  queryDaStato,
  filtriAttivi,
  VISTE_PRONTE,
  statoVista,
  vistaAttiva,
  vistePersonali,
  salvaViste,
  fattoreNetto,
  importo,
  filtra,
  squadreDisponibili,
  settimanaNonProd,
  ruotaSettimana,
  SENZA_SQUADRA,
} from '../web/efficienza.js'
import { efficienzaDemo } from '../server/efficienza/demo.js'

test('stato e indirizzo: andata e ritorno, e il predefinito non sporca il link', () => {
  assert.equal(queryDaStato(PREDEFINITO), '')
  const s = { ...PREDEFINITO, lente: 'unita', squadra: ['dati'], rischio: ['basso'], importi: 'anno' }
  assert.deepEqual(statoDaQuery(queryDaStato(s)), s)
  // un valore sconosciuto torna al predefinito invece di filtrare a vuoto
  assert.equal(statoDaQuery('lente=boh&giorni=12').lente, 'risparmio')
  assert.equal(statoDaQuery('lente=boh&giorni=12').giorni, '30')
})

test('filtri attivi: uno per chip, e ognuno sa come togliersi', () => {
  const s = { ...PREDEFINITO, squadra: ['dati'], come: ['deploy'], minimo: '20' }
  const f = filtriAttivi(s)
  assert.ok(f.some((x) => x.k === 'squadra'))
  assert.ok(f.some((x) => x.k === 'minimo'))
  assert.equal(f.filter((x) => x.k === 'senzaCome').length, 4)
  assert.deepEqual(filtriAttivi(PREDEFINITO), [])
})

test('viste: quella pronta si riconosce quando lo stato coincide', () => {
  const facili = VISTE_PRONTE.find((v) => v.key === 'facili')
  assert.equal(vistaAttiva(statoVista(facili), VISTE_PRONTE), 'facili')
  assert.equal(vistaAttiva(PREDEFINITO, VISTE_PRONTE), null)
})

test('viste personali: salvate e rilette, storage rotto non rompe la pagina', () => {
  const mem = new Map()
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  salvaViste([{ key: 'p1', nome: 'Mia', query: 'lente=unita' }], storage)
  assert.equal(vistePersonali(storage)[0].nome, 'Mia')
  const rotto = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
  assert.deepEqual(vistePersonali(rotto), [])
  assert.doesNotThrow(() => salvaViste([], rotto))
})

test('netto dai crediti: fatturato su listino dell ultimo mese chiuso', () => {
  const trend = {
    a: { months: [{ usage: 100, invoiced: 50 }, { usage: 80, invoiced: 0, partial: true }] },
    b: { months: [{ usage: 100, invoiced: 70 }] },
  }
  assert.equal(fattoreNetto(trend), 0.6)
  assert.equal(fattoreNetto(null), 1)
  assert.equal(importo(100, { ...PREDEFINITO, importi: 'anno', prezzo: 'netto' }, 0.5), 600)
  assert.equal(importo(null, PREDEFINITO), null)
})

test('filtra: squadra, risorsa e leve sulla demo', () => {
  const d = efficienzaDemo(30)
  const tutto = filtra(d, PREDEFINITO)
  assert.equal(tutto.servizi.length, d.servizi.length)
  assert.ok(tutto.recuperabile > 0 && tutto.recuperabile < tutto.base)
  const soloDb = filtra(d, { ...PREDEFINITO, risorsa: 'rds' })
  assert.equal(soloDb.servizi.length, 0)
  assert.ok(soloDb.leve.every((l) => l.risorsa === 'rds'))
  // solo produzione: niente spegnimento fuori orario
  const prod = filtra(d, PREDEFINITO, ['prod'])
  assert.ok(!prod.leve.some((l) => l.tipo === 'orari'))
})

test('filtra: la leva di tutto l ambiente vale solo la parte della squadra scelta', () => {
  const d = efficienzaDemo(30)
  const intera = filtra(d, PREDEFINITO).leve.find((l) => l.tipo === 'orari')
  const dati = filtra(d, { ...PREDEFINITO, squadra: ['data'] })
  const parte = dati.leve.find((l) => l.tipo === 'orari')
  assert.ok(parte.usdMese < intera.usdMese)
  // il recuperabile di una squadra non supera mai la sua spesa
  assert.ok(dati.recuperabile <= dati.base)
})

test('squadre dedotte dai tag, quella senza tag in fondo', () => {
  const d = { servizi: [{ squadra: 'b' }, { squadra: null }, { squadra: 'a' }], database: [] }
  assert.deepEqual(squadreDisponibili(d), ['a', 'b', SENZA_SQUADRA])
})

test('settimana degli ambienti non di produzione, ruotata nell ora di chi guarda', () => {
  const d = efficienzaDemo(30)
  assert.deepEqual(settimanaNonProd(d).chiavi, ['staging'])
  assert.equal(settimanaNonProd(d, ['prod']), null)
  const celle = Array.from({ length: 168 }, (_, i) => i)
  // UTC+1 (getTimezoneOffset = -60): la cella delle 10 locali è quella delle 9 UTC
  assert.equal(ruotaSettimana(celle, -60)[10], 9)
  assert.equal(ruotaSettimana(celle, -60)[0], 167)
})
