import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prefectConfig, stateToOutcome, mapFlowRun, levelName } from '../server/prefect.js'

// La sorgente orchestratore è OPZIONALE: la cosa più importante da bloccare è che senza
// configurazione non esista affatto (niente sezione, niente errore) e che i suoi stati parlino lo
// stesso vocabolario delle run AWS — altrimenti la pagina diventa due tabelle con due lingue.

test('prefectConfig: senza URL la sorgente NON esiste', () => {
  assert.equal(prefectConfig({}), null)
  assert.equal(prefectConfig({ PREFECT_API_URL: '   ' }), null)
})

test('prefectConfig: `/api` si aggiunge una volta sola, e la barra finale non raddoppia', () => {
  assert.equal(prefectConfig({ PREFECT_API_URL: 'https://orch.example.com' }).url, 'https://orch.example.com/api')
  assert.equal(prefectConfig({ PREFECT_API_URL: 'https://orch.example.com/' }).url, 'https://orch.example.com/api')
  assert.equal(prefectConfig({ PREFECT_API_URL: 'https://orch.example.com/api' }).url, 'https://orch.example.com/api')
  assert.equal(prefectConfig({ PREFECT_API_URL: 'https://orch.example.com/api/' }).url, 'https://orch.example.com/api')
})

test('prefectConfig: auth applicativa → Basic, api key → Bearer, niente → nessun header', () => {
  const basic = prefectConfig({ PREFECT_API_URL: 'https://o.example.com', PREFECT_API_AUTH_STRING: 'utente:parola' })
  assert.equal(basic.headers.authorization, `Basic ${Buffer.from('utente:parola').toString('base64')}`)
  const bearer = prefectConfig({ PREFECT_API_URL: 'https://o.example.com', PREFECT_API_KEY: 'pnu_xxx' })
  assert.equal(bearer.headers.authorization, 'Bearer pnu_xxx')
  assert.equal(prefectConfig({ PREFECT_API_URL: 'https://o.example.com' }).headers.authorization, undefined)
})

test('stateToOutcome: gli stati dell’orchestratore nel vocabolario delle run', () => {
  assert.equal(stateToOutcome('COMPLETED'), 'ok')
  assert.equal(stateToOutcome('FAILED'), 'failed')
  assert.equal(stateToOutcome('CRASHED'), 'failed')
  assert.equal(stateToOutcome('CANCELLED'), 'cancelled')
  assert.equal(stateToOutcome('RUNNING'), 'running')
  assert.equal(stateToOutcome('PAUSED'), 'running') // in pausa non è finita: è ancora aperta
  assert.equal(stateToOutcome('SCHEDULED'), 'scheduled')
  assert.equal(stateToOutcome('SPAZZATURA'), 'unknown')
})

test('mapFlowRun: il "cron" è il nome del FLOW, non quello generato della run', () => {
  const run = mapFlowRun(
    {
      id: 'aaa',
      name: 'bold-hedgehog',
      flow_id: 'f1',
      state_type: 'COMPLETED',
      start_time: '2026-08-14T01:00:00Z',
      end_time: '2026-08-14T01:54:00Z',
      total_run_time: 3240,
      state_name: 'Completed',
    },
    { f1: 'portal-scrape' },
  )
  assert.equal(run.cron, 'portal-scrape')
  assert.equal(run.runName, 'bold-hedgehog')
  assert.equal(run.outcome, 'ok')
  assert.equal(run.running, false)
  assert.equal(run.durationMs, 3_240_000)
})

test('mapFlowRun: run in corso → nessuna durata inventata (0 secondi non è una durata)', () => {
  const run = mapFlowRun({ id: 'b', flow_id: 'f1', state_type: 'RUNNING', start_time: '2026-08-14T01:00:00Z', total_run_time: 0 }, {})
  assert.equal(run.running, true)
  assert.equal(run.endedAt, null)
  assert.equal(run.durationMs, null)
})

test('mapFlowRun: senza il nome del flow resta leggibile', () => {
  assert.equal(mapFlowRun({ id: 'c', name: 'keen-otter', flow_id: 'ignoto', state_type: 'FAILED' }, {}).cron, 'keen-otter')
  assert.equal(mapFlowRun({}, {}).cron, '—')
})

test('levelName: livelli numerici di Python → nome che il pannello colora', () => {
  assert.equal(levelName(50), 'critical')
  assert.equal(levelName(40), 'error')
  assert.equal(levelName(30), 'warning')
  assert.equal(levelName(20), 'info')
  assert.equal(levelName(10), 'debug')
  assert.equal(levelName(null), '')
})
