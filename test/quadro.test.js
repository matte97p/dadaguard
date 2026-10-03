// Il quadro dei deploy sostituisce la lettura all'indietro del canale dei rilasci: se sbaglia lo stato
// di un servizio lo sbaglia in cima al canale, fissato, dove tutti lo guardano. Qui si inchiodano gli
// stati, l'unione fra ECS e CodeBuild, i raggruppamenti (immagini condivise, giri di Lambda), i tre
// piani del messaggio coi loro tetti, i link a Dadaguard e il ritrovamento del messaggio.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  statoBuild,
  quadroAmbiente,
  quadro,
  lottiLambda,
  voce,
  linkRisorsa,
  chiLeggibile,
  daChi,
  messaggioQuadro,
  trovaFissato,
  aggiornaQuadri,
  quadroConfig,
  anteprimaUrl,
} from '../server/notify/quadro.js'
import { imageRepo } from '../server/checks/version.js'
import { serviceFromProject } from '../server/deploys.js'
import { corrispondeNome } from '../web/filters.js'

const ORA = Date.parse('2026-10-03T12:00:00Z')
const URL = 'https://dg.example.com'
const b = (service, commit, startedAt, status = 'SUCCEEDED', extra = {}) => ({
  service,
  commit,
  startedAt,
  status,
  inProgress: status === 'IN_PROGRESS',
  ...extra,
})
// Un servizio come lo restituisce /api/status: runtime e version sono i due check che servono.
const svc = (name, account, { type = 'ecs', tag = null, repo = null, da = null, by = null, rev = null, overall = 'up', deploying = false, task = [1, 1], target = null } = {}) => ({
  name,
  type,
  overall,
  account: { key: account },
  checks: {
    runtime: { desiredCount: task[1], runningCount: task[0], deploying, targetHealth: target && { total: target[1], healthy: target[0] } },
    version: { build: { tag, repo, revision: rev, deployedAt: da, by } },
  },
})
const lam = (name, account, da, by) => ({ name, type: 'lambda', overall: 'idle', account: { key: account }, checks: { version: { build: { deployedAt: da, by } } } })
const testo = (m) => JSON.stringify([...m.blocks, ...m.attachments[0].blocks])

test('le build: l’ultimo tentativo decide, un fallimento superato non tiene rosso, la durata tipica è la mediana', () => {
  assert.equal(statoBuild([b('api', 'a', '2026-10-01T10:00:00Z'), b('api', 'b', '2026-10-02T10:00:00Z', 'FAILED')]).stato, 'fallito')
  assert.equal(statoBuild([b('api', 'b', '2026-10-01T10:00:00Z', 'FAILED'), b('api', 'c', '2026-10-02T10:00:00Z')]).stato, 'ok')
  assert.equal(statoBuild([b('api', 'b', '2026-10-02T10:00:00Z', 'IN_PROGRESS')]).stato, 'in_corso')
  const s = statoBuild([
    b('api', 'a', '2026-10-01T10:00:00Z', 'SUCCEEDED', { durationMs: 300_000 }),
    b('api', 'b', '2026-10-01T11:00:00Z', 'SUCCEEDED', { durationMs: 360_000 }),
    b('api', 'c', '2026-10-01T12:00:00Z', 'SUCCEEDED', { durationMs: 900_000 }),
  ])
  assert.equal(s.durataTipica, 360_000, 'una build lenta isolata non sposta la mediana')
  assert.equal(statoBuild([]), null)
})

test('cosa gira lo dice ECS; autore, numero e durata vengono dalla build che l’ha prodotto', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-03T10:00:00Z', 'SUCCEEDED', { endedAt: '2026-10-03T10:06:00Z', author: 'dev@example.com', repo: 'https://github.com/x/api', number: 661, durationMs: 360_000, trigger: 'auto' })] } },
    servizi: [svc('acme-production-api', 'production', { tag: 'aaaaaaa1', repo: 'api', da: '2026-10-03T10:07:00Z', rev: 699, task: [3, 3], target: [6, 6] })],
  })
  const [r] = q.app
  assert.equal(r.servizio, 'api', 'il prefisso org-env si toglie, così ECS e CodeBuild si incontrano')
  assert.equal(r.commit, 'aaaaaaa')
  assert.equal(r.autore, 'dev')
  assert.equal(r.revisione, 699)
  assert.deepEqual(r.come, { tipo: 'ci', build: 661, durataMs: 360_000, chi: null })
  const v = voce(r, { ora: ORA })
  assert.equal(v.livello, 'recente')
  assert.equal(v.testo, '🚀  *api*  <https://github.com/x/api/commit/aaaaaaa|aaaaaaa>  ·  2 h fa')
  assert.deepEqual(v.dettagli.filter(Boolean), ['rev 699', '3/3 task, 6/6 target sani', 'build #661 della CI in 6 min', 'commit di dev'])
})

test('una revisione nuova sulla stessa immagine, molto dopo la build, non è quella build', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-02T10:00:00Z', 'SUCCEEDED', { endedAt: '2026-10-02T10:06:00Z', number: 661 })] } },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-03T09:00:00Z', by: 'doppler-sync', rev: 700 })],
  })
  assert.deepEqual(q.app[0].come, { tipo: 'revisione', chi: 'doppler-sync', build: 661 })
  assert.match(voce(q.app[0], { ora: ORA }).dettagli.join(' '), /revisione registrata da doppler-sync, immagine della build #661/)
})

test('una revisione promossa a mano, senza build, lo dice', () => {
  const q = quadroAmbiente('produzione', { servizi: [svc('api', 'production', { tag: 'bbbbbbbb', da: '2026-10-03T10:00:00Z', by: 'persona', rev: 128 })] })
  assert.match(voce(q.app[0], { ora: ORA }).dettagli.join(' '), /revisione registrata da persona, nessuna build/)
})

test('un riavvio a mano: stesso commit, e il «quando» è il riavvio', () => {
  const q = quadroAmbiente('produzione', {
    deploys: {
      production: {
        builds: [
          b('api', 'aaaaaaa', '2026-10-01T10:00:00Z', 'SUCCEEDED', { endedAt: '2026-10-01T10:06:00Z' }),
          { service: 'api', kind: 'restart', status: 'SUCCEEDED', startedAt: '2026-10-03T11:00:00Z', forcedBy: 'persona' },
        ],
      },
    },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-01T10:07:00Z' })],
  })
  assert.equal(q.app[0].come.tipo, 'riavvio')
  assert.equal(q.app[0].quando, '2026-10-03T11:00:00Z')
  assert.match(voce(q.app[0], { ora: ORA }).dettagli.join(' '), /riavviato a mano da persona/)
})

test('in corso: numero della build, da quanto, quanto dura di solito, da che commit a quale', () => {
  const q = quadroAmbiente('staging', {
    deploys: {
      staging: {
        builds: [
          b('api', 'aaaaaaa', '2026-10-02T10:00:00Z', 'SUCCEEDED', { durationMs: 360_000 }),
          b('api', 'bbbbbbb', '2026-10-03T11:57:00Z', 'IN_PROGRESS', { number: 662, phase: 'BUILD', author: 'dev@example.com' }),
        ],
      },
    },
    servizi: [svc('api', 'staging', { tag: 'aaaaaaa' })],
  })
  const v = voce(q.app[0], { ora: ORA })
  assert.equal(v.livello, 'adesso')
  assert.equal(v.testo, '⏳  *api*  build #662 in corso da 3 min, di solito 6 min')
  assert.deepEqual(v.dettagli.filter(Boolean).slice(0, 3), ['fase BUILD', 'da `aaaaaaa` a `bbbbbbb`', 'di dev'])
})

test('fallito: cosa gira ancora, il motivo e il log', () => {
  const q = quadroAmbiente('produzione', {
    deploys: {
      production: {
        builds: [
          b('api', 'aaaaaaa', '2026-10-02T10:00:00Z'),
          b('api', 'bbbbbbb', '2026-10-03T11:30:00Z', 'FAILED', { number: 662, failPhase: 'BUILD', failReason: 'COMMAND_EXECUTION_ERROR: exit status 1', logsUrl: 'https://log' }),
        ],
      },
    },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa', rev: 699 })],
  })
  const v = voce(q.app[0], { ora: ORA })
  assert.equal(v.testo, '🔴  *api*  build #662 fallita al BUILD 30 min fa')
  const d = v.dettagli.filter(Boolean).join(' · ')
  assert.match(d, /gira ancora `aaaaaaa` \(rev 699\)/)
  assert.match(d, /motivo: COMMAND_EXECUTION_ERROR: exit status 1/)
  assert.match(d, /<https:\/\/log\|log della build>/)
})

test('un servizio giù vince su tutto; un cron in rosso invece non è un deploy rotto', () => {
  const q = quadroAmbiente('staging', {
    deploys: { staging: { builds: [b('api', 'a', '2026-10-02T10:00:00Z', 'FAILED')] } },
    servizi: [
      svc('api', 'staging', { overall: 'down', task: [0, 2] }),
      svc('acme-staging-cron-pulizia', 'staging', { type: 'ecs-scheduled', tag: 'bbbbbbb', repo: 'jobs', overall: 'down' }),
      svc('acme-staging-cron-report', 'staging', { type: 'ecs-scheduled', tag: 'bbbbbbb', repo: 'jobs' }),
    ],
  })
  assert.equal(q.app[0].stato, 'giu')
  assert.equal(voce(q.app[0], { ora: ORA }).testo, '🚨  *api*  giù: 0/2 task attivi')
  assert.deepEqual(q.immagini[0].cron, ['pulizia', 'report'])
  assert.deepEqual(q.immagini[0].giu, [], 'il cron fallito lo racconta il canale dei cron')
})

test('immagini condivise senza build: una riga sola, e chi è rimasto indietro sale in «Adesso»', () => {
  const q = quadroAmbiente('produzione', {
    servizi: [
      svc('tenders', 'production', { tag: 'e4ce3020d1c2', repo: 'scraper', da: '2026-10-03T10:00:00Z', by: 'acme-production-refresh' }),
      svc('enrich', 'production', { tag: 'e4ce3020d1c2', repo: 'scraper', da: '2026-10-03T10:00:00Z' }),
      svc('acme-production-cron-shadow', 'production', { type: 'ecs-scheduled', tag: '3e2f9371c5f1', repo: 'scraper', da: '2026-10-03T08:00:00Z' }),
      svc('api', 'production', { tag: 'aaaaaaa', repo: 'api' }),
    ],
  })
  assert.deepEqual(q.app.map((r) => r.servizio), ['api'], 'chi sta in un’immagine condivisa non ha la sua riga')
  const [g] = q.immagini
  assert.deepEqual(g.servizi, ['enrich', 'tenders'])
  assert.deepEqual(g.indietro, [{ nome: 'shadow', tag: '3e2f937' }])
  assert.equal(g.chi, 'refresh', 'organizzazione e ambiente si tolgono dal nome dell’automatismo')
  const v = voce(g, { ora: ORA })
  assert.equal(v.livello, 'adesso')
  assert.equal(v.testo, '⚠️  *scraper*  1 di 3 su un’immagine più vecchia')
})

test('un repo condiviso da un servizio con una build sua NON è un’immagine condivisa', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('backend', 'aaaaaaa', '2026-10-02T10:00:00Z')] } },
    servizi: [svc('backend', 'production', { tag: 'aaaaaaa', repo: 'backend' }), svc('garanzia', 'production', { tag: 'aaaaaaa', repo: 'backend' })],
  })
  assert.equal(q.immagini.length, 0)
  assert.deepEqual(q.app.map((r) => r.servizio).sort(), ['backend', 'garanzia'])
})

test('i componenti esterni (tag di versione) stanno a parte, sia da soli sia condivisi', () => {
  const q = quadroAmbiente('produzione', {
    servizi: [
      svc('orchestratore', 'production', { tag: '3.6.26-python3.12', repo: 'orch', da: '2026-10-03T11:59:00Z', deploying: true }),
      svc('orchestratore-worker', 'production', { tag: '3.6.26-python3.12', repo: 'orch', da: '2026-10-03T11:59:00Z' }),
      svc('db-ui', 'production', { tag: 'v2.195.0', repo: 'db-ui', da: '2026-09-28T00:00:00Z' }),
      svc('api', 'production', { tag: 'aaaaaaa', repo: 'api', da: '2026-10-03T11:00:00Z' }),
    ],
  })
  assert.deepEqual(q.app.map((r) => r.servizio), ['api'])
  assert.deepEqual(q.esterni.map((e) => e.nome).sort(), ['db-ui', 'orch'])
  assert.equal(voce(q.esterni.find((e) => e.nome === 'orch'), { ora: ORA }).livello, 'adesso', 'un rollout in corso si vede')
})

test('le Lambda aggiornate insieme dalla stessa persona sono un giro solo', () => {
  const lotti = lottiLambda([
    { nome: 'a', da: '2026-10-03T10:00:00Z', chi: 'dev' },
    { nome: 'b', da: '2026-10-03T10:02:00Z', chi: 'dev' },
    { nome: 'c', da: '2026-10-03T10:14:00Z', chi: 'dev' },
    { nome: 'd', da: '2026-10-03T10:05:00Z', chi: 'codebuild-iac-1270' },
    { nome: 'e', da: '2026-10-03T11:00:00Z', chi: 'dev' },
    { nome: 'senza-data', da: null, chi: 'dev' },
  ])
  assert.deepEqual(
    lotti.map((l) => `${l.chi}:${l.nomi.join('+')}`),
    ['dev:e', 'dev:c', 'codebuild-iac-1270:d', 'dev:a+b'],
    'un altro autore in mezzo spezza il giro, e la finestra si misura dall’ultima del giro',
  )
  assert.equal(chiLeggibile('codebuild-iac-1270'), 'IaC (build #1270)')
  assert.equal(daChi(chiLeggibile('codebuild-iac-1270')), "dall'IaC (build #1270)", 'la preposizione si lega alla vocale')
  assert.equal(daChi('dev'), 'da dev')
  assert.equal(chiLeggibile('acme-production-nesso-refresh'), 'nesso-refresh')
})

test('una Lambda sola si chiama per nome, un giro si conta', () => {
  const una = voce({ tipo: 'lambda', n: 1, nomi: ['notifier'], chi: 'IaC (build #92)', quando: '2026-10-03T11:30:00Z' }, { ora: ORA })
  assert.equal(una.testo, '⚙️  *notifier*  Lambda aggiornata  ·  30 min fa')
  assert.deepEqual(una.dettagli.filter(Boolean), ["dall'IaC (build #92)"])
  const giro = voce({ tipo: 'lambda', n: 2, nomi: ['a', 'b'], chi: 'dev', quando: '2026-10-03T11:30:00Z' }, { ora: ORA })
  assert.equal(giro.testo, '⚙️  *2 Lambda aggiornate*  ·  30 min fa')
})

test('un avviso non è un guasto: la sintesi non lo colora di rosso', () => {
  const q = quadroAmbiente('produzione', {
    servizi: [
      svc('a', 'production', { tag: 'e4ce302', repo: 'img', da: '2026-10-03T10:00:00Z' }),
      svc('b', 'production', { tag: '29a157c', repo: 'img', da: '2026-10-03T08:00:00Z' }),
    ],
  })
  const m = messaggioQuadro(q, { ora: ORA })
  assert.match(m.text, /^Quadro deploy \[PROD\]: ⚠️ 1 da guardare/)
  assert.doesNotMatch(m.text, /🔴/)
})

test('le altre azioni a mano non diventano servizi, l’IaC ha la sua riga', () => {
  const q = quadroAmbiente('staging', {
    deploys: {
      staging: {
        builds: [
          b('api', 'a', '2026-10-02T10:00:00Z'),
          { service: 'sg-0abc', kind: 'sg-open', status: 'SUCCEEDED', startedAt: '2026-10-02T11:00:00Z' },
          { service: 'worker', kind: 'exec', status: 'SUCCEEDED', startedAt: '2026-10-02T11:00:00Z' },
          b('IaC', 'd25f688', '2026-10-03T11:00:00Z', 'IN_PROGRESS', { iac: true, author: 'dev@example.com', number: 1270 }),
        ],
      },
    },
  })
  assert.deepEqual(q.app.map((r) => r.servizio), ['api'])
  assert.equal(voce(q.infra, { ora: ORA }).testo, '⏳  *IaC*  apply in corso da 1 h')
})

test('produzione dice quando staging è su un altro commit, e solo lì', () => {
  const q = quadro({
    servizi: [svc('api', 'staging', { tag: 'abc1234' }), svc('api', 'production', { tag: 'def5678' }), svc('web', 'staging', { tag: 'aaaa000' }), svc('web', 'production', { tag: 'aaaa000' })],
  })
  assert.equal(q.produzione.app.find((r) => r.servizio === 'api').staging, 'abc1234')
  assert.equal(q.produzione.app.find((r) => r.servizio === 'web').staging, undefined)
  assert.ok(q.staging.app.every((r) => r.staging === undefined))
})

test('i link a Dadaguard sono già filtrati sulla risorsa della riga', () => {
  assert.equal(linkRisorsa({ tipo: 'app', servizio: 'api', chiave: 'production' }, URL), `${URL}/deploy?service=api&account=production`)
  assert.equal(linkRisorsa({ tipo: 'iac', chiave: 'staging' }, URL), `${URL}/deploy?service=IaC&account=staging`)
  assert.equal(linkRisorsa({ tipo: 'lambda', nomi: ['a', 'b'], chiave: 'production' }, URL), `${URL}/servizi?account=production&q=a%2Cb`)
  assert.equal(linkRisorsa({ tipo: 'immagine', servizi: ['x'], cron: ['y'], chiave: 'production' }, URL), `${URL}/servizi?account=production&q=x%2Cy`)
  const tanti = Array.from({ length: 200 }, (_, i) => `funzione-dal-nome-lungo-${i}`)
  assert.equal(linkRisorsa({ tipo: 'lambda', nomi: tanti, chiave: 'production' }, URL), `${URL}/servizi?account=production`, 'troppo lungo: la pagina intera, non un filtro tagliato')
  assert.equal(linkRisorsa({ tipo: 'app', servizio: 'api', chiave: 'production' }, null), null)
})

test('il filtro per nome della pagina Servizi accetta più nomi', () => {
  assert.equal(corrispondeNome('', 'qualsiasi'), true)
  assert.equal(corrispondeNome('email,follow', 'acme-production-cron-follow-competitor'), true)
  assert.equal(corrispondeNome('email, follow', 'acme-production-cron-release-recap'), false)
})

// Un ambiente come quello vero: tante risorse, poche novità.
function ambienteGrande() {
  const servizi = [
    ...Array.from({ length: 12 }, (_, i) => svc(`app-ferma-${i}`, 'production', { tag: `aaaaaa${i % 10}`, repo: `r${i}`, da: '2026-09-01T00:00:00Z' })),
    ...Array.from({ length: 40 }, (_, i) => lam(`acme-production-cron-vecchio-${i}`, 'production', '2026-09-01T00:00:00Z', 'dev')),
    ...Array.from({ length: 20 }, (_, i) => lam(`acme-production-cron-nuovo-${i}`, 'production', `2026-10-03T09:${String(i).padStart(2, '0')}:00Z`, 'dev')),
    ...Array.from({ length: 10 }, (_, i) => svc(`app-nuova-${i}`, 'production', { tag: `bbbbbb${i}`, repo: `n${i}`, da: `2026-10-03T0${i % 10}:30:00Z` })),
    svc('rotta', 'production', { tag: 'ccccccc', repo: 'rotta', overall: 'down', task: [0, 2] }),
  ]
  return quadroAmbiente('produzione', { servizi })
}

test('con una flotta grande il messaggio resta corto: «Adesso», poi al massimo 8 recenti, poi un conteggio', () => {
  const m = messaggioQuadro(ambienteGrande(), { ora: ORA, url: URL })
  const corpo = m.attachments[0].blocks
  const s = testo(m)
  assert.ok(corpo.length <= 30, `troppi blocchi: ${corpo.length}`)
  assert.ok(s.indexOf('*Adesso*') < s.indexOf('*Ultime 24 ore*'), 'prima i problemi')
  assert.match(s, /🚨  \*rotta\*  giù/)
  assert.match(s, /⚙️  \*20 Lambda aggiornate\*/, 'venti Lambda dello stesso giro sono una riga')
  assert.match(s, /e altri 3: <https:\/\/dg\.example\.com\/deploy\?account=production\|tutti su Dadaguard>/, '11 recenti, 8 righe e il resto contato')
  assert.match(s, /Senza novità nelle ultime 24 ore\*: 12 applicazioni  ·  40 Lambda/)
  assert.doesNotMatch(s, /app-ferma-3/, 'le risorse ferme non hanno righe')
  assert.match(s, /Dadaguard ›/, 'ogni riga porta alla sua risorsa')
  assert.doesNotMatch(s, /"type":"button"/, 'niente pulsanti: senza un indirizzo pubblico Slack li segna con un avviso')
  assert.doesNotMatch(s, /—/, 'niente trattino lungo')
  for (const x of corpo) {
    const t = x.text?.text ?? x.elements?.[0]?.text ?? ''
    assert.ok(t.length <= 3000, 'Slack rifiuta un testo oltre i 3000 caratteri')
  }
})

test('il messaggio: titolo al primo livello, barra del colore dell’ambiente, sintesi in testa', () => {
  const m = messaggioQuadro(ambienteGrande(), { ora: ORA, url: URL })
  assert.equal(m.blocks[0].type, 'header')
  assert.equal(m.blocks[0].text.text, '🟥  PRODUZIONE')
  assert.equal(m.attachments[0].color, '#E01E5A')
  assert.ok(!m.attachments[0].blocks.some((x) => x.type === 'header'), 'nessun header dentro l’allegato')
  assert.match(m.text, /^Quadro deploy \[PROD\]: 🔴 1 rotto · 🚀 11 rilasci nelle ultime 24 h/)
})

test('tutto tranquillo: la sintesi lo dice per prima', () => {
  const q = quadroAmbiente('staging', { servizi: [svc('api', 'staging', { tag: 'aaaaaaa', da: '2026-09-01T00:00:00Z' })] })
  const m = messaggioQuadro(q, { ora: ORA })
  assert.match(m.text, /^Quadro deploy \[STAGING\]: ✅ niente di rotto, niente in corso · 🚀 0 rilasci/)
  assert.match(testo(m), /nessun rilascio/)
})

test('l’anteprima col workspace apre il Builder sul messaggio, senza passare dal reindirizzamento', () => {
  const m = messaggioQuadro({ ambiente: 'staging', app: [], immagini: [], esterni: [], lambda: [], infra: null }, { ora: ORA })
  const url = anteprimaUrl(m, { team: 'T000TEST' })
  assert.match(url, /^https:\/\/app\.slack\.com\/block-kit-builder\/T000TEST\/builder#/)
  const payload = JSON.parse(decodeURIComponent(url.split('#')[1]))
  assert.equal(payload.blocks[0].type, 'header')
  assert.equal(payload.attachments[0].color, '#ECB22E')
})

test('si ritrova il quadro giusto, e solo se l’abbiamo scritto noi', () => {
  const items = [
    { type: 'message', message: { ts: '1', bot_id: 'ALTRO', text: 'Quadro deploy [PROD]: a mano' } },
    { type: 'message', message: { ts: '2', bot_id: 'NOI', text: 'x', metadata: { event_type: 'dadaguard_quadro', event_payload: { ambiente: 'staging' } } } },
    { type: 'message', message: { ts: '3', bot_id: 'NOI', text: 'Quadro deploy [PROD]: x' } },
  ]
  assert.equal(trovaFissato(items, { botId: 'NOI', ambiente: 'produzione' }), '3', 'senza metadati vale il testo')
  assert.equal(trovaFissato(items, { botId: 'NOI', ambiente: 'staging' }), '2')
  assert.equal(trovaFissato([], { botId: 'NOI', ambiente: 'staging' }), null)
})

test('il giro riscrive il quadro che c’è e crea e fissa quello che manca', async () => {
  const chiamate = []
  const api = async (metodo, corpo) => {
    chiamate.push([metodo, corpo])
    if (metodo === 'auth.test') return { bot_id: 'NOI' }
    if (metodo === 'pins.list') return { items: [{ type: 'message', message: { ts: '9', bot_id: 'NOI', text: 'Quadro deploy [PROD]: x' } }] }
    if (metodo === 'chat.postMessage') return { ts: '10' }
    return {}
  }
  const cfg = { ...quadroConfig({}), token: 'x', canale: 'C1' }
  const esiti = await aggiornaQuadri(cfg, { api, leggiDati: async () => ({ deploys: { production: { builds: [b('api', 'a', '2026-10-02T10:00:00Z')] } }, servizi: [] }) })
  assert.deepEqual(esiti.map((e) => `${e.ambiente}:${e.azione}`), ['produzione:riscritto', 'staging:creato'])
  assert.deepEqual(chiamate.map(([m]) => m), ['auth.test', 'pins.list', 'chat.update', 'chat.postMessage', 'pins.add'])
  assert.equal(chiamate.find(([m]) => m === 'pins.add')[1].timestamp, '10')
})

test('configurazione: senza token il quadro è spento, gli ambienti ignoti si scartano, la finestra ha un default', () => {
  assert.equal(quadroConfig({}).token, null)
  assert.deepEqual(quadroConfig({ DADAGUARD_QUADRO_AMBIENTI: 'staging, inventato' }).ambienti, ['staging'])
  assert.equal(quadroConfig({ DADAGUARD_QUADRO_ORE: 'mezza giornata' }).ore, 24)
  assert.equal(quadroConfig({ DADAGUARD_QUADRO_ORE: '48' }).ore, 48)
})

test('repo dell’immagine e progetto IaC, i due dati nuovi che il quadro legge', () => {
  assert.equal(imageRepo('123.dkr.ecr.eu-central-1.amazonaws.com/team/scraper:e4ce302'), 'scraper')
  assert.equal(imageRepo('scraper@sha256:abc'), 'scraper')
  assert.equal(imageRepo(null), null)
  assert.equal(serviceFromProject('acme-staging-iac-apply'), 'IaC')
  assert.equal(serviceFromProject('acme-staging-backend-deploy'), 'backend')
})
