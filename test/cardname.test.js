import { test } from 'node:test'
import assert from 'node:assert/strict'
import { familyPrefixes, splitFamily } from '../web/serviceName.js'
import { fmtSchedule } from '../web/format.js'

// Nome della card = testa muta (famiglia condivisa nel gruppo) + coda in evidenza. Le due funzioni
// sono pure: qui si fissa il comportamento che rende una schermata di 25 card leggibile.

// Flotta tipica: tanti cron dello stesso ambiente + qualche servizio long-running + un outlier.
const STAGING = [
  'acme-staging-cron-scrape-volume-monitor',
  'acme-staging-cron-scraped-documents-monitor',
  'acme-staging-cron-scraped-tenders-public-sync',
  'acme-staging-cron-clickhouse-esiti-cleanup',
  'acme-staging-cron-reporting-leadgen-enrichment',
  'acme-staging-cron-reporting-scraper-storage-sync',
  'acme-staging-backend',
  'acme-staging-frontend',
  'acme-staging-agentic-chat',
  'reporting-staging-db',
]

test('splitFamily: la coda è la parte che distingue, la testa è il prefisso condiviso', () => {
  const fam = familyPrefixes(STAGING)
  assert.deepEqual(splitFamily('acme-staging-cron-scrape-volume-monitor', fam), {
    family: 'acme-staging-cron-',
    tail: 'scrape-volume-monitor',
  })
  assert.deepEqual(splitFamily('acme-staging-backend', fam), { family: 'acme-staging-', tail: 'backend' })
})

test('splitFamily: la testa è la STESSA su tutto il gruppo (due fratelli non fanno famiglia)', () => {
  const fam = familyPrefixes(STAGING)
  // `…cron-scraped-` e `…cron-reporting-` sono condivisi da 2 nomi su 10: sotto la soglia (un terzo),
  // altrimenti card vicine mostrerebbero teste diverse — e la testa muta non si "salterebbe" più.
  for (const n of STAGING.filter((n) => n.startsWith('acme-staging-cron-'))) {
    assert.equal(splitFamily(n, fam).family, 'acme-staging-cron-')
  }
  assert.ok(!fam.has('acme-staging-cron-scraped-'))
})

// Regressione dal campo: account Staging reale, 21 servizi (i Bedrock già esclusi dal chiamante).
// `acme-staging-` copre 12/21 (57%) e `acme-staging-cron-` 9/21 (43%): con una soglia a metà gruppo
// NESSUNA delle due passava e in produzione non si compattava niente.
test('familyPrefixes: flotta reale — la famiglia passa anche se copre "solo" il 43% del gruppo', () => {
  const real = [
    'acme-staging-cron-scrape-volume-monitor',
    'acme-staging-cron-scraped-documents-monitor',
    'acme-staging-cron-scraped-tenders-public-sync',
    'acme-staging-cron-clickhouse-esiti-cleanup',
    'acme-staging-cron-reporting-leadgen-enrichment',
    'acme-staging-cron-reporting-scraper-storage-sync',
    'acme-staging-cron-refresh-bi-materialized-views',
    'acme-staging-cron-elasticsearch-reindex-tenders',
    'acme-staging-cron-follow-competitor-notifier',
    'acme-staging-backend',
    'acme-staging-frontend',
    'acme-staging-agentic-chat',
    'reporting-staging-db',
    'reporting-staging-reader',
    'ws-redis-staging',
    'analytics-staging-worker',
    'admin-frontend-staging',
    'website-staging',
    'esiti-staging-index',
    'tender-search-staging',
    'garanzia-staging-api',
  ]
  assert.equal(real.length, 21)
  const fam = familyPrefixes(real)
  assert.ok(fam.has('acme-staging-cron-'), 'la testa dei cron deve passare')
  assert.ok(fam.has('acme-staging-'), 'la testa dei nostri servizi deve passare')
  assert.equal(splitFamily('acme-staging-cron-scrape-volume-monitor', fam).tail, 'scrape-volume-monitor')
  assert.equal(splitFamily('acme-staging-backend', fam).tail, 'backend')
  // e nessuna testa inventata sui nomi che non fanno famiglia
  assert.equal(splitFamily('ws-redis-staging', fam).family, null)
})

test('splitFamily: un outlier nel gruppo resta col nome intero (niente troncature inventate)', () => {
  assert.deepEqual(splitFamily('reporting-staging-db', familyPrefixes(STAGING)), {
    family: null,
    tail: 'reporting-staging-db',
  })
})

test('splitFamily: la coda non è mai vuota (nome che È il prefisso di famiglia)', () => {
  const names = ['acme-staging-cron', 'acme-staging-cron-uno', 'acme-staging-cron-due']
  const fam = familyPrefixes(names)
  assert.ok(fam.has('acme-staging-cron-'))
  // il nome coincide con la famiglia → si ferma alla testa più corta che gli lascia una coda
  const { family, tail } = splitFamily('acme-staging-cron', fam)
  assert.equal(`${family ?? ''}${tail}`, 'acme-staging-cron')
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
