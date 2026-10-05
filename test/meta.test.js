import { test } from 'node:test'
import assert from 'node:assert/strict'
import { livelloDi, ownerDi, comandoPer, dettaglioDi, arricchisciServizio } from '../server/meta/stato.js'
import { tagsDelServizio, metaDaTags, sloDa, CHIAVI } from '../server/meta/tags.js'
import { budgetErrore, conteggiDaRuntime } from '../server/meta/budget.js'
import { linkServizio, linkCommit, linkCodeBuild, linkDeploy, cwEncode } from '../server/meta/link.js'
import { durataTipica } from '../server/meta/cron.js'
import { intervallo30, aggregaGiorni } from '../server/meta/spesa.js'
import { riepilogoLogin } from '../server/meta/accessi.js'

test('livello: gli stati di oggi su quattro livelli', () => {
  assert.equal(livelloDi('down'), 'crit')
  assert.equal(livelloDi('degraded'), 'warn')
  assert.equal(livelloDi('up'), 'ok')
  assert.equal(livelloDi('idle'), 'off')
  assert.equal(livelloDi('disabled'), 'off')
  // «non ho potuto guardare» non e' verde
  assert.equal(livelloDi('unknown'), 'warn')
  assert.equal(livelloDi('inventato'), 'warn')
})

test('owner: dal check che fallisce, e dal tipo per il runtime', () => {
  for (const k of ['drift', 'security', 'backups', 'quotas']) assert.equal(ownerDi(k), 'ops')
  for (const k of ['runtime', 'secrets', 'version', 'liveness']) assert.equal(ownerDi(k), 'dev')
  assert.equal(ownerDi('runtime', 'acm'), 'ops')
  assert.equal(ownerDi('runtime', 'lambda'), 'dev')
})

test('comando: per tipo di problema, solo lettura, argomenti quotati', () => {
  const c = comandoPer('runtime', 'lambda', { function: "f'x" }, { region: 'eu-west-1', profile: 'p' })
  assert.match(c, /^aws logs tail '\/aws\/lambda\/f'\\''x' --since 1h/)
  assert.match(c, /--region 'eu-west-1' --profile 'p'$/)
  assert.match(comandoPer('runtime', 'ecs', { cluster: 'c', service: 's' }), /aws ecs describe-services --cluster 'c' --services 's'/)
  assert.equal(comandoPer('drift', 'lambda', {}, {}), null) // senza repo non si sa dove lanciarlo
  assert.match(comandoPer('drift', 'lambda', {}, { repoDir: '/r' }), /terragrunt run-all plan$/)
  assert.equal(comandoPer('security', 'ecs', {}), null) // caso non sicuro: nessun comando
  assert.doesNotMatch(comandoPer('secrets', 'lambda', {}, { ssmPath: '/x' }), /decryption/)
  // nessun comando della tabella modifica qualcosa
  const tutti = [
    comandoPer('runtime', 'lambda', { function: 'f' }),
    comandoPer('runtime', 'ecs', { cluster: 'c', service: 's' }),
    comandoPer('alarms', 'ecs', {}),
    comandoPer('backups', 'rds', { cluster: 'c' }),
    comandoPer('backups', 'rds', { instance: 'i' }),
    comandoPer('runtime', 'acm', { arn: 'arn:x' }),
    comandoPer('secrets', 'ecs', {}, { ssmPath: '/p' }),
    comandoPer('drift', 'ecs', {}, { repoDir: '/r' }),
    comandoPer('version', 'ecs', {}, { progetto: 'p' }),
  ]
  for (const c of tutti) {
    assert.ok(c)
    assert.doesNotMatch(c, /\b(apply|update-|delete|put-|create-|stop-|start-|set-|destroy|--force)/)
  }
})

test('dettaglio separato dal riassunto', () => {
  assert.equal(dettaglioDi({ summary: 'a' }), null)
  assert.equal(dettaglioDi({ summary: 'a', reason: 'b', httpStatus: 503 }), 'b · HTTP 503')
})

test('arricchisciServizio: livello, owner e comando del check colpevole', () => {
  const r = arricchisciServizio(
    { name: 'x', type: 'ecs', overall: 'degraded', cause: 'drift', checks: { drift: { key: 'drift', status: 'degraded', summary: 'no' }, runtime: { key: 'runtime', status: 'up' } } },
    { aws: { type: 'ecs', cluster: 'c', service: 'x' }, repoDir: '/r' },
  )
  assert.equal(r.livello, 'warn')
  assert.equal(r.owner, 'ops')
  assert.match(r.comando, /terragrunt/)
  assert.equal(r.checks.runtime.livello, 'ok')
  assert.equal(r.checks.runtime.comando, undefined) // nessun comando su un check a posto
})

test('tag: per ARN e per identificativo, ECS su cluster e servizio insieme', () => {
  const perArn = new Map([
    ['arn:aws:ecs:eu-west-1:1:service/c1/api', { [CHIAVI.team]: 'a' }],
    ['arn:aws:ecs:eu-west-1:1:service/c2/api', { [CHIAVI.team]: 'b' }],
    ['arn:aws:lambda:eu-west-1:1:function:job', { [CHIAVI.slo]: '99.5' }],
  ])
  assert.equal(tagsDelServizio({ type: 'ecs', cluster: 'c2', service: 'api' }, perArn)[CHIAVI.team], 'b')
  assert.equal(tagsDelServizio({ type: 'lambda', function: 'job' }, perArn)[CHIAVI.slo], '99.5')
  assert.equal(tagsDelServizio({ type: 'lambda', function: 'altro' }, perArn), null)
  assert.deepEqual(metaDaTags(null), { team: null, slack: null, runbook: null, slo: null })
  assert.equal(sloDa('99,9%'), 0.999)
  assert.equal(sloDa('100'), null)
})

test('budget di errore', () => {
  const b = budgetErrore({ slo: 0.999, totali: 10_000, errori: 5 })
  assert.equal(b.rimasto, 0.5)
  assert.equal(b.sforato, false)
  assert.equal(budgetErrore({ slo: 0.99, totali: 100, errori: 2 }).sforato, true)
  assert.equal(budgetErrore({ slo: 0.99, totali: 0, errori: 0 }), null)
  assert.deepEqual(conteggiDaRuntime({ invocations: 10, errors: 1, window: '1h' }), { totali: 10, errori: 1, finestra: '1h' })
  assert.equal(conteggiDaRuntime({ summary: 'x' }), null)
})

test('link: PostHog solo con config, CloudWatch codificato, commit e CodeBuild', () => {
  assert.equal(linkServizio({ name: 's', aws: { type: 'ecs' }, region: 'eu-west-1' }).length, 0)
  const l = linkServizio({ name: 's', aws: { type: 'lambda', function: 'f' }, region: 'eu-west-1', posthog: { host: 'https://ph.example.com/', projectId: '7' } })
  assert.deepEqual(l.map((x) => x.chiave), ['posthog-errori', 'posthog-log', 'cloudwatch-log'])
  assert.match(l[0].url, /^https:\/\/ph\.example\.com\/project\/7\/error_tracking\?service=s/)
  assert.equal(cwEncode('/aws/lambda/f'), '$252Faws$252Flambda$252Ff')
  assert.equal(linkCommit('https://github.com/o/r.git', 'abc1234'), 'https://github.com/o/r/commit/abc1234')
  assert.equal(linkCommit('s3://bucket', 'abc1234'), null)
  assert.equal(linkCommit('https://github.com/o/r', 'non-sha'), null)
  assert.match(linkCodeBuild('p', 'arn:aws:codebuild:eu-west-1:1:build/p:1'), /eu-west-1\.console.*projects\/p\/history/)
  assert.equal(linkDeploy({ project: 'p' }).length, 0)
})

test('cron: durata tipica = mediana delle riuscite', () => {
  const r = (s, e, outcome = 'ok') => ({ startedAt: s, endedAt: e, outcome })
  assert.equal(durataTipica([r(0, 10), r(0, 30), r(0, 20), r(0, 999, 'failed')]), 20)
  assert.equal(durataTipica([r(0, 10), r(0, 20)]), 15)
  assert.equal(durataTipica([r(0, 10)]), null)
})

test('spesa: 30 giorni fino a oggi e importo di oggi', () => {
  assert.deepEqual(intervallo30(new Date('2026-10-05T10:00:00Z')), { start: '2026-09-06', end: '2026-10-06' })
  const a = aggregaGiorni([{ TimePeriod: { Start: '2026-10-05' }, Total: { UnblendedCost: { Amount: '1.234' } } }], '2026-10-05')
  assert.equal(a.oggi, 1.23)
})

test('login falliti: dal payload Accessi, null se non letto', () => {
  assert.equal(riepilogoLogin({ configurato: false }).loginFalliti, null)
  const r = riepilogoLogin({ configurato: true, audit: { ore: 24, loginFallite: 4, persone: [{ utente: 'a', loginFallite: 4 }, { utente: 'b', loginFallite: 0 }] } })
  assert.equal(r.loginFalliti, 4)
  assert.deepEqual(r.persone, ['a'])
})
