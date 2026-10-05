import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fasceDeploy, ultimiDeploy, contaDeploy, linkBuild, durataTipica, motivoCorsa, comandoCron, statoCron, linkCron, livelloCorsa } from '../web/rilasci.js'

// Le regole delle pagine Deploy e Cron: in che fascia cade un deploy, quanto dura «di solito» un cron,
// perche' una corsa e' fallita. Sono le righe che decidono di che colore e' la pagina.
const NOW = Date.UTC(2026, 9, 5, 12, 0)
const ago = (min) => new Date(NOW - min * 60_000).toISOString()

test('fasceDeploy: ogni build cade nella sua fascia, fuori finestra non conta', () => {
  const f = fasceDeploy(
    [
      { startedAt: ago(10), status: 'SUCCEEDED' },
      { startedAt: ago(20), status: 'FAILED' },
      { startedAt: ago(30), status: 'SUCCEEDED', trigger: 'hotfix' },
      { startedAt: ago(23 * 60 + 30), inProgress: true },
      { startedAt: ago(25 * 60), status: 'SUCCEEDED' },
    ],
    { now: NOW, ore: 24, n: 24 },
  )
  assert.equal(f.length, 24)
  assert.deepEqual([f[23].ok, f[23].crit, f[23].aMano], [2, 1, 1])
  assert.equal(f[0].info, 1)
  assert.equal(f.reduce((s, x) => s + x.ok + x.crit + x.info, 0), 4)
})

test('ultimiDeploy: i 5 piu recenti, dal piu vecchio al piu recente, con il segno «a mano»', () => {
  const b = [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, startedAt: ago(i * 10), status: i === 1 ? 'FAILED' : 'SUCCEEDED', trigger: i === 2 ? 'manuale' : 'auto' }))
  const u = ultimiDeploy(b)
  assert.deepEqual(u.map((x) => x.build.id), [5, 4, 3, 2, 1])
  assert.equal(u.at(-1).livello, 'crit')
  assert.equal(u.at(-2).aMano, true)
})

test('contaDeploy: un hotfix riuscito conta fra i riusciti E fra quelli a mano', () => {
  assert.deepEqual(contaDeploy([{ status: 'SUCCEEDED', trigger: 'hotfix' }, { status: 'FAILED' }]), { ok: 1, crit: 1, info: 0, off: 0, aMano: 1 })
})

test('linkBuild: vince `altrove` del server, poi i link gia presenti, senza doppioni', () => {
  const l = linkBuild({ altrove: [{ chiave: 'github-commit', url: 'https://example.com/c' }], logsUrl: 'https://example.com/l', deployUrl: 'https://example.com/l' })
  assert.deepEqual(l.map((x) => x.href), ['https://example.com/c', 'https://example.com/l'])
})

test('durataTipica: la manda il server, e senza non se ne inventa una', () => {
  assert.equal(durataTipica({ durataTipicaMs: 5000, runs: [] }), 5000)
  assert.equal(durataTipica({ durataTipicaMs: null, runs: [{ outcome: 'ok', startedAt: 1, endedAt: 1001 }] }), null)
  assert.equal(durataTipica({}), null)
})

test('motivoCorsa: memoria, timeout, exit code, poi «errori nei log» per un fallimento con uscita 0', () => {
  const t = (k, v) => (v ? `${k}:${JSON.stringify(v)}` : k)
  assert.equal(motivoCorsa({ outcome: 'failed', exitCode: 137, stopReason: 'OutOfMemoryError: killed' }, t), 'runs.oom')
  assert.equal(motivoCorsa({ outcome: 'failed', timedOut: true }, t), 'runs.timedOut')
  assert.equal(motivoCorsa({ outcome: 'failed', exitCode: 2 }, t), 'runs.exit:{"code":2}')
  assert.equal(motivoCorsa({ outcome: 'failed', exitCode: 0 }, t), 'rilasci.cron.motivo.erroriNeiLog')
  assert.equal(motivoCorsa({ outcome: 'ok' }, t), null)
})

test('comandoCron e linkCron: solo da un log group certo, mai inventato', () => {
  assert.equal(comandoCron({ type: 'lambda', function: 'job-a', region: 'eu-west-1' }), 'aws logs tail /aws/lambda/job-a --since 1h --region eu-west-1')
  assert.equal(comandoCron({ type: 'ecs-scheduled' }), null)
  const l = linkCron({ logGroup: '/ecs/demo/x', region: 'eu-west-1' })
  assert.equal(l.length, 1)
  assert.match(l[0].href, /log-group\/\$252Fecs\$252Fdemo\$252Fx$/)
  assert.deepEqual(linkCron({ type: 'prefect' }), [])
})

test('statoCron: fallito, in corso, non partito, spento', () => {
  assert.equal(statoCron({ runs: [{ running: true }, { outcome: 'failed' }] }), 'crit')
  assert.equal(statoCron({ runs: [{ running: true }, { outcome: 'ok' }] }), 'info')
  assert.equal(statoCron({ enabled: true, runs: [] }), 'warn')
  assert.equal(statoCron({ enabled: false, runs: [] }), 'off')
  assert.equal(statoCron({ runs: [{ outcome: 'ok' }, { outcome: 'failed' }] }), 'ok')
  assert.equal(livelloCorsa({ outcome: 'unknown' }), 'warn')
})
