// I tempi dei deploy per servizio: se i segmenti si sommano dalle fasi sbagliate, se la CI ingloba
// l'attesa di un'approvazione o se «lenta» scatta sul rumore, la tabella racconta un canale di rilascio
// che non esiste. Tutto puro, più il client GitHub con un fetch finto.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  quantile,
  segmentiBuild,
  ciDellaBuild,
  ripristini,
  buildLenta,
  attesaStaging,
  tempiPerServizio,
  runDaLeggere,
  repoDelleBuild,
} from '../server/tempiDeploy.js'
import { nuovoGithub } from '../server/notify/github.js'
import { renderMetrics } from '../server/metrics.js'

const ORA = Date.parse('2026-10-20T12:00:00Z')
const MIN = 60_000
const iso = (t) => new Date(t).toISOString()
const RAMI = { main: 'produzione', staging: 'staging' }

const fasi = ({ coda = 30, build = 120, deploy = 60 } = {}) => [
  { type: 'SUBMITTED', status: 'SUCCEEDED', durationMs: 1000 },
  { type: 'QUEUED', status: 'SUCCEEDED', durationMs: (coda - 1) * 1000 },
  { type: 'DOWNLOAD_SOURCE', status: 'SUCCEEDED', durationMs: 10_000 },
  { type: 'BUILD', status: 'SUCCEEDED', durationMs: (build - 10) * 1000 },
  { type: 'POST_BUILD', status: 'SUCCEEDED', durationMs: deploy * 1000 },
  { type: 'COMPLETED', status: null, durationMs: null },
]
let numero = 0
const build = ({ fa = 60, dur = 210, status = 'SUCCEEDED', commit = 'abc1234', service = 'api', ...extra } = {}) => {
  const inizio = ORA - fa * MIN
  return {
    number: ++numero,
    service,
    status,
    commit,
    repo: 'https://github.com/acme/api',
    startedAt: iso(inizio),
    endedAt: iso(inizio + dur * 1000),
    durationMs: dur * 1000,
    phases: fasi(),
    ...extra,
  }
}

test('quantile: interpolazione lineare, vuoto null', () => {
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([10], 0.9), 10)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 3, 'arrotondato: 2,5 → 3')
  assert.equal(quantile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9), 91)
  assert.equal(quantile([5, null, NaN, 1], 0.5), 3, 'i valori non numerici non contano')
})

test('i segmenti dalle fasi CodeBuild: coda, build, deploy; un segmento senza fasi è null, non zero', () => {
  assert.deepEqual(segmentiBuild(build()), { coda: 30_000, build: 120_000, deploy: 60_000, totale: 210_000 })
  const senzaDeploy = build({ phases: fasi().filter((p) => p.type !== 'POST_BUILD') })
  assert.equal(segmentiBuild(senzaDeploy).deploy, null)
})

test('la CI si ferma all’ultimo job finito prima della build: l’approvazione è attesa, non test', () => {
  const b = build({ fa: 60 })
  const avvio = Date.parse(b.startedAt)
  const runs = [{ id: 1, event: 'push', head_branch: 'main', head_sha: 'abc1234def', run_started_at: iso(avvio - 40 * MIN) }]
  // Test finiti 30 minuti prima della build: 10 minuti di CI, 30 di approvazione.
  const jobs = new Map([[1, [{ completed_at: iso(avvio - 30 * MIN) }, { completed_at: null }, { completed_at: iso(avvio + 5 * MIN) }]]])
  assert.deepEqual(ciDellaBuild(b, runs, 'main', jobs), { inizio: avvio - 40 * MIN, ci: 10 * MIN, attesa: 30 * MIN })
  assert.deepEqual(ciDellaBuild(b, runs, 'main'), { inizio: avvio - 40 * MIN, ci: 40 * MIN, attesa: null }, 'senza job tutto resta CI')
  assert.equal(ciDellaBuild(b, runs, 'staging'), null, 'un run di un altro ramo non è la CI di questo ambiente')
  assert.equal(ciDellaBuild({ ...b, commit: 'staging' }, runs, 'main'), null, 'un ref simbolico non si abbina')
  const vecchio = [{ ...runs[0], run_started_at: iso(avvio - 5 * 3_600_000) }]
  assert.equal(ciDellaBuild(b, vecchio, 'main'), null, 'oltre tre ore non è la CI di questo commit')
  const dopo = [{ ...runs[0], run_started_at: iso(avvio + MIN) }]
  assert.equal(ciDellaBuild(b, dopo, 'main'), null, 'un run partito dopo la build non è la sua CI')
})

test('ripristino: dalla prima fallita di una serie alla riuscita dopo; STOPPED non conta', () => {
  const lista = [
    build({ fa: 100, status: 'SUCCEEDED' }),
    build({ fa: 90, status: 'FAILED', dur: 60 }),
    build({ fa: 80, status: 'FAILED', dur: 60 }),
    build({ fa: 70, status: 'STOPPED', dur: 60 }),
    build({ fa: 60, status: 'SUCCEEDED', dur: 60 }),
    build({ fa: 30, status: 'FAULT', dur: 60 }),
  ]
  assert.deepEqual(ripristini(lista), [30 * MIN], 'un guasto solo, durato 30 minuti; quello ancora aperto non ha una fine')
})

test('lenta: l’ultima riuscita sopra il p90 delle PRECEDENTI, con uno scarto vero e abbastanza campioni', () => {
  const normali = [200, 210, 190, 205, 215].map((dur, i) => build({ fa: 100 + i * 10, dur }))
  assert.equal(buildLenta([build({ fa: 10, dur: 400 }), ...normali.slice(0, 4)]), null, 'quattro precedenti non bastano')
  const l = buildLenta([build({ fa: 10, dur: 400 }), ...normali])
  assert.equal(l.durationMs, 400_000)
  assert.equal(buildLenta([build({ fa: 10, dur: 250 }), ...normali]), null, 'sopra il p90 di 30 secondi: rumore')
})

test('staging → produzione: solo i commit uguali nei due ambienti, dal primo deploy riuscito in staging', () => {
  const stg = [build({ fa: 300, commit: 'aaaaaaa', dur: 60 }), build({ fa: 200, commit: 'aaaaaaa', dur: 60 }), build({ fa: 100, commit: 'bbbbbbb', status: 'FAILED' })]
  const prod = [build({ fa: 100, commit: 'aaaaaaa' }), build({ fa: 50, commit: 'aaaaaaa' }), build({ fa: 40, commit: 'bbbbbbb' }), build({ fa: 30, commit: 'ccccccc' })]
  assert.deepEqual(attesaStaging(stg, prod), [199 * MIN], 'il secondo deploy dello stesso commit non conta; bbbbbbb in staging è fallito; ccccccc è un merge commit')
})

test('la tabella: una riga per account e servizio, con fallimenti, settimana e attesa da staging', () => {
  const perAccount = {
    staging: { label: 'Staging', builds: [build({ fa: 300, commit: 'aaaaaaa', dur: 60 }), build({ fa: 250, status: 'FAILED' })] },
    prod: {
      label: 'Production',
      builds: [
        build({ fa: 100, commit: 'aaaaaaa' }),
        build({ fa: 20, status: 'IN_PROGRESS', inProgress: true }),
        { service: 'api', kind: 'restart', startedAt: iso(ORA - 10 * MIN) },
        build({ fa: 8 * 24 * 60, commit: 'zzzzzzz' }),
      ],
    },
    payer: { label: 'Payer', builds: [build({ service: 'IaC' })] },
  }
  const runs = new Map([['acme/api', [{ id: 9, event: 'push', head_branch: 'main', head_sha: 'aaaaaaa999', run_started_at: iso(ORA - 110 * MIN), status: 'completed' }]]])
  const righe = tempiPerServizio(perAccount, { runs, rami: RAMI, ora: ORA })
  const prod = righe.find((r) => r.account === 'prod')
  assert.equal(prod.campioni, 2, 'in corso e riavvio a mano fuori')
  assert.deepEqual(prod.settimana, { n: 1, almeno: false }, 'quella di otto giorni fa è fuori dalla settimana, e c’è: il numero non è un minimo')
  assert.equal(prod.ci.p50, 10 * MIN)
  assert.equal(prod.lead.p50, 10 * MIN + 210_000)
  assert.equal(prod.daStaging.p50, 199 * MIN)
  const stg = righe.find((r) => r.account === 'staging')
  assert.deepEqual(stg.fallimento, { falliti: 1, finiti: 2, tasso: 0.5 })
  assert.equal(stg.daStaging, null)
  assert.equal(stg.ci, null, 'nessun run sul ramo staging')
  assert.equal(righe.find((r) => r.account === 'payer').ambiente, null)
  assert.deepEqual(runDaLeggere(perAccount, runs, RAMI), [{ owner: 'acme', repo: 'api', id: 9, finito: true }])
  assert.deepEqual(repoDelleBuild(perAccount, { org: 'acme' }).map((r) => [r.repo, r.da]), [['api', ORA - 8 * 24 * 60 * MIN]])
  assert.deepEqual(repoDelleBuild(perAccount, { org: 'altri' }), [])
})

test('/metrics: durate in secondi con quantile e segmento, lenta 0/1', () => {
  const out = renderMetrics({ services: [] }, [
    { servizio: 'api', account: 'prod', build: { p50: 120_000, p90: 150_500 }, fallimento: { tasso: 0.25 }, settimana: { n: 4 }, ripristino: { p50: 1_800_000 }, daStaging: null, lenta: { durationMs: 1 } },
  ])
  assert.match(out, /dadaguard_deploy_duration_seconds\{service="api",account="prod",segment="build",quantile="0.5"\} 120\n/)
  assert.match(out, /quantile="0.9"\} 150.5\n/)
  assert.match(out, /dadaguard_deploy_failure_ratio\{service="api",account="prod"\} 0.25/)
  assert.match(out, /dadaguard_deploy_last_7d\{service="api",account="prod"\} 4/)
  assert.match(out, /dadaguard_deploy_recovery_seconds\{service="api",account="prod",quantile="0.5"\} 1800/)
  assert.match(out, /dadaguard_deploy_slow\{service="api",account="prod"\} 1/)
  assert.doesNotMatch(out, /staging_to_prod/, 'senza dato niente serie')
  assert.doesNotMatch(renderMetrics({ services: [] }), /dadaguard_deploy_/, 'senza tempi /metrics resta com’era')
})

test('client GitHub: run per ramo con ETag che vale un’ora, job dei run finiti letti una volta sola', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const chiamate = []
  const risposta = (status, json, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => json })
  const fetch = async (url, init) => {
    const u = new URL(url)
    chiamate.push({ path: u.pathname, query: u.searchParams, etag: init.headers['If-None-Match'] ?? null })
    if (u.pathname === '/orgs/acme/installation') return risposta(200, { id: 7 })
    if (u.pathname === '/app/installations/7/access_tokens') return risposta(201, { token: 'ghs_x', expires_at: iso(ORA + 3_600_000) })
    if (u.pathname.endsWith('/jobs')) return risposta(200, { jobs: [{ name: 'test', started_at: 'a', completed_at: 'b', steps: ['tanti'] }] })
    if (u.pathname.endsWith('/actions/runs')) {
      if (init.headers['If-None-Match'] === 'W/"1"') return risposta(304, null)
      return risposta(200, { workflow_runs: [{ id: u.searchParams.get('branch') === 'main' ? 1 : 2 }] }, { etag: 'W/"1"' })
    }
    return risposta(404, {})
  }
  const gh = nuovoGithub({ appId: '1', chiave: privateKey.export({ type: 'pkcs1', format: 'pem' }), org: null, rami: RAMI }, { fetch })
  const r = { owner: 'acme', repo: 'api' }
  assert.deepEqual((await gh.runDi(r, { da: ORA - 30 * MIN, ora: ORA })).map((x) => x.id), [1, 2])
  const runs = chiamate.filter((c) => c.path.endsWith('/actions/runs'))
  assert.deepEqual(runs.map((c) => c.query.get('branch')), ['main', 'staging'])
  assert.equal(runs[0].query.get('created'), '>=2026-10-20T11:00:00Z', 'inizio arrotondato all’ora')
  assert.deepEqual((await gh.runDi(r, { da: ORA - 20 * MIN, ora: ORA })).map((x) => x.id), [1, 2], 'dalla 304 tornano i run di prima')
  assert.equal(chiamate.filter((c) => c.path.endsWith('/actions/runs')).at(-1).etag, 'W/"1"')
  await gh.runDi(r, { da: ORA - 90 * MIN, ora: ORA })
  assert.equal(chiamate.filter((c) => c.path.endsWith('/actions/runs')).at(-1).etag, null, 'un’altra ora è un altro indirizzo: niente ETag vecchio')

  assert.deepEqual(await gh.jobsDi({ ...r, id: 5, finito: true }), [{ name: 'test', started_at: 'a', completed_at: 'b' }], 'solo i campi che servono')
  await gh.jobsDi({ ...r, id: 5, finito: true })
  await gh.jobsDi({ ...r, id: 6, finito: false })
  await gh.jobsDi({ ...r, id: 6, finito: false })
  const job = chiamate.filter((c) => c.path.endsWith('/jobs')).map((c) => c.path)
  assert.deepEqual(job, ['/repos/acme/api/actions/runs/5/jobs', '/repos/acme/api/actions/runs/6/jobs', '/repos/acme/api/actions/runs/6/jobs'], 'un run ancora in corso si rilegge')
})

test('client GitHub: sotto la riserva di richieste dell’ora i job aspettano il giro dopo', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const risposta = (status, json, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => json })
  let resta = '5000'
  let jobs = 0
  const fetch = async (url) => {
    const u = new URL(url)
    if (u.pathname === '/orgs/acme/installation') return risposta(200, { id: 7 })
    if (u.pathname.endsWith('/access_tokens')) return risposta(201, { token: 'ghs_x', expires_at: iso(ORA + 3_600_000) })
    if (u.pathname.endsWith('/jobs')) {
      jobs++
      return risposta(200, { jobs: [] }, { 'x-ratelimit-remaining': resta })
    }
    return risposta(404, {})
  }
  const gh = nuovoGithub({ appId: '1', chiave: privateKey.export({ type: 'pkcs1', format: 'pem' }), org: null, rami: RAMI }, { fetch })
  await gh.jobsDi({ owner: 'acme', repo: 'api', id: 1, finito: true })
  resta = '900'
  await gh.jobsDi({ owner: 'acme', repo: 'api', id: 2, finito: true })
  await assert.rejects(gh.jobsDi({ owner: 'acme', repo: 'api', id: 3, finito: true }), (e) => e.riserva === true)
  assert.equal(jobs, 2, 'il terzo non è partito')
  assert.deepEqual(await gh.jobsDi({ owner: 'acme', repo: 'api', id: 1, finito: true }), [], 'quelli già in memoria si danno lo stesso')
})

test('lenta: dice anche quando e quale fase è cresciuta', () => {
  const normali = [200, 210, 190, 205, 215].map((dur, i) => build({ fa: 100 + i * 10, dur }))
  const lenta = build({ fa: 10, dur: 400, phases: fasi({ build: 310 }) })
  const l = buildLenta([lenta, ...normali])
  assert.equal(l.fase, 'build')
  assert.equal(l.quando, lenta.endedAt)
})
