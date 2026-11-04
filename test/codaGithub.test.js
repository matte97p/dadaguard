// GitHub Actions fermo: i run restano in coda, la CI non scrive niente perché non gira, e il quadro
// diceva solo «test avviati». Qui l'allarme della coda, gli incidenti letti dalla pagina di stato e
// come si aprono e si chiudono nel canale. Nomi e dati inventati.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statoDaRun } from '../server/notify/github.js'
import { githubStatusConfig, incidentiRilevanti, nuovoGithubStatus, OGNI_MS } from '../server/notify/githubStatus.js'
import { quadroAmbiente, quadroConfig, datiAllarmi, pianoAllarmi, allarmiDalCanale, allarmiIncidenti } from '../server/notify/quadro.js'
import { log } from '../server/log.js'

const ORA = Date.parse('2026-10-03T12:00:00Z')
const RAMI = { main: 'produzione', staging: 'staging' }
const run = (id, extra = {}) => ({
  id,
  event: 'push',
  head_branch: 'staging',
  head_sha: 'bbbbbbb2222',
  status: 'queued',
  conclusion: null,
  created_at: '2026-10-03T11:30:00Z',
  html_url: `https://github.com/acme/api/actions/runs/${id}`,
  ...extra,
})

const b = (service, commit, startedAt) => ({ service, commit, startedAt, status: 'SUCCEEDED', inProgress: false })
const svc = (name, account, { tag, da }) => ({
  name,
  type: 'ecs',
  overall: 'up',
  account: { key: account },
  checks: { runtime: { desiredCount: 1, runningCount: 1, deploying: false }, version: { build: { tag, deployedAt: da } } },
})
const qa = (test) => {
  const q = quadroAmbiente('staging', {
    deploys: { staging: { builds: [b('api', 'aaaaaaa', '2026-10-03T10:00:00Z')] } },
    servizi: [svc('api', 'staging', { tag: 'aaaaaaa', da: '2026-10-03T10:00:00Z' })],
  })
  if (test) q.app[0].test = test
  return q
}
const INCIDENTE = { id: 'inc1', nome: 'Incident with Actions', stato: 'investigating', url: 'https://stspg.io/abc', da: '2026-10-03T11:20:00Z', componenti: ['Actions'] }

test('dai run: un run in coda porta da quando aspetta un runner; uno in corso o in attesa del gruppo no', () => {
  const s = (runs) => statoDaRun(new Map([['acme/api', runs]]), RAMI).get('staging|acme/api')
  assert.equal(s([run(1)]).inCodaDa, '2026-10-03T11:30:00Z')
  assert.equal(s([run(1), run(2, { created_at: '2026-10-03T11:25:00Z' })]).inCodaDa, '2026-10-03T11:25:00Z', 'il primo in coda')
  assert.equal(s([run(1, { status: 'in_progress' })]).inCodaDa, undefined)
  assert.equal(s([run(1, { status: 'pending' })]).inCodaDa, undefined, 'in attesa del gruppo di concorrenza: non è un runner che manca')
  assert.equal(s([run(1, { status: 'in_progress' }), run(2)]).inCodaDa, '2026-10-03T11:30:00Z', 'un workflow parte, l’altro resta in coda')
})

test('la soglia della coda: 15 minuti, o quella della configurazione', () => {
  assert.equal(quadroConfig({}).codaMs, 15 * 60_000)
  assert.equal(quadroConfig({ DADAGUARD_GITHUB_CODA_MIN: '30' }).codaMs, 30 * 60_000)
  assert.equal(quadroConfig({ DADAGUARD_GITHUB_CODA_MIN: 'x' }).codaMs, 15 * 60_000)
})

test('allarme della coda: si apre oltre la soglia, porta l’incidente, e si chiude quando un runner prende il run', () => {
  const inCoda = { stato: 'in_corso', da: '2026-10-03T11:30:00Z', inCodaDa: '2026-10-03T11:30:00Z', url: 'https://github.com/acme/api/actions/runs/7', sha: 'bbbbbbb2222', oggetto: 'feat: a thing', autore: 'rossi-dev' }
  assert.deepEqual(datiAllarmi(qa(inCoda), { ora: Date.parse('2026-10-03T11:40:00Z') }).rotti, [], 'dieci minuti: ancora normale')

  const dati = datiAllarmi(qa(inCoda), { ora: ORA })
  assert.deepEqual(dati.inCorso, ['api'])
  assert.equal(dati.rotti.length, 1)
  assert.equal(dati.rotti[0].firma, 'coda')
  assert.match(dati.rotti[0].testo, /^🟠 `api` \[STAGING\] CI not started — run queued since 13:30, no runner has picked it up · feat: a thing · <https:\/\/github.com\/acme\/api\/actions\/runs\/7\|bbbbbbb> · by `rossi-dev`$/)
  assert.equal(datiAllarmi(qa(inCoda), { ora: ORA + 60_000 }).rotti[0].testo, dati.rotti[0].testo, 'il testo non cambia col tempo: niente modifiche a ogni giro')
  assert.equal(datiAllarmi(qa(inCoda), { ora: ORA, codaMs: 60 * 60_000 }).rotti.length, 0, 'soglia più lunga')

  const conIncidente = datiAllarmi(qa(inCoda), { ora: ORA, incidenti: [INCIDENTE] })
  assert.match(conIncidente.rotti[0].testo, / · GitHub incident: <https:\/\/stspg.io\/abc\|Incident with Actions> · /)

  const { aperti, azioni } = pianoAllarmi({}, dati)
  assert.deepEqual(azioni.map((z) => z.tipo), ['apri'])
  // Un runner lo prende: i test girano, l'allarme della coda non è più vero e si chiude.
  const parte = datiAllarmi(qa({ ...inCoda, inCodaDa: undefined }), { ora: ORA })
  assert.deepEqual(parte.inCorso, ['api'])
  const chiuso = pianoAllarmi({ api: { ...aperti.api, ts: '1.1' } }, parte)
  assert.deepEqual(chiuso.azioni.map((z) => z.tipo), ['chiudi'])

  // Il run cancellato mentre aspettava: diventa il rosso della CI, nella discussione e nel messaggio.
  const rosso = datiAllarmi(qa({ ...inCoda, inCodaDa: undefined, stato: 'fallito' }), { ora: ORA })
  const p = pianoAllarmi({ api: { ...aperti.api, ts: '1.1' } }, rosso)
  assert.deepEqual(p.azioni.map((z) => z.tipo), ['ancora', 'aggiorna'])
  assert.match(p.azioni[1].testo, /^🔴 `api` \[STAGING\] deploy NOT started/)
})

test('un servizio rilasciato a mano non ha l’allarme della coda', () => {
  const q = qa({ stato: 'in_corso', da: '2026-10-03T11:30:00Z', inCodaDa: '2026-10-03T11:30:00Z', sha: 'bbbbbbb2222' })
  q.app[0].aMano = true
  assert.deepEqual(datiAllarmi(q, { ora: ORA }).rotti, [])
})

test('allarme dell’incidente: solo nell’ambiente che lo porta, un nuovo incidente cambia la firma, chiude quando GitHub lo risolve', () => {
  assert.deepEqual(datiAllarmi(qa(), { ora: ORA, incidenti: [INCIDENTE] }).rotti, [], 'senza allarmeIncidenti niente')
  const dati = datiAllarmi(qa(), { ora: ORA, incidenti: [INCIDENTE], allarmeIncidenti: true })
  assert.deepEqual(dati.rotti.map((r) => r.nome), ['GitHub'])
  assert.equal(dati.rotti[0].testo, '🟠 `GitHub` [STAGING] incident on Actions — <https://stspg.io/abc|Incident with Actions>, investigating · since 13:20 · CI runs may stay queued or not start')
  const { aperti } = pianoAllarmi({}, dati)
  const due = datiAllarmi(qa(), { ora: ORA, incidenti: [INCIDENTE, { ...INCIDENTE, id: 'inc2', nome: 'Webhooks delayed', url: null, componenti: ['Webhooks'] }], allarmeIncidenti: true })
  assert.match(due.rotti[0].testo, /incident on Actions, Webhooks — .* · Webhooks delayed, investigating · /)
  assert.deepEqual(pianoAllarmi({ GitHub: { ...aperti.GitHub, ts: '1.1' } }, due).azioni.map((z) => z.tipo), ['ancora'])
  const risolto = pianoAllarmi({ GitHub: { ...aperti.GitHub, ts: '1.1' } }, datiAllarmi(qa(), { ora: ORA, incidenti: [], allarmeIncidenti: true }))
  assert.deepEqual(risolto.azioni.map((z) => z.tipo), ['chiudi'])
  assert.deepEqual(allarmiIncidenti([], 'staging'), [])
})

test('dopo un riavvio: gli allarmi 🟠 si rileggono dal canale, quello della coda si riconosce', () => {
  const bot = { user: 'UBOT' }
  const messaggi = [
    { ts: '1759492900.000100', user: 'UBOT', text: ':large_orange_circle: `api` [STAGING] CI not started — run queued since 13:30, no runner has picked it up' },
    { ts: '1759492800.000100', user: 'UBOT', text: '🟠 `GitHub` [STAGING] incident on Actions — Incident with Actions' },
  ]
  const aperti = allarmiDalCanale(messaggi, { bot, tag: 'STAGING' })
  assert.deepEqual(Object.keys(aperti).sort(), ['GitHub', 'api'])
  assert.equal(aperti.api.coda, true)
  assert.equal(aperti.GitHub.coda, undefined)
  // Ritrovato e il run ormai partito: si chiude anche se i test sono in corso.
  const parte = datiAllarmi(qa({ stato: 'in_corso', da: '2026-10-03T11:30:00Z', sha: 'bbbbbbb2222' }), { ora: ORA })
  assert.deepEqual(pianoAllarmi({ api: aperti.api }, parte).azioni.map((z) => [z.tipo, z.nome]), [['chiudi', 'api']])
})

test('pagina di stato: configurazione, componenti che contano, incidenti risolti fuori', () => {
  assert.equal(githubStatusConfig({}), null, 'senza GitHub App spento')
  assert.deepEqual(githubStatusConfig({}, { conApp: true }), { url: 'https://www.githubstatus.com/api/v2/incidents/unresolved.json', componenti: ['Actions', 'Webhooks'] })
  assert.equal(githubStatusConfig({ DADAGUARD_GITHUB_STATUS: 'off' }, { conApp: true }), null)
  assert.ok(githubStatusConfig({ DADAGUARD_GITHUB_STATUS: 'on' }))
  assert.deepEqual(githubStatusConfig({ DADAGUARD_GITHUB_STATUS_COMPONENTI: 'Actions, Git Operations' }, { conApp: true }).componenti, ['Actions', 'Git Operations'])

  const json = {
    incidents: [
      { id: 'a', name: 'Incident with Actions and Pages', status: 'investigating', shortlink: 'https://stspg.io/a', created_at: '2026-10-03T11:00:00Z', components: [{ name: 'Actions' }, { name: 'Pages' }] },
      { id: 'b', name: 'Copilot is slow', status: 'investigating', components: [{ name: 'Copilot' }] },
      { id: 'c', name: 'Disruption with some GitHub services', status: 'identified', components: [] },
      { id: 'd', name: 'Incident with Webhooks', status: 'investigating', components: [] },
      { id: 'e', name: 'Incident with Actions', status: 'resolved', components: [{ name: 'Actions' }] },
      { id: 'f', name: 'Bad <link|x>', status: 'monitoring', shortlink: 'javascript:x', components: [{ name: 'actions' }] },
    ],
  }
  const r = incidentiRilevanti(json)
  assert.deepEqual(r.map((i) => [i.id, i.componenti]), [['a', ['Actions']], ['d', ['Webhooks']], ['f', ['actions']]])
  assert.equal(r[0].url, 'https://stspg.io/a')
  assert.equal(r[2].nome, 'Bad linkx', 'niente caratteri che Slack interpreta')
  assert.equal(r[2].url, null, 'solo link https')
  assert.deepEqual(incidentiRilevanti(null), [])
})

test('pagina di stato: una lettura ogni due minuti, ETag, e l’elenco di prima quando non risponde', async () => {
  const chiamate = []
  let risposta = { status: 200, json: { incidents: [{ id: 'a', name: 'Incident with Actions', status: 'investigating', components: [{ name: 'Actions' }] }] }, etag: 'W/"1"' }
  const fetch = async (url, opts) => {
    chiamate.push(opts.headers['If-None-Match'] ?? null)
    if (risposta instanceof Error) throw risposta
    return { status: risposta.status, ok: risposta.status < 400, headers: { get: (h) => (h === 'etag' ? risposta.etag : null) }, json: async () => risposta.json }
  }
  const warn = log.warn
  log.warn = () => {}
  try {
    const s = nuovoGithubStatus(githubStatusConfig({}, { conApp: true }), { fetch })
    assert.deepEqual((await s.leggi({ ora: ORA })).map((i) => i.id), ['a'])
    assert.deepEqual((await s.leggi({ ora: ORA + 60_000 })).map((i) => i.id), ['a'], 'prima dei due minuti non si richiede')
    assert.equal(chiamate.length, 1)
    risposta = { status: 304 }
    assert.deepEqual((await s.leggi({ ora: ORA + OGNI_MS })).map((i) => i.id), ['a'], '304: l’elenco di prima')
    assert.deepEqual(chiamate, [null, 'W/"1"'])
    risposta = new Error('getaddrinfo ENOTFOUND')
    assert.deepEqual((await s.leggi({ ora: ORA + 2 * OGNI_MS })).map((i) => i.id), ['a'], 'non risponde: l’elenco di prima, senza lanciare')
    risposta = { status: 200, json: { incidents: [] }, etag: 'W/"2"' }
    assert.deepEqual(await s.leggi({ ora: ORA + 3 * OGNI_MS }), [], 'risolto')
  } finally {
    log.warn = warn
  }
})
