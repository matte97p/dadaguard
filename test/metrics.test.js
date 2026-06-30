import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMetrics } from '../server/metrics.js'

test('renderMetrics: severità per servizio + scrape_success', () => {
  const out = renderMetrics({
    services: [
      { name: 'a', account: { key: 'stg' }, type: 'lambda', overall: 'down', checks: { liveness: { status: 'down', latencyMs: 50 } } },
      { name: 'b', account: { key: 'prod' }, type: 'rds', overall: 'up', checks: { runtime: { status: 'up', runningCount: 2, desiredCount: 2 } } },
    ],
  })
  assert.match(out, /dadaguard_service_status\{[^}]*service="a"[^}]*\} 3/) // down = 3
  assert.match(out, /dadaguard_service_status\{[^}]*service="b"[^}]*\} 0/) // up = 0
  assert.match(out, /dadaguard_liveness_latency_ms\{[^}]*service="a"[^}]*\} 50/)
  assert.match(out, /dadaguard_runtime_running\{[^}]*service="b"[^}]*\} 2/)
  assert.match(out, /dadaguard_scrape_success 1/)
})

test('renderMetrics: nessun servizio → solo scrape_success', () => {
  const out = renderMetrics({ services: [] })
  assert.match(out, /dadaguard_scrape_success 1/)
  assert.doesNotMatch(out, /dadaguard_service_status\{/)
})
