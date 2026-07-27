import { test } from 'node:test'
import assert from 'node:assert/strict'
import { familyPrefixes, splitFamily } from '../web/serviceName.js'
import { fmtSchedule } from '../web/format.js'

// Nome della card = testa muta (famiglia condivisa nel gruppo) + coda in evidenza. Le due funzioni
// sono pure: qui si fissa il comportamento che rende una schermata di 25 card leggibile.

// Flotta tipica: tanti cron dello stesso ambiente + qualche servizio long-running + un outlier.
const STAGING = [
  'cato-staging-cron-scrape-volume-monitor',
  'cato-staging-cron-scraped-documents-monitor',
  'cato-staging-cron-scraped-tenders-public-sync',
  'cato-staging-cron-clickhouse-esiti-cleanup',
  'cato-staging-cron-avvista-leadgen-enrichment',
  'cato-staging-cron-avvista-scraper-storage-sync',
  'cato-staging-backend',
  'cato-staging-frontend',
  'cato-staging-agentic-chat',
  'avvista-staging-db',
]

test('splitFamily: la coda è la parte che distingue, la testa è il prefisso condiviso', () => {
  const fam = familyPrefixes(STAGING)
  assert.deepEqual(splitFamily('cato-staging-cron-scrape-volume-monitor', fam), {
    family: 'cato-staging-cron-',
    tail: 'scrape-volume-monitor',
  })
  assert.deepEqual(splitFamily('cato-staging-backend', fam), { family: 'cato-staging-', tail: 'backend' })
})

test('splitFamily: la testa è la STESSA su tutto il gruppo (due fratelli non fanno famiglia)', () => {
  const fam = familyPrefixes(STAGING)
  // `…cron-scraped-` e `…cron-avvista-` sono condivisi da 2 nomi: sotto la soglia (metà del gruppo),
  // altrimenti card vicine mostrerebbero teste diverse — e la testa muta non si "salterebbe" più.
  for (const n of STAGING.filter((n) => n.startsWith('cato-staging-cron-'))) {
    assert.equal(splitFamily(n, fam).family, 'cato-staging-cron-')
  }
  assert.ok(!fam.has('cato-staging-cron-scraped-'))
})

test('splitFamily: un outlier nel gruppo resta col nome intero (niente troncature inventate)', () => {
  assert.deepEqual(splitFamily('avvista-staging-db', familyPrefixes(STAGING)), {
    family: null,
    tail: 'avvista-staging-db',
  })
})

test('splitFamily: la coda non è mai vuota (nome che È il prefisso di famiglia)', () => {
  const names = ['cato-staging-cron', 'cato-staging-cron-uno', 'cato-staging-cron-due']
  const fam = familyPrefixes(names)
  assert.ok(fam.has('cato-staging-cron-'))
  // il nome coincide con la famiglia → si ferma alla testa più corta che gli lascia una coda
  const { family, tail } = splitFamily('cato-staging-cron', fam)
  assert.equal(`${family ?? ''}${tail}`, 'cato-staging-cron')
  assert.ok(tail.length > 0)
})

test('splitFamily: senza famiglie (o input vuoto) ritorna il nome intero', () => {
  assert.deepEqual(splitFamily('solo-io', new Set()), { family: null, tail: 'solo-io' })
  assert.deepEqual(splitFamily('solo-io', familyPrefixes(['solo-io'])), { family: null, tail: 'solo-io' })
  assert.deepEqual(splitFamily(undefined, familyPrefixes([])), { family: null, tail: '' })
})

// Cadenza: "1440m" non dice niente a chi legge → "ogni 1g". Stesse unità di server/runtime/*.js.
const T = (k, v) => (k === 'card.cron.every' ? `ogni ${v.every}` : { 'time.unit.d': 'g', 'time.unit.h': 'h', 'time.unit.m': 'm' }[k] ?? k)

test('fmtSchedule: minuti → cadenza in parole', () => {
  assert.equal(fmtSchedule('1440m', T), 'ogni 1g')
  assert.equal(fmtSchedule('10080m', T), 'ogni 7g')
  assert.equal(fmtSchedule('240m', T), 'ogni 4h')
  assert.equal(fmtSchedule('90m', T), 'ogni 2h')
  assert.equal(fmtSchedule('15m', T), 'ogni 15m')
})

test('fmtSchedule: input non riconosciuto → invariato (mai inventare una cadenza)', () => {
  assert.equal(fmtSchedule('rate(1 day)', T), 'rate(1 day)')
  assert.equal(fmtSchedule('0m', T), '0m')
  assert.equal(fmtSchedule(null, T), null)
})
