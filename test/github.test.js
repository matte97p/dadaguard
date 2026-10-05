// Lo stato dei test del quadro viene da GitHub Actions, con una GitHub App: se il JWT è sbagliato,
// se il token non si rinnova o se il rate limit non si rispetta, le righe perdono i 🧪 in silenzio o,
// peggio, l'App esaurisce le sue richieste anche per i runner che la usano. Qui un GitHub finto, e una
// chiave generata al momento: nessuna credenziale vera.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import {
  githubConfig,
  chiavePem,
  jwtApp,
  repoDaUrl,
  repoDelQuadro,
  statoDaRun,
  applicaTest,
  nuovoGithub,
  GIRI_PER_GITHUB,
} from '../server/notify/github.js'
import { log } from '../server/log.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' })
const ORA = Date.parse('2026-10-03T12:00:00Z')
const RAMI = { main: 'produzione', staging: 'staging' }
const run = (id, extra = {}) => ({
  id,
  event: 'push',
  head_branch: 'main',
  head_sha: 'aaaaaaa1111',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-10-03T11:00:00Z',
  html_url: `https://github.com/acme/api/actions/runs/${id}`,
  ...extra,
})

test('il JWT dell’App: RS256, iss l’id, iat un minuto indietro, exp sotto i dieci minuti, firma valida', () => {
  const jwt = jwtApp('123456', PEM, ORA)
  const [h, p, firma] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' })
  const corpo = JSON.parse(Buffer.from(p, 'base64url'))
  assert.deepEqual(corpo, { iat: ORA / 1000 - 60, exp: ORA / 1000 + 540, iss: 123456 })
  assert.ok(corpo.exp - corpo.iat <= 600, 'GitHub rifiuta un JWT che vale più di dieci minuti')
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(firma, 'base64url')), 'la firma si verifica con la chiave pubblica')
  assert.equal(jwtApp('123456', Buffer.from(PEM).toString('base64'), ORA), jwt, 'il PEM in base64, com’è salvato in un parametro, dà lo stesso JWT')
  assert.equal(chiavePem(PEM), PEM.trim())
})

test('configurazione: senza id o chiave niente GitHub; i rami dicono gli ambienti', () => {
  assert.equal(githubConfig({}), null)
  assert.equal(githubConfig({ DADAGUARD_GITHUB_APP_ID: '1' }), null)
  const cfg = githubConfig({ DADAGUARD_GITHUB_APP_ID: '1', DADAGUARD_GITHUB_APP_KEY: 'k', DADAGUARD_GITHUB_ORG: 'Acme' })
  assert.deepEqual(cfg.rami, RAMI)
  assert.equal(cfg.org, 'acme')
  assert.deepEqual(githubConfig({ DADAGUARD_GITHUB_APP_ID: '1', DADAGUARD_GITHUB_APP_KEY: 'k', DADAGUARD_GITHUB_RAMI: 'produzione=master' }).rami, { master: 'produzione' })
  assert.deepEqual(repoDaUrl('https://github.com/acme/Api.git'), { owner: 'acme', repo: 'Api' })
  assert.equal(repoDaUrl('s3://bucket/x.zip'), null)
})

test('dai run allo stato: in corso 🧪, fallito ❌, verde niente; conta l’ultimo commit spinto su un ramo di rilascio', () => {
  const s = (runs) => statoDaRun(new Map([['acme/api', runs]]), RAMI).get('produzione|acme/api') ?? null
  assert.deepEqual(s([run(1, { status: 'in_progress', conclusion: null })]), { stato: 'in_corso', da: '2026-10-03T11:00:00Z', url: 'https://github.com/acme/api/actions/runs/1', sha: 'aaaaaaa1111' })
  assert.equal(s([run(1, { status: 'queued', conclusion: null })]).stato, 'in_corso')
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) assert.equal(s([run(1, { conclusion })]).stato, 'fallito', conclusion)
  assert.equal(s([run(1, { conclusion: 'action_required' })]).stato, 'in_corso', 'in attesa di un’approvazione: ancora 🧪')
  assert.equal(s([run(1)]), null, 'verde: la riga la racconta il deploy')
  assert.equal(s([run(1, { conclusion: 'failure' }), run(2, { head_sha: 'bbbbbbb2222', created_at: '2026-10-03T11:30:00Z' })]), null, 'il fallimento di un commit superato non conta')
  assert.equal(s([run(1, { conclusion: 'failure' }), run(2, { status: 'in_progress', conclusion: null, name: 'Security' })]).stato, 'in_corso', 'un workflow dello stesso commit ancora in corso: test avviati')
  assert.equal(s([run(1, { conclusion: 'failure' }), run(2, { name: 'Security' })]).stato, 'fallito', 'tutti finiti, uno rosso: falliti')
  assert.equal(s([run(1, { event: 'pull_request', conclusion: 'failure' })]), null, 'una pull request non è un rilascio')
  assert.equal(s([run(1, { head_branch: 'feature/x', conclusion: 'failure' })]), null, 'un ramo che non è di rilascio')
  const stg = statoDaRun(new Map([['acme/api', [run(1, { head_branch: 'staging', status: 'in_progress', conclusion: null })]]]), RAMI)
  assert.equal(stg.get('staging|acme/api').stato, 'in_corso')
  assert.equal(stg.has('produzione|acme/api'), false)
})

test('le righe del quadro: i repository dalle build, lo stato su ogni riga di quel repository e ambiente', () => {
  const q = {
    produzione: { app: [{ servizio: 'api', repo: 'https://github.com/acme/api.git' }, { servizio: 'api-worker', repo: 'https://github.com/acme/api' }, { servizio: 'web', repo: null }], infra: { repo: 'https://github.com/acme/infra' } },
    staging: { app: [{ servizio: 'api', repo: 'https://github.com/acme/api' }, { servizio: 'altro', repo: 'https://github.com/altri/x' }], infra: null },
  }
  assert.deepEqual(repoDelQuadro(q).map((r) => `${r.owner}/${r.repo}`), ['acme/api', 'acme/infra', 'altri/x'])
  assert.deepEqual(repoDelQuadro(q, { org: 'acme' }).map((r) => r.repo), ['api', 'infra'])
  applicaTest(q, new Map([['produzione|acme/api', { stato: 'fallito', da: '2026-10-03T11:00:00Z' }]]))
  assert.deepEqual(q.produzione.app.map((r) => r.test?.stato ?? null), ['fallito', 'fallito', null], 'un repository che rilascia due servizi li segna tutti e due')
  assert.equal(q.staging.app[0].test, undefined, 'l’altro ambiente no')
})

// Un GitHub finto: installazione, token che scade, run con ETag, e il rate limit a comando.
function githubFinto({ runs = () => [], scadenza = (ora) => new Date(ora + 3_600_000).toISOString(), nascosti = [] } = {}) {
  const chiamate = []
  const stato = { ora: ORA, limite: false, etag: 'W/"v1"' }
  const risposta = (status, json, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => json })
  const fetch = async (url, init) => {
    const u = new URL(url)
    chiamate.push({ metodo: init.method, path: u.pathname, query: u.search, auth: init.headers.Authorization, etag: init.headers['If-None-Match'] ?? null })
    if (stato.limite) return risposta(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((ORA + 30 * 60_000) / 1000) })
    if (u.pathname === '/orgs/acme/installation') return risposta(200, { id: 77 })
    if (u.pathname === '/app/installations/77/access_tokens') return risposta(201, { token: `ghs_${chiamate.length}`, expires_at: scadenza(stato.ora) })
    if (nascosti.some((r) => u.pathname.startsWith(`/repos/acme/${r}/`))) return risposta(404, { message: 'Not Found' })
    if (u.pathname.endsWith('/actions/runs')) {
      if (init.headers['If-None-Match'] === stato.etag) return risposta(304, null)
      return risposta(200, { workflow_runs: runs(u.pathname) }, { etag: stato.etag })
    }
    return risposta(404, {})
  }
  return { fetch, chiamate, stato }
}
const CFG = { appId: '123456', chiave: PEM, org: null, rami: RAMI }
const REPO = [{ owner: 'acme', repo: 'api' }]

test('il token d’installazione si tiene e si rinnova prima che scada; i run hanno solo push e le ultime 24 ore', async () => {
  const g = githubFinto({ runs: () => [run(1, { status: 'in_progress', conclusion: null })] })
  const gh = nuovoGithub(CFG, { fetch: g.fetch })
  const stati = await gh.leggi(REPO, { ora: ORA })
  assert.equal(stati.get('produzione|acme/api').stato, 'in_corso')
  const [inst, tok, runs] = g.chiamate
  assert.equal(inst.path, '/orgs/acme/installation')
  assert.match(inst.auth, /^Bearer ey/, 'l’installazione si chiede col JWT')
  assert.equal(tok.metodo, 'POST')
  assert.equal(runs.auth, 'Bearer ghs_2', 'i run col token d’installazione')
  assert.equal(new URLSearchParams(runs.query).get('event'), 'push')
  assert.equal(new URLSearchParams(runs.query).get('created'), '>=2026-10-02T12:00:00Z', 'dall’inizio dell’ora di 24 ore fa: l’indirizzo resta uguale per un’ora')

  g.chiamate.length = 0
  for (let i = 0; i < GIRI_PER_GITHUB; i++) await gh.leggi(REPO, { ora: ORA + 20 * 60_000 })
  assert.deepEqual(g.chiamate.map((c) => c.path), ['/repos/acme/api/actions/runs'], 'una lettura ogni GIRI_PER_GITHUB giri, e lo stesso token')
  g.chiamate.length = 0
  for (let i = 0; i < GIRI_PER_GITHUB; i++) await gh.leggi(REPO, { ora: ORA + 56 * 60_000 })
  assert.ok(g.chiamate.some((c) => c.path === '/app/installations/77/access_tokens'), 'a cinque minuti dalla scadenza se ne chiede uno nuovo')
  assert.equal(g.chiamate.filter((c) => c.path === '/orgs/acme/installation').length, 0, 'l’installazione non cambia: non si richiede')
})

test('ETag: la seconda lettura è condizionale, e un 304 tiene i run di prima', async () => {
  const g = githubFinto({ runs: () => [run(1, { conclusion: 'failure' })] })
  const gh = nuovoGithub(CFG, { fetch: g.fetch })
  await gh.leggi(REPO, { ora: ORA, ogni: 1 })
  g.chiamate.length = 0
  const stati = await gh.leggi(REPO, { ora: ORA + 60_000, ogni: 1 })
  const runs = g.chiamate.find((c) => c.path.endsWith('/actions/runs'))
  assert.equal(runs.etag, 'W/"v1"', 'If-None-Match con l’ETag di prima')
  assert.equal(stati.get('produzione|acme/api').stato, 'fallito', 'il 304 non cancella lo stato')
})

test('rate limit: un 403 a richieste finite ferma le letture fino al reset, e lo dice una volta', async () => {
  const g = githubFinto({ runs: () => [run(1, { status: 'in_progress', conclusion: null })] })
  const gh = nuovoGithub(CFG, { fetch: g.fetch })
  await gh.leggi(REPO, { ora: ORA, ogni: 1 })
  g.stato.limite = true
  const avvisi = []
  const warn = log.warn
  log.warn = (m, ctx) => avvisi.push([m, ctx])
  try {
    const stati = await gh.leggi(REPO, { ora: ORA + 60_000, ogni: 1 })
    assert.equal(stati.get('produzione|acme/api').stato, 'in_corso', 'lo stato di prima resta')
    g.chiamate.length = 0
    for (let i = 0; i < 10; i++) await gh.leggi(REPO, { ora: ORA + (2 + i) * 60_000, ogni: 1 })
    assert.equal(g.chiamate.length, 0, 'fino al reset (mezz’ora) nessuna richiesta')
    assert.equal(avvisi.length, 1)
    assert.match(avvisi[0][1].err, /rate limit \(HTTP 403\)/)
    assert.doesNotMatch(JSON.stringify(avvisi), /ghs_|Bearer/, 'il token non finisce nel log')
    g.stato.limite = false
    await gh.leggi(REPO, { ora: ORA + 31 * 60_000, ogni: 1 })
    assert.ok(g.chiamate.length > 0, 'dopo il reset si riprende')
  } finally {
    log.warn = warn
  }
})

test('credenziali assenti o sbagliate: nessun client, o righe senza stato dei test, senza lanciare', async () => {
  assert.equal(nuovoGithub(githubConfig({})), null, 'senza credenziali non c’è client: il quadro funziona come prima')
  const g = githubFinto()
  const warn = log.warn
  const avvisi = []
  log.warn = (m) => avvisi.push(m)
  try {
    const gh = nuovoGithub({ ...CFG, chiave: 'non è una chiave' }, { fetch: g.fetch })
    for (let i = 0; i < 5; i++) assert.equal((await gh.leggi(REPO, { ora: ORA, ogni: 1 })).size, 0)
    assert.equal(g.chiamate.length, 0, 'una chiave che non si legge non arriva a GitHub')
    assert.equal(avvisi.length, 1, 'e lo si dice una volta')
  } finally {
    log.warn = warn
  }
})

test('un repository che l’App non vede (404) si salta da solo, si dice una volta e si riprova ogni mezz’ora', async () => {
  const g = githubFinto({ runs: () => [run(1, { status: 'in_progress', conclusion: null })], nascosti: ['segreto'] })
  const gh = nuovoGithub(CFG, { fetch: g.fetch })
  const repos = [{ owner: 'acme', repo: 'segreto' }, { owner: 'acme', repo: 'api' }]
  const avvisi = []
  const warn = log.warn
  log.warn = (m, ctx) => avvisi.push([m, ctx])
  try {
    const stati = await gh.leggi(repos, { ora: ORA, ogni: 1 })
    assert.equal(stati.get('produzione|acme/api').stato, 'in_corso', 'gli altri repository continuano')
    assert.equal(stati.has('produzione|acme/segreto'), false)
    assert.deepEqual(avvisi.map(([, c]) => c.repo), ['acme/segreto'], 'detto una volta, col nome del repository')
    g.chiamate.length = 0
    for (let i = 1; i <= 10; i++) await gh.leggi(repos, { ora: ORA + i * 60_000, ogni: 1 })
    const runsDi = (r) => g.chiamate.filter((c) => c.path === `/repos/acme/${r}/actions/runs`).length
    assert.equal(runsDi('api'), 10, 'nessun blocco per gli altri: una lettura al giro')
    assert.equal(runsDi('segreto'), 0, 'il repository nascosto non si richiede per mezz’ora')
    await gh.leggi(repos, { ora: ORA + 31 * 60_000, ogni: 1 })
    assert.equal(runsDi('segreto'), 1, 'dopo mezz’ora si riprova')
    assert.equal(avvisi.length, 1, 'e se è ancora nascosto non lo si ripete nel log')
  } finally {
    log.warn = warn
  }
})
