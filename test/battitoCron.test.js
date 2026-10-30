import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abbinaBattiti, abbinaFallimenti, eBattito, eFallimento, esitiDaBattito, istantiBattiti, istantiFallimenti, queryBattiti, PERIODO_MS } from '../server/battitoCron.js'

const MIN = 60_000
const ORA = 60 * MIN
const GIORNO = 24 * ORA
// Un allarme «battito»: una metrica sola, sotto uno, il silenzio vale guasto.
const battito = (o = {}) => ({
  AlarmName: 'acme-cron-crawler-heartbeat',
  Namespace: 'Acme/Jobs',
  MetricName: 'Done',
  Dimensions: [{ Name: 'Job', Value: 'crawler' }],
  Statistic: 'Sum',
  Period: 3600,
  EvaluationPeriods: 26,
  ComparisonOperator: 'LessThanThreshold',
  Threshold: 1,
  TreatMissingData: 'breaching',
  ...o,
})

test('eBattito: solo la forma del battito, non gli allarmi che contano errori o tollerano il silenzio', () => {
  assert.equal(eBattito(battito()), true)
  assert.equal(eBattito(battito({ ComparisonOperator: 'LessThanOrEqualToThreshold', Threshold: 0 })), true)
  assert.equal(eBattito(battito({ TreatMissingData: 'notBreaching' })), false, 'il silenzio non allarma: non e’ un battito')
  assert.equal(eBattito(battito({ ComparisonOperator: 'GreaterThanOrEqualToThreshold' })), false, 'conta i guasti, non i successi')
  assert.equal(eBattito(battito({ Threshold: 5 })), false, 'sotto cinque e’ un volume, non un battito')
  assert.equal(eBattito(battito({ Statistic: 'Average' })), false)
  assert.equal(eBattito(battito({ Namespace: undefined, MetricName: undefined, Metrics: [{ Id: 'm1' }] })), false, 'metric math: non una metrica sola')
})

test('abbinaBattiti: per nome del cron piu’ un suffisso, e vince il cron dal nome piu’ lungo', () => {
  const crons = [
    { key: 'p/acme-cron-crawler', name: 'acme-cron-crawler' },
    { key: 'p/acme-cron-crawler-night', name: 'acme-cron-crawler-night' },
    { key: 'p/acme-cron-mailer', name: 'acme-cron-mailer' },
  ]
  const allarmi = [
    battito(),
    battito({ AlarmName: 'acme-cron-crawler-night-heartbeat', Dimensions: [{ Name: 'Job', Value: 'crawler-night' }] }),
    battito({ AlarmName: 'acme-cron-mailer-errors', ComparisonOperator: 'GreaterThanThreshold' }),
    battito({ AlarmName: 'acme-cron-other-heartbeat' }),
  ]
  const b = abbinaBattiti(crons, allarmi)
  assert.deepEqual([...b.keys()].sort(), ['p/acme-cron-crawler', 'p/acme-cron-crawler-night'])
  assert.deepEqual(b.get('p/acme-cron-crawler-night').dimensioni, [{ Name: 'Job', Value: 'crawler-night' }])
  assert.equal(b.get('p/acme-cron-crawler').finestraMs, 26 * ORA)
  assert.equal(queryBattiti([b.get('p/acme-cron-crawler')])[0].MetricStat.Period, PERIODO_MS / 1000)
})

test('istantiBattiti: solo i punti sopra zero, in ordine', () => {
  const r = [{ Id: 'b0', Timestamps: [new Date(3 * PERIODO_MS), new Date(PERIODO_MS)], Values: [1, 2] }, { Id: 'b1', Timestamps: [new Date(PERIODO_MS)], Values: [0] }]
  assert.deepEqual(istantiBattiti(r, 2), [[PERIODO_MS, 3 * PERIODO_MS], []])
})

test('esitiDaBattito: un job che deve riuscire a ogni giro; il punto arriva anche dopo l’ultima riga di log', () => {
  const ora = 10 * GIORNO + 12 * ORA
  // Tre corse giornaliere alle 03:00; l'ultima riga di log un minuto dopo la partenza.
  const corsa = (g) => ({ stream: `s${g}`, startedAt: g * GIORNO + 3 * ORA, endedAt: g * GIORNO + 3 * ORA + MIN })
  const corse = [corsa(8), corsa(9), corsa(10)]
  // Battito alla fine del lavoro, quaranta minuti dopo la partenza: c'e' l'8 e il 10, manca il 9.
  const istanti = [8, 10].map((g) => Math.floor((g * GIORNO + 3 * ORA + 40 * MIN) / PERIODO_MS) * PERIODO_MS)
  const e = esitiDaBattito(corse, { istanti, finestraMs: 26 * ORA }, { ora, cadenzaMs: GIORNO })
  assert.deepEqual(Object.fromEntries(e), { s8: 'ok', s9: 'ko', s10: 'ok' })
})

test('esitiDaBattito: l’ultima corsa senza punto e’ fallita solo dopo il ritardo solito, e mai mentre gira', () => {
  const corsa = (g, extra) => ({ stream: `s${g}`, startedAt: g * GIORNO, endedAt: g * GIORNO + MIN, ...extra })
  const istanti = [Math.floor((8 * GIORNO + 20 * MIN) / PERIODO_MS) * PERIODO_MS]
  const b = { istanti, finestraMs: 26 * ORA }
  const opz = (ora) => ({ ora, cadenzaMs: GIORNO })
  // Di solito batte entro 25 minuti: a 20 minuti dalla partenza non si sa ancora, a tre ore e' fallita.
  assert.equal(esitiDaBattito([corsa(8), corsa(9)], b, opz(9 * GIORNO + 20 * MIN)).get('s9'), undefined)
  assert.equal(esitiDaBattito([corsa(8), corsa(9)], b, opz(9 * GIORNO + 3 * ORA)).get('s9'), 'ko')
  assert.equal(esitiDaBattito([corsa(8), corsa(9, { running: true })], b, opz(9 * GIORNO + 3 * ORA)).get('s9'), undefined)
})

test('esitiDaBattito: con un allarme che tollera piu’ giri il battito prova solo il successo', () => {
  const ora = 2 * GIORNO
  const corse = Array.from({ length: 4 }, (_, i) => ({ stream: `s${i}`, startedAt: GIORNO + i * ORA, endedAt: GIORNO + i * ORA + MIN }))
  const istanti = [Math.floor((GIORNO + 2 * ORA + 5 * MIN) / PERIODO_MS) * PERIODO_MS]
  // Orario, con un allarme a ventisei ore: un giro senza punto puo' essere un giro senza niente da fare.
  const e = esitiDaBattito(corse, { istanti, finestraMs: 26 * ORA }, { ora, cadenzaMs: ORA })
  assert.deepEqual(Object.fromEntries(e), { s2: 'ok' })
  assert.equal(esitiDaBattito(corse, { istanti, finestraMs: 26 * ORA }, { ora, cadenzaMs: 0 }).size, 1, 'senza cadenza nota, lo stesso')
})

// Un allarme «corsa fallita»: il minimo della stessa metrica sotto uno, e il silenzio e' la salute.
const fallimento = (o = {}) => ({
  AlarmName: 'acme-cron-crawler-run-failed',
  Namespace: 'Acme/Jobs',
  MetricName: 'Done',
  Dimensions: [{ Name: 'Job', Value: 'crawler' }],
  Statistic: 'Minimum',
  Period: 3600,
  EvaluationPeriods: 1,
  ComparisonOperator: 'LessThanThreshold',
  Threshold: 1,
  TreatMissingData: 'notBreaching',
  ...o,
})

test('eFallimento: il minimo sotto uno con il silenzio che vale salute, e niente altro', () => {
  assert.equal(eFallimento(fallimento()), true)
  assert.equal(eFallimento(fallimento({ TreatMissingData: 'missing' })), true)
  assert.equal(eFallimento(fallimento({ ComparisonOperator: 'LessThanOrEqualToThreshold', Threshold: 0 })), true)
  assert.equal(eFallimento(fallimento({ TreatMissingData: 'breaching' })), false, 'il silenzio che allarma e’ un battito')
  assert.equal(eFallimento(fallimento({ Statistic: 'Sum' })), false, 'una somma sotto uno e’ un giro senza successi, non un fallimento')
  assert.equal(eFallimento(fallimento({ Threshold: 50 })), false, 'una percentuale sotto soglia non e’ una corsa')
  assert.equal(eFallimento(fallimento({ ComparisonOperator: 'GreaterThanThreshold', Threshold: 0 })), false)
  assert.equal(eBattito(fallimento()), false, 'le due forme non si confondono')
})

test('abbinaFallimenti: stessa regola del nome, accanto al battito dello stesso cron', () => {
  const crons = [
    { key: 'p/acme-cron-crawler', name: 'acme-cron-crawler' },
    { key: 'p/acme-cron-crawler-night', name: 'acme-cron-crawler-night' },
  ]
  const allarmi = [battito(), fallimento(), fallimento({ AlarmName: 'acme-cron-crawler-night-run-failed', Dimensions: [{ Name: 'Job', Value: 'crawler-night' }] })]
  const f = abbinaFallimenti(crons, allarmi)
  assert.deepEqual([...f.keys()].sort(), ['p/acme-cron-crawler', 'p/acme-cron-crawler-night'])
  assert.equal(f.get('p/acme-cron-crawler').stat, 'Minimum')
  assert.equal(f.get('p/acme-cron-crawler-night').allarme, 'acme-cron-crawler-night-run-failed')
  assert.deepEqual([...abbinaBattiti(crons, allarmi).keys()], ['p/acme-cron-crawler'], 'il battito resta solo dove c’e’')
  assert.equal(queryBattiti([f.get('p/acme-cron-crawler')], 'f')[0].Id, 'f0')
})

test('istantiFallimenti: i punti che fanno suonare il loro allarme', () => {
  const specifiche = [
    { soglia: 1, operatore: 'LessThanThreshold' },
    { soglia: 0, operatore: 'LessThanOrEqualToThreshold' },
  ]
  const r = [
    { Id: 'f0', Timestamps: [new Date(2 * PERIODO_MS), new Date(PERIODO_MS)], Values: [0, 1] },
    { Id: 'f1', Timestamps: [new Date(PERIODO_MS)], Values: [0] },
    { Id: 'b0', Timestamps: [new Date(PERIODO_MS)], Values: [0] },
  ]
  assert.deepEqual(istantiFallimenti(r, specifiche), [[2 * PERIODO_MS], [PERIODO_MS]])
})

test('esitiDaBattito: un punto di fallimento decide anche dove il battito prova solo il successo', () => {
  const ora = 2 * GIORNO
  const corse = Array.from({ length: 4 }, (_, i) => ({ stream: `s${i}`, startedAt: GIORNO + i * ORA, endedAt: GIORNO + i * ORA + MIN }))
  const fascia = (t) => Math.floor(t / PERIODO_MS) * PERIODO_MS
  const istanti = [fascia(GIORNO + 2 * ORA + 5 * MIN)]
  const fallite = [fascia(GIORNO + ORA + 10 * MIN), fascia(GIORNO + 2 * ORA + 20 * MIN)]
  // Orario con un allarme a ventisei ore: senza il fallimento, s1 resterebbe «non si sa».
  const e = esitiDaBattito(corse, { istanti, finestraMs: 26 * ORA, fallite }, { ora, cadenzaMs: ORA })
  assert.deepEqual(Object.fromEntries(e), { s1: 'ko', s2: 'ok' }, 's2 ha battuto: il punto a zero dopo il battito non la ribalta')
})

test('esitiDaBattito: senza battito, la corsa con il punto di fallimento e’ fallita subito, le altre non si sanno', () => {
  const ora = 20 * GIORNO
  const corsa = (g) => ({ stream: `s${g}`, startedAt: g * GIORNO, endedAt: g * GIORNO + MIN })
  const fallite = [Math.floor((19 * GIORNO + 2 * MIN) / PERIODO_MS) * PERIODO_MS]
  // Settimanale: nessun battito possibile. L'ultima corsa ha il suo zero a due minuti dalla partenza.
  const e = esitiDaBattito([corsa(12), corsa(19)], { fallite }, { ora: 19 * GIORNO + 10 * MIN, cadenzaMs: 7 * GIORNO })
  assert.deepEqual(Object.fromEntries(e), { s19: 'ko' })
  assert.equal(esitiDaBattito([corsa(12), corsa(19)], { fallite: [] }, { ora, cadenzaMs: 7 * GIORNO }).size, 0)
})
