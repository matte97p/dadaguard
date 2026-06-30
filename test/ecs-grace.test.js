import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEcs } from '../server/runtime/ecs.js'

const NOW = 1_700_000_000_000
const ago = (ms) => new Date(NOW - ms)

test('steady: running >= desired → up', () => {
  assert.equal(classifyEcs({ desiredCount: 3, runningCount: 3, deployments: [] }, NOW).status, 'up')
})

test('scaled to zero → idle (non guasto)', () => {
  assert.equal(classifyEcs({ desiredCount: 0, runningCount: 0, deployments: [] }, NOW).status, 'idle')
})

test('sotto desired SENZA rollout → degraded (guasto vero)', () => {
  const r = classifyEcs(
    { desiredCount: 3, runningCount: 1, deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED', createdAt: ago(3_600_000) }] },
    NOW,
  )
  assert.equal(r.status, 'degraded')
  assert.equal(r.deploying, false)
})

test('rollout IN_PROGRESS → idle/deploying, non rosso', () => {
  const r = classifyEcs(
    { desiredCount: 3, runningCount: 1, deployments: [{ status: 'PRIMARY', rolloutState: 'IN_PROGRESS', createdAt: ago(10_000) }] },
    NOW,
  )
  assert.equal(r.status, 'idle')
  assert.equal(r.deploying, true)
})

test('doppio deployment (PRIMARY+ACTIVE) → deploying', () => {
  const r = classifyEcs(
    {
      desiredCount: 2,
      runningCount: 0,
      deployments: [
        { status: 'PRIMARY', createdAt: ago(5_000) },
        { status: 'ACTIVE', createdAt: ago(600_000) },
      ],
    },
    NOW,
  )
  assert.equal(r.deploying, true)
  assert.equal(r.status, 'idle')
})

test('PRIMARY recente entro la grace → deploying', () => {
  const r = classifyEcs(
    { desiredCount: 2, runningCount: 1, deployments: [{ status: 'PRIMARY', createdAt: ago(30_000) }] },
    NOW,
  )
  assert.equal(r.deploying, true)
})

test('rollout FAILED → resta guasto (down), niente grace', () => {
  const r = classifyEcs(
    { desiredCount: 2, runningCount: 0, deployments: [{ status: 'PRIMARY', rolloutState: 'FAILED', createdAt: ago(10_000) }] },
    NOW,
  )
  assert.equal(r.status, 'down')
  assert.equal(r.deploying, false)
})
