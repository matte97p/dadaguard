// «Cosa aspetta la produzione?»: il messaggio del mattino deve contare il lavoro vero (non i merge),
// tacere quando non aspetta niente, DIRE quando non ha potuto leggere, e non ripetersi nello stesso
// giorno se il task riparte. Qui GitHub e Slack sono finti, e i nomi inventati.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attesaConfig,
  repoDaGuardare,
  ticketDi,
  ritardoRepo,
  calcolaAttesa,
  messaggioAttesa,
  testoAttesa,
  oraLocale,
  giroAttesa,
  TITOLO,
  DEPLOY_IN_CORSO_MS,
} from '../server/attesa.js'
import { nuovoGithub } from '../server/notify/github.js'
import { generateKeyPairSync } from 'node:crypto'
import { log } from '../server/log.js'

const ORA = Date.parse('2026-03-10T07:20:00Z') // martedì, 08:20 a Roma
const GIORNO = 86_400_000
const build = (service, commit, { repo = 'api', ...extra } = {}) => ({ service, commit, status: 'SUCCEEDED', startedAt: '2026-03-09T10:00:00Z', repo: `https://github.com/acme/${repo}`, ...extra })
const commit = (sha, giorniFa, titolo, extra = {}) => ({
  sha,
  parents: [{ sha: 'p' }],
  author: { login: extra.login ?? 'rossi-dev' },
  commit: { message: titolo, committer: { date: new Date(ORA - giorniFa * GIORNO).toISOString() }, author: { name: 'Rossi' } },
  ...extra,
})

test('la configurazione: ora valida o 8, rami dai default, repository in più e prefissi dei ticket', () => {
  const c = attesaConfig({ DADAGUARD_ATTESA_CANALE: 'C1', DADAGUARD_ATTESA_ORA: '25', DADAGUARD_ATTESA_REPO: 'acme/sito, acme/admin', DADAGUARD_ATTESA_TEAM: 'eng,ops' })
  assert.equal(c.ora, 8)
  assert.equal(c.ramoProduzione, 'main')
  assert.equal(c.ramoStaging, 'staging')
  assert.deepEqual(c.extra, [{ owner: 'acme', repo: 'sito' }, { owner: 'acme', repo: 'admin' }])
  assert.deepEqual(c.team, ['ENG', 'OPS'])
  assert.equal(attesaConfig({ DADAGUARD_GITHUB_RAMI: 'produzione=prod,staging=dev' }).ramoProduzione, 'prod')
})

test('i repository: solo con un deploy riuscito in staging, raggruppati per repository, IaC e esclusi fuori', () => {
  const perAccount = {
    staging: { builds: [build('api', 'aaaaaaa'), build('api-scheduler', 'aaaaaaa'), build('web', 'bbbbbbb', { repo: 'web' }), build('IaC', 'ccccccc', { iac: true, repo: 'infra' }), build('vecchio', 'ddddddd', { repo: 'vecchio' })] },
    prod: { builds: [build('api', '1111111'), build('solo-prod', '2222222', { repo: 'solo-prod' })] },
    payer: { builds: [build('altro', '3333333', { repo: 'altro' })] },
  }
  const r = repoDaGuardare(perAccount, { extra: [{ owner: 'acme', repo: 'sito' }], esclusi: new Set(['vecchio']) })
  assert.deepEqual(r.map((x) => x.repo), ['api', 'sito', 'web'])
  const api = r.find((x) => x.repo === 'api')
  assert.deepEqual(api.servizi, ['api', 'api-scheduler'])
  assert.deepEqual(api.deploy.produzione.map((d) => d.commit), ['1111111'])
  assert.equal(r.find((x) => x.repo === 'sito').deploy.staging.length, 0)
})

test('i ticket: dal titolo in maiuscolo, dal ramo solo con i prefissi dichiarati', () => {
  assert.deepEqual(ticketDi({ titolo: 'fix(api): retry (ENG-12)', rami: ['rossi/ops-7-retry'] }), ['ENG-12'])
  assert.deepEqual(ticketDi({ titolo: 'fix(api): retry (ENG-12)', rami: ['rossi/ops-7-retry', 'fix/utf-8-names'] }, ['ENG', 'OPS']).sort(), ['ENG-12', 'OPS-7'])
  assert.deepEqual(ticketDi({ titolo: 'chore: UTF-8 everywhere' }, ['ENG']), [])
})

test('il ritardo: i merge non contano, ma il loro ramo dà il ticket; il più vecchio decide giorni e 🔴', () => {
  const confronto = {
    total_commits: 3,
    commits: [
      commit('s1', 9, 'feat: one (ENG-1)'),
      commit('m1', 8, 'Merge pull request #4 from acme/rossi/eng-2-thing', { parents: [{}, {}] }),
      commit('s2', 1, 'fix: two', { login: 'bianchi-dev' }),
    ],
  }
  const x = ritardoRepo({ repo: 'api', servizi: ['api'] }, { confronto, pr: new Map([['s2', [{ ramo: 'bianchi/eng-3-fix' }]]]), team: ['ENG'], ora: ORA })
  assert.equal(x.inAttesa, 2)
  assert.equal(x.giorni, 9)
  assert.equal(x.vecchio, true)
  assert.deepEqual(x.autori, ['rossi-dev', 'bianchi-dev'])
  assert.deepEqual(x.ticket, ['ENG-1', 'ENG-2', 'ENG-3'])
})

test('i deploy mancati: punta diversa dal commit deployato, ma non se la punta si è appena spostata', () => {
  const r = { repo: 'api', deploy: { staging: [{ servizio: 'api', commit: 'aaaaaaa' }], produzione: [{ servizio: 'api', commit: '1111111' }] } }
  const vecchia = new Date(ORA - 2 * DEPLOY_IN_CORSO_MS).toISOString()
  const x = ritardoRepo(r, { confronto: { total_commits: 0, commits: [] }, punte: { staging: { sha: 'aaaaaaa999', quando: vecchia }, produzione: { sha: '2222222999', quando: vecchia } }, ora: ORA })
  assert.equal(x.stagingNonRilasciato, null)
  assert.deepEqual(x.produzioneNonRilasciata, { punta: '2222222', servizi: [{ servizio: 'api', commit: '1111111' }] })
  const appena = ritardoRepo(r, { confronto: { total_commits: 0, commits: [] }, punte: { produzione: { sha: '2222222999', quando: new Date(ORA - 60_000).toISOString() } }, ora: ORA })
  assert.equal(appena.produzioneNonRilasciata, null)
})

test('il messaggio: tace se niente aspetta, una riga per repository, gli errori in cima, il link', () => {
  const allineato = { repo: 'web', inAttesa: 0, autori: [], ticket: [] }
  assert.equal(messaggioAttesa([allineato]), null)
  const testo = messaggioAttesa(
    [
      allineato,
      { repo: 'api', inAttesa: 2, giorni: 9, vecchio: true, autori: ['rossi-dev'], ticket: ['ENG-1'] },
      { repo: 'admin', errore: 'github GET /repos/acme/admin/compare: HTTP 404' },
    ],
    { linearUrl: 'https://linear.example/issue/', publicUrl: 'https://guard.example/' },
  )
  const righe = testo.split('\n')
  assert.equal(righe[0], TITOLO)
  assert.match(righe[1], /^• ⚠️ `admin`: non letto da GitHub \(.*HTTP 404\)/)
  assert.equal(righe[2], '• 🔴 `api`: 2 commit in staging e non in produzione da 9 giorni (rossi-dev) · <https://linear.example/issue/ENG-1|ENG-1>')
  assert.equal(righe[3], '<https://guard.example/api/attesa?format=testo|Il dettaglio in Dadaguard>')
  assert.ok(!testo.includes('<!channel>'))
  assert.match(messaggioAttesa([], { erroreGenerale: 'AccessDenied' }), /non si sono potuti leggere \(AccessDenied\)/)
})

test('il testo dell’API dice anche «allineato», senza la formattazione di Slack', () => {
  const t = testoAttesa([{ repo: 'web', inAttesa: 0, autori: [], ticket: [] }, { repo: 'api', inAttesa: 1, giorni: 0, autori: [], ticket: [], produzioneNonRilasciata: { punta: '2222222', servizi: [{ commit: '1111111' }] } }])
  assert.equal(t, 'web: allineato\napi: 1 commit in staging e non in produzione da oggi · [PROD] ultimo deploy su 1111111, il ramo è a 2222222')
})

test('l’ora locale: Roma d’inverno è UTC+1, e il sabato non è feriale', () => {
  assert.deepEqual(oraLocale(ORA, 'Europe/Rome'), { giorno: '2026-03-10', ora: 8, feriale: true })
  assert.equal(oraLocale(Date.parse('2026-03-14T07:20:00Z'), 'Europe/Rome').feriale, false)
})

// Un GitHub finto con le tre letture; `rotto` fa fallire un repository.
const githubFinto = ({ rotto = null } = {}) => ({
  org: null,
  confronto: async (r) => {
    if (r.repo === rotto) throw new Error('github GET /compare: HTTP 403')
    return r.repo === 'api' ? { total_commits: 1, commits: [commit('s1', 2, 'feat: one (ENG-1)')] } : { total_commits: 0, commits: [] }
  },
  puntaRamo: async () => ({ sha: null, quando: null }),
  prDelCommit: async () => [],
})
const perAccount = { staging: { builds: [build('api', 'aaaaaaa'), build('web', 'bbbbbbb', { repo: 'web' })] } }
const cfgBase = { ...attesaConfig({ DADAGUARD_ATTESA_CANALE: 'C1', DADAGUARD_SLACK_BOT_TOKEN: 'x' }) }

test('un repository che non si legge diventa la sua riga d’errore, gli altri continuano', async () => {
  const righe = await calcolaAttesa(repoDaGuardare(perAccount), githubFinto({ rotto: 'web' }), cfgBase, { ora: ORA })
  assert.equal(righe.find((x) => x.repo === 'api').inAttesa, 1)
  assert.match(righe.find((x) => x.repo === 'web').errore, /HTTP 403/)
})

// Uno Slack finto: la cronologia del canale e i messaggi scritti.
const slackFinto = (storia = []) => {
  const scritti = []
  const api = async (metodo, corpo) => {
    if (metodo === 'conversations.history') return { messages: storia }
    if (metodo === 'chat.postMessage') {
      if (slackFinto.rotto) throw new Error('slack chat.postMessage: not_in_channel')
      scritti.push(corpo)
      return { ts: '1' }
    }
    throw new Error(`metodo inatteso ${metodo}`)
  }
  return { api, scritti }
}

test('il giro: fuori orario non fa niente, all’ora giusta scrive una volta, e il giorno dopo di nuovo', async () => {
  const { api, scritti } = slackFinto()
  const mem = {}
  const deps = { leggiDeploy: async () => perAccount, github: githubFinto(), api, mem }
  assert.equal((await giroAttesa(cfgBase, { ...deps, ora: ORA - 3_600_000 })).fatto, false)
  assert.equal((await giroAttesa(cfgBase, { ...deps, ora: ORA })).inviato, true)
  assert.equal((await giroAttesa(cfgBase, { ...deps, ora: ORA + 5 * 60_000 })).motivo, 'già fatto oggi')
  assert.equal(scritti.length, 1)
  assert.match(scritti[0].text, /^\*Cosa aspetta la produzione\*\n• `api`: 1 commit/)
  assert.equal(scritti[0].channel, 'C1')
  await giroAttesa(cfgBase, { ...deps, ora: ORA + GIORNO })
  assert.equal(scritti.length, 2)
})

test('il giro: dopo un riavvio la cronologia del canale impedisce il doppio messaggio', async () => {
  const { api, scritti } = slackFinto([{ text: `${TITOLO}\n• ...`, ts: String((ORA - 10 * 60_000) / 1000) }])
  const r = await giroAttesa(cfgBase, { leggiDeploy: async () => perAccount, github: githubFinto(), api, mem: {}, ora: ORA })
  assert.equal(r.motivo, 'già detto oggi')
  assert.equal(scritti.length, 0)
})

test('il giro: niente in attesa tace, deploy illeggibili lo dicono, un invio fallito si riprova', async () => {
  const vuoto = slackFinto()
  const tace = await giroAttesa(cfgBase, { leggiDeploy: async () => ({}), github: githubFinto(), api: vuoto.api, mem: {}, ora: ORA })
  assert.deepEqual(tace, { fatto: true, inviato: false })

  const errore = slackFinto()
  await giroAttesa(cfgBase, { leggiDeploy: async () => Promise.reject(new Error('AccessDenied')), github: githubFinto(), api: errore.api, mem: {}, ora: ORA })
  assert.match(errore.scritti[0].text, /AccessDenied/)

  const mem = {}
  const rotto = slackFinto()
  slackFinto.rotto = true
  await assert.rejects(giroAttesa(cfgBase, { leggiDeploy: async () => perAccount, github: githubFinto(), api: rotto.api, mem, ora: ORA }), /not_in_channel/)
  slackFinto.rotto = false
  await giroAttesa(cfgBase, { leggiDeploy: async () => perAccount, github: githubFinto(), api: rotto.api, mem, ora: ORA + 5 * 60_000 })
  assert.equal(rotto.scritti.length, 1)
})

test('il client GitHub: compare, punta del ramo e PR del commit, con il token dell’installazione', async () => {
  log.level = 'silent'
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const chiamate = []
  const fetch = async (url, opts) => {
    chiamate.push({ url, auth: opts.headers.Authorization })
    const json = (x) => ({ ok: true, status: 200, headers: new Map(), json: async () => x })
    if (url.endsWith('/orgs/acme/installation')) return json({ id: 7 })
    if (url.endsWith('/app/installations/7/access_tokens')) return json({ token: 'tok', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    if (url.includes('/compare/main...staging')) return json({ total_commits: 1, commits: [] })
    if (url.includes('/branches/staging')) return json({ commit: { sha: 'abc', commit: { committer: { date: '2026-03-10T00:00:00Z' } } } })
    if (url.includes('/commits/abc/pulls'))
      return json([
        { number: 4, head: { ref: 'rossi/eng-1-x' }, base: { ref: 'staging' }, merged_at: '2026-03-09T00:00:00Z', title: 'x' },
        { number: 5, head: { ref: 'bianchi/eng-2-y' }, base: { ref: 'staging' }, merged_at: null, title: 'aperta' },
      ])
    return { ok: false, status: 404, headers: new Map(), json: async () => ({}) }
  }
  const gh = nuovoGithub({ appId: '1', chiave: privateKey.export({ type: 'pkcs1', format: 'pem' }), org: null, rami: {} }, { fetch })
  const r = { owner: 'acme', repo: 'api' }
  assert.equal((await gh.confronto(r, 'main', 'staging')).total_commits, 1)
  assert.deepEqual(await gh.puntaRamo(r, 'staging'), { sha: 'abc', quando: '2026-03-10T00:00:00Z' })
  assert.deepEqual(await gh.prDelCommit(r, 'abc', { base: 'staging' }), [{ numero: 4, ramo: 'rossi/eng-1-x', titolo: 'x' }])
  assert.equal((await gh.prDelCommit(r, 'abc')).length, 2)
  assert.ok(chiamate.filter((c) => c.url.includes('/repos/')).every((c) => c.auth === 'Bearer tok'))
})
