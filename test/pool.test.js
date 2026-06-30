import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapLimit } from '../server/util/pool.js'

test('mapLimit preserva l ordine dei risultati', async () => {
  const out = await mapLimit([1, 2, 3, 4], 2, async (x) => x * 10)
  assert.deepEqual(out, [10, 20, 30, 40])
})

test('mapLimit non supera il limite di concorrenza', async () => {
  let active = 0
  let max = 0
  await mapLimit([...Array(12).keys()], 3, async () => {
    active++
    max = Math.max(max, active)
    await new Promise((r) => setTimeout(r, 5))
    active--
  })
  assert.ok(max <= 3, `concorrenza max ${max} > 3`)
})

test('mapLimit gestisce array vuoto', async () => {
  assert.deepEqual(await mapLimit([], 4, async (x) => x), [])
})
