// Il quadro dei deploy sostituisce la lettura all'indietro del canale dei rilasci: se sbaglia lo stato
// di un servizio lo sbaglia nel canvas in cima al canale, dove tutti lo guardano. Qui si inchiodano gli
// stati, l'unione fra ECS e CodeBuild, i raggruppamenti (immagini condivise, giri di Lambda), i tre
// piani del canvas coi loro tetti, i link a Dadaguard e il giro che crea o riscrive il canvas.
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
  cella,
  canvasQuadro,
  canvasDelCanale,
  aggiornaQuadri,
  quadroConfig,
  alle,
  guardiaQuadro,
  testoAvviso,
  pianoAllarmi,
  eseguiAllarmi,
  testoAllarme,
  datiAllarmi,
  dividi,
  canvasTrasversale,
  canvasDaScrivere,
  TITOLO_CRON,
} from '../server/notify/quadro.js'
import { imageRepo } from '../server/checks/version.js'
import { serviceFromProject } from '../server/deploys.js'
import { corrispondeNome } from '../web/filters.js'
import { statoLeggero } from '../server/quadroStato.js'

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
// Build lette e nessuna trovata: diverso da «non lette», che il quadro dichiara.
const LETTE_PROD = { production: { builds: [] } }
const LETTE_STG = { staging: { builds: [] } }

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
  assert.equal(v.emoji, '🚀')
  assert.equal(v.stato, '[aaaaaaa](https://github.com/x/api/commit/aaaaaaa) · alle 12:07')
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
  const q = quadroAmbiente('produzione', { deploys: LETTE_PROD, servizi: [svc('api', 'production', { tag: 'bbbbbbbb', da: '2026-10-03T10:00:00Z', by: 'persona', rev: 128 })] })
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
  assert.equal(v.emoji, '⏳')
  assert.equal(v.stato, 'build #662 in corso dalle 13:57, di solito 6 min')
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
  assert.equal(v.emoji, '❌')
  assert.equal(v.stato, 'build #662 fallita al BUILD alle 13:30')
  const d = v.dettagli.filter(Boolean).join(' · ')
  assert.match(d, /gira ancora `aaaaaaa` \(rev 699\)/)
  assert.match(d, /motivo: COMMAND_EXECUTION_ERROR: exit status 1/)
  assert.match(d, /\[log della build\]\(https:\/\/log\)/)
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
  const v = voce(q.app[0], { ora: ORA })
  assert.equal(`${v.emoji} ${v.stato}`, '🚨 giù: 0/2 task attivi')
  assert.deepEqual(q.immagini[0].cron, ['pulizia', 'report'])
  assert.deepEqual(q.immagini[0].giu, [], 'il cron fallito lo racconta il canale dei cron')
})

test('immagini condivise senza build: una riga sola, e chi è rimasto indietro sale in «Adesso»', () => {
  const q = quadroAmbiente('produzione', {
    deploys: LETTE_PROD,
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
  assert.equal(`${v.emoji} ${v.stato}`, '⚠️ 1 di 3 su un’immagine più vecchia')
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
    deploys: LETTE_PROD,
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
  assert.equal(una.nome, 'notifier')
  assert.equal(una.stato, 'Lambda aggiornata · alle 13:30')
  assert.deepEqual(una.dettagli.filter(Boolean), ["dall'IaC (build #92)"])
  const giro = voce({ tipo: 'lambda', n: 2, nomi: ['a', 'b'], chi: 'dev', quando: '2026-10-03T11:30:00Z' }, { ora: ORA })
  assert.equal(giro.nome, '2 Lambda')
  assert.equal(giro.stato, 'aggiornate insieme · alle 13:30')
  assert.deepEqual(giro.dettagli.filter(Boolean), ['da dev', 'a, b'])
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
  const v = voce(q.infra, { ora: ORA })
  assert.equal(`${v.emoji} ${v.nome}: ${v.stato}`, '⏳ IaC: apply in corso dalle 13:00')
})

test('build non lette: il quadro lo dice e non inventa niente che ne dipenda', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { error: 'Could not connect to the endpoint URL' } },
    servizi: [
      svc('backend', 'production', { tag: 'aaaaaaa', repo: 'backend', da: '2026-10-03T11:00:00Z', by: 'dev' }),
      svc('acme-production-cron-pulizia', 'production', { type: 'ecs-scheduled', tag: 'latest', repo: 'backend' }),
    ],
  })
  assert.equal(q.buildIgnote, true)
  assert.equal(q.immagini.length, 0, 'senza build non si sa chi ne ha una propria: niente gruppi')
  assert.deepEqual(q.app.map((r) => r.servizio), ['backend'])
  assert.equal(q.app[0].come, null, '«nessuna build» sarebbe inventato')
  const c = canvasQuadro(q, { ora: ORA })
  assert.match(c.sintesi, /⚠️ build non lette/)
  assert.doesNotMatch(c.sintesi, /niente di rotto/, 'non si sa, quindi non si dice')
  assert.match(c.markdown, /Build non lette\*\*: Could not connect to the endpoint URL/)
  assert.doesNotMatch(c.markdown, /nessuna build/)
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
    ...Array.from({ length: 14 }, (_, i) => svc(`app-nuova-${i}`, 'production', { tag: `bbbbbb${i % 10}`, repo: `n${i}`, da: `2026-10-03T0${i % 10}:${i < 10 ? '30' : '45'}:00Z` })),
    svc('rotta', 'production', { tag: 'ccccccc', repo: 'rotta', overall: 'down', task: [0, 2] }),
  ]
  return quadroAmbiente('produzione', { deploys: LETTE_PROD, servizi })
}

test('con una flotta grande il canvas resta corto: una tabella, prima i problemi, al massimo 12 rilasci, poi un conteggio', () => {
  const qa = ambienteGrande()
  const c = canvasQuadro(dividi(qa).principale, { ora: ORA, url: URL })
  const md = c.markdown
  assert.equal(c.titolo, '🟥 Quadro deploy PRODUZIONE')
  assert.doesNotMatch(md, /## Adesso|## Ultime/, 'niente sottotitoli: una tabella sola')
  assert.equal(md.split('\n').filter((l) => l.startsWith('| Risorsa')).length, 1, 'una tabella, una larghezza')
  assert.ok(md.indexOf('**rotta**') < md.indexOf('**app-nuova-9**'), 'prima i problemi, poi i rilasci')
  assert.match(md, /\| 🚨 \[\*\*rotta\*\*\]\(https:\/\/dg\.example\.com\/deploy\?service=rotta&account=production\) \| giù: 0\/2 task attivi \|/)
  assert.match(md, /E altri 2: \[tutti su Dadaguard\]\(https:\/\/dg\.example\.com\/deploy\?account=production\)\./, '14 recenti, 12 righe e il resto contato')
  assert.match(md, /\*\*Senza novità\*\* \(24 h\): 12 applicazioni  \|  Dadaguard: \[Deploy PROD\]/, 'il resto e i link in una riga sola')
  assert.doesNotMatch(md, /Lambda/, 'i cron Lambda stanno nella loro scheda')
  assert.doesNotMatch(md, /app-ferma-3/, 'le risorse ferme non hanno righe')
  assert.doesNotMatch(md, /\u2014/, 'niente trattino lungo')
  const righeRilasci = md.split('\n').filter((l) => l.startsWith('| 🚀'))
  assert.equal(righeRilasci.length, 12)
  assert.match(c.sintesi, /^❌ 1 rotto · 🚀 14 rilasci nelle ultime 24 h/)
  assert.match(md, /^## 🟥 Produzione\n\n\*\*❌ 1 rotto/, 'ogni scheda: titolo dell’ambiente, poi la sintesi')

  const cron = canvasTrasversale(TITOLO_CRON, [dividi(qa).cron], { ora: ORA, url: URL })
  assert.equal(cron.titolo, '⏰ Quadro deploy CRON')
  assert.doesNotMatch(cron.markdown, /aggiornato alle/, 'un orologio riscriverebbe il canvas ogni minuto')
  assert.match(cron.markdown, /## 🟥 Produzione\n\n\*\*✅ niente di rotto, niente in corso · 🚀 1 rilascio nelle ultime 24 h\*\*/)
  assert.match(cron.markdown, /\| ⚙️ \[\*\*20 Lambda\*\*\]\([^)]+\) \| aggiornate insieme/, 'venti Lambda dello stesso giro sono una riga')
  assert.match(cron.markdown, /\*\*Senza novità\*\* \(24 h\): 40 Lambda/)
})

test('tutto tranquillo: la sintesi lo dice per prima', () => {
  const q = quadroAmbiente('staging', { deploys: LETTE_STG, servizi: [svc('api', 'staging', { tag: 'aaaaaaa', da: '2026-09-01T00:00:00Z' })] })
  const c = canvasQuadro(q, { ora: ORA })
  assert.equal(c.titolo, '🟨 Quadro deploy STAGING')
  assert.match(c.sintesi, /^✅ niente di rotto, niente in corso · 🚀 0 rilasci/)
  assert.doesNotMatch(c.markdown, /\| Risorsa/, 'niente righe, niente tabella vuota')
})

test('un avviso non è un guasto: la sintesi non lo colora di rosso', () => {
  const q = quadroAmbiente('produzione', {
    deploys: LETTE_PROD,
    servizi: [
      svc('a', 'production', { tag: 'e4ce302', repo: 'img', da: '2026-10-03T10:00:00Z' }),
      svc('b', 'production', { tag: '29a157c', repo: 'img', da: '2026-10-03T08:00:00Z' }),
    ],
  })
  const c = canvasQuadro(q, { ora: ORA })
  assert.match(c.sintesi, /^⚠️ 1 da guardare/)
  assert.doesNotMatch(c.sintesi, /❌/)
})

test('una cella non rompe la tabella: niente `|` né a capo che arrivino da fuori', () => {
  assert.equal(cella('exit status 1 | grep\nriga due'), 'exit status 1 \\| grep riga due')
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-02T10:00:00Z'), b('api', 'bbbbbbb', '2026-10-03T11:30:00Z', 'FAILED', { failReason: 'a | b\nc' })] } },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa' })],
  })
  const riga = canvasQuadro(q, { ora: ORA }).markdown.split('\n').find((l) => l.includes('**api**'))
  assert.equal(riga.split(/(?<!\\)\|/).length, 5, 'tre celle, quindi quattro separatori')
})

test('il nostro canvas si trova fra le SCHEDE del canale, dal titolo', () => {
  const T = '🟥 Quadro deploy PRODUZIONE'
  const scheda = (file_id, label, shared_ts) => ({ type: 'canvas', label, data: { file_id, shared_ts } })
  const info = (tabs) => ({ channel: { properties: { tabs, canvas: null } } })
  // Slack scrive l'emoji dell'etichetta come codice: il testo basta a riconoscerlo.
  assert.deepEqual(canvasDelCanale(info([{ type: 'files' }, scheda('F1', ':large_red_square: Quadro deploy PRODUZIONE', '1')]), T), { id: 'F1', doppioni: [] })
  assert.deepEqual(canvasDelCanale(info([scheda('F2', '🟥 Quadro deploy PRODUZIONE', '1')]), T), { id: 'F2', doppioni: [] })
  // Due del quadro: vince il più recente, l'altro si dice e non si cancella.
  assert.deepEqual(canvasDelCanale(info([scheda('VECCHIO', ':large_red_square: Quadro deploy PRODUZIONE', '1'), scheda('NUOVO', ':large_red_square: Quadro deploy PRODUZIONE', '2')]), T), {
    id: 'NUOVO',
    doppioni: ['VECCHIO'],
  })
  // Un canvas di qualcun altro, o senza titolo, non è il nostro: riscriverlo cancellerebbe il suo lavoro.
  assert.deepEqual(canvasDelCanale(info([scheda('ALTRO', 'Quadro deploy PRODUZIONE, appunti', '3'), scheda('SENZA', '', '4')]), T), { id: null, doppioni: [] })
  assert.deepEqual(canvasDelCanale(info([scheda('STG', ':large_yellow_square: Quadro deploy STAGING', '1')]), T), { id: null, doppioni: [] }, 'l’altro ambiente non è questo')
  // ⚠️ `properties.canvas` resta vuoto anche quando il canale ha canvas: è lì che il giro di prova del
  // 04/10/2026 guardava, e ne ha creato uno nuovo a ogni giro.
  assert.deepEqual(canvasDelCanale({ channel: { properties: { canvas: { file_id: 'NON_QUI' } } } }, T), { id: null, doppioni: [] })
  assert.deepEqual(canvasDelCanale(null, T), { id: null, doppioni: [] })
})

test('il giro riscrive il canvas che c’è, crea quello che manca, e un ambiente rotto non ferma l’altro', async () => {
  const chiamate = []
  const api = async (metodo, corpo) => {
    chiamate.push([metodo, corpo])
    if (metodo === 'conversations.info')
      return corpo.channel === 'CPROD'
        ? { channel: { properties: { tabs: [{ type: 'canvas', label: ':large_red_square: Quadro deploy PRODUZIONE', data: { file_id: 'FPROD', shared_ts: '1' } }] } } }
        : { channel: { properties: { tabs: [{ type: 'files' }] } } }
    if (metodo === 'conversations.canvases.create') return { canvas_id: 'FSTG' }
    return {}
  }
  const cfg = quadroConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'x', DADAGUARD_QUADRO_CANALI: 'produzione=CPROD,staging=CSTG' })
  const leggiDati = async () => ({ deploys: { production: { builds: [b('api', 'a', '2026-10-02T10:00:00Z')] }, staging: { builds: [] } }, servizi: [] })
  const esiti = await aggiornaQuadri(cfg, { api, leggiDati, ora: ORA })
  assert.deepEqual(esiti.map((e) => `${e.ambiente}:${e.azione}`), ['produzione:riscritto', 'staging:creato', 'cron:creato'])
  assert.equal(chiamate.filter(([m, c]) => m === 'conversations.canvases.create' && c.title === '⏰ Quadro deploy CRON')[0][1].channel_id, 'CPROD', 'le schede trasversali stanno nel canale del primo ambiente')
  assert.equal(chiamate.filter(([m, c]) => m === 'conversations.info' && c.channel === 'CPROD').length, 1, 'le schede di un canale si chiedono una volta per giro')
  assert.ok(esiti.find((e) => e.ambiente === 'produzione').allarmi, 'gli ambienti portano i dati degli allarmi')
  assert.equal(esiti.find((e) => e.ambiente === 'cron').allarmi, undefined, 'le schede trasversali no: gli allarmi sono per ambiente')
  const edit = chiamate.find(([m]) => m === 'canvases.edit')[1]
  assert.equal(edit.canvas_id, 'FPROD')
  assert.equal(edit.changes[0].operation, 'replace', 'il quadro si riscrive intero')
  assert.equal(edit.changes[0].document_content.type, 'markdown')
  const crea = chiamate.find(([m]) => m === 'conversations.canvases.create')[1]
  assert.equal(crea.channel_id, 'CSTG')
  assert.equal(crea.title, '🟨 Quadro deploy STAGING')
  assert.deepEqual(chiamate.find(([m]) => m === 'canvases.access.set')[1], { canvas_id: 'FSTG', access_level: 'read', channel_ids: ['CSTG'] })

  const rotta = async (metodo, corpo) => {
    if (metodo === 'conversations.info' && corpo.channel === 'CPROD') throw new Error('slack conversations.info: channel_not_found')
    return api(metodo, corpo)
  }
  const esiti2 = await aggiornaQuadri(cfg, { api: rotta, leggiDati, ora: ORA })
  assert.deepEqual(esiti2.map((e) => `${e.ambiente}:${e.azione}`), ['produzione:errore', 'staging:creato', 'cron:errore'])
  assert.match(esiti2[0].errore, /channel_not_found/)
})

test('configurazione: un canale per ambiente, nell’ordine scritto; senza canali il quadro è spento', () => {
  const cfg = quadroConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'x', DADAGUARD_QUADRO_CANALI: 'staging = C2, produzione=C1, inventato=C3' })
  assert.deepEqual(cfg.canali, { staging: 'C2', produzione: 'C1' })
  assert.deepEqual(cfg.ambienti, ['staging', 'produzione'])
  const vuota = quadroConfig({})
  assert.equal(vuota.token, null)
  assert.deepEqual(vuota.canali, {})
  assert.deepEqual(vuota.ambienti, ['produzione', 'staging'], 'l’anteprima li calcola comunque tutti e due')
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

test('la guardia: un quadro fermo da 10 minuti si dice una volta, e una volta quando torna', () => {
  const min = (n) => Date.parse('2026-10-04T08:00:00Z') + n * 60_000
  const ok = [{ ambiente: 'produzione', azione: 'riscritto' }]
  const ko = [{ ambiente: 'produzione', azione: 'errore', errore: 'slack canvases.edit: not_authed' }]
  let g = guardiaQuadro({}, ok, { ora: min(0) })
  assert.deepEqual(g.avvisi, [])
  g = guardiaQuadro(g.stato, ko, { ora: min(5) })
  assert.deepEqual(g.avvisi, [], 'cinque minuti di errori non sono ancora un quadro fermo')
  g = guardiaQuadro(g.stato, ko, { ora: min(10) })
  assert.deepEqual(g.avvisi.map((a) => a.tipo), ['fermo'])
  assert.equal(g.avvisi[0].errore, 'slack canvases.edit: not_authed')
  g = guardiaQuadro(g.stato, ko, { ora: min(11) })
  assert.deepEqual(g.avvisi, [], 'una volta sola, non a ogni giro')
  g = guardiaQuadro(g.stato, ok, { ora: min(12) })
  assert.deepEqual(g.avvisi.map((a) => a.tipo), ['rientrato'])
  g = guardiaQuadro(g.stato, ok, { ora: min(13) })
  assert.deepEqual(g.avvisi, [])
})

test('la guardia: un quadro che non riesce mai avvisa dopo 10 minuti dall’avvio', () => {
  const avvio = Date.parse('2026-10-04T08:00:00Z')
  const ko = [{ ambiente: 'staging', azione: 'errore', errore: 'x' }]
  assert.deepEqual(guardiaQuadro({}, ko, { ora: avvio + 9 * 60_000, avvio }).avvisi, [])
  assert.deepEqual(guardiaQuadro({}, ko, { ora: avvio + 10 * 60_000, avvio }).avvisi.map((a) => a.tipo), ['fermo'])
})

test('il testo dell’avviso segue la grammatica del canale degli allarmi', () => {
  const ora = Date.parse('2026-10-04T08:12:00Z')
  const fermo = testoAvviso({ ambiente: 'produzione', tipo: 'fermo', fermoDa: Date.parse('2026-10-04T08:00:00Z'), errore: 'slack canvases.edit: not_authed' }, { ora, url: URL })
  assert.equal(fermo, '⚠️ `quadro deploy` [PROD] FERMO · il canvas non si aggiorna da 12 min · ultimo errore: slack canvases.edit: not_authed · <https://dg.example.com/deploy|deploy su Dadaguard>')
  assert.equal(testoAvviso({ ambiente: 'staging', tipo: 'rientrato', fermoDa: Date.parse('2026-10-04T08:00:00Z') }, { ora }), '✅ `quadro deploy` [STAGING] rientrato · di nuovo aggiornato dopo 12 min fermo')
  assert.doesNotMatch(fermo, /\u2014/, 'niente trattino lungo')
})

test('allarmi: si apre quando si rompe, si aggiorna se si rompe di nuovo, si chiude quando torna', () => {
  const rotto = (firma) => ({ rotti: [{ nome: 'api', firma, testo: `❌ \`api\` [PROD] build fallita (${firma})` }], inCorso: [], buildIgnote: false })
  const sano = { rotti: [], inCorso: [], buildIgnote: false }
  let p = pianoAllarmi({}, rotto('A'))
  assert.deepEqual(p.azioni.map((z) => z.tipo), ['apri'])
  p.aperti.api.ts = '111'
  p = pianoAllarmi(p.aperti, rotto('A'))
  assert.deepEqual(p.azioni, [], 'stessa firma: niente da dire, a ogni giro')
  p = pianoAllarmi(p.aperti, rotto('B'))
  assert.deepEqual(p.azioni.map((z) => `${z.tipo}:${z.ts}`), ['ancora:111'], 'un guasto nuovo va nella discussione, non in un messaggio nuovo')
  p = pianoAllarmi(p.aperti, { ...sano, inCorso: ['api'] })
  assert.deepEqual(p.azioni, [], 'un rilascio ripartito non ha ancora riparato niente')
  p = pianoAllarmi(p.aperti, { ...sano, buildIgnote: true })
  assert.deepEqual(p.azioni, [], 'con le build non lette non si chiude')
  p = pianoAllarmi(p.aperti, sano)
  assert.deepEqual(p.azioni.map((z) => `${z.tipo}:${z.ts}`), ['chiudi:111'])
  assert.deepEqual(p.aperti, {})
})

test('allarmi: il primo giro prende nota senza scrivere, e senza dati non si tocca niente', () => {
  const dati = { rotti: [{ nome: 'api', firma: 'A', testo: 'x' }], inCorso: [], buildIgnote: false }
  const p = pianoAllarmi({}, dati, { primoGiro: true })
  assert.deepEqual(p.azioni, [])
  assert.ok(p.aperti.api, 'preso nota: al giro dopo non è «nuovo»')
  assert.deepEqual(pianoAllarmi({ api: { ts: '1', firma: 'A', testo: 'x' } }, null).azioni, [], 'un giro senza dati non è «tutto risolto»')
})

test('allarmi: il testo segue la grammatica del canale e porta i link in forma Slack', () => {
  const x = {
    emoji: '❌',
    nome: 'backend',
    stato: 'build #662 fallita al BUILD 2 min fa',
    dettagli: ['gira ancora [d5fda1e](https://github.com/x/b/commit/d5fda1e) (rev 130)', null, 'motivo: exit status 1', '[log della build](https://log)'],
    link: 'https://dg.example.com/deploy?service=backend&account=production',
  }
  assert.equal(
    testoAllarme(x, 'produzione'),
    '❌ `backend` [PROD] build #662 fallita al BUILD 2 min fa · gira ancora <https://github.com/x/b/commit/d5fda1e|d5fda1e> (rev 130) · motivo: exit status 1 · <https://log|log della build> · <https://dg.example.com/deploy?service=backend&account=production|Dadaguard>',
  )
})

test('allarmi: dai dati del quadro, rotti e in corso, con una firma che non cambia con l’orologio', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-02T10:00:00Z'), b('api', 'bbbbbbb', '2026-10-03T11:30:00Z', 'FAILED')] } },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa' }), svc('web', 'production', { tag: 'ccccccc', deploying: true })],
  })
  const prima = datiAllarmi(q, { ora: ORA })
  const dopo = datiAllarmi(q, { ora: ORA + 5 * 60_000 })
  assert.deepEqual(prima.rotti.map((r) => r.nome), ['api'])
  assert.deepEqual(prima.inCorso, ['web'])
  assert.equal(prima.rotti[0].firma, dopo.rotti[0].firma, 'cinque minuti dopo è lo stesso guasto')
  assert.equal(datiAllarmi(undefined), null)
})

test('allarmi: si scrivono nel canale, il ✅ va nella discussione e cambia il messaggio', async () => {
  const chiamate = []
  const api = async (metodo, corpo) => {
    chiamate.push([metodo, corpo])
    return metodo === 'chat.postMessage' && !corpo.thread_ts ? { ts: '222' } : {}
  }
  let aperti = await eseguiAllarmi(api, 'C1', pianoAllarmi({}, { rotti: [{ nome: 'api', firma: 'A', testo: '❌ `api` [PROD] fallita' }], inCorso: [], buildIgnote: false }))
  assert.equal(aperti.api.ts, '222')
  aperti = await eseguiAllarmi(api, 'C1', pianoAllarmi(aperti, { rotti: [], inCorso: [], buildIgnote: false }), { ora: Date.parse('2026-10-04T08:30:00Z') })
  assert.deepEqual(aperti, {})
  const [, risposta] = chiamate.find(([m, c]) => m === 'chat.postMessage' && c.thread_ts)
  assert.equal(risposta.thread_ts, '222')
  assert.equal(risposta.text, '✅ risolto alle 10:30')
  const [, modifica] = chiamate.find(([m]) => m === 'chat.update')
  assert.equal(modifica.text, '✅ `api` [PROD] fallita · risolto alle 10:30')

  const rotta = async () => {
    throw new Error('slack chat.postMessage: not_in_channel')
  }
  const dopo = await eseguiAllarmi(rotta, 'C1', pianoAllarmi({}, { rotti: [{ nome: 'api', firma: 'A', testo: 'x' }], inCorso: [], buildIgnote: false }))
  assert.deepEqual(dopo, {}, 'un allarme non scritto non resta aperto senza messaggio: il giro dopo riprova')
})

test('le schede: la squadra vince, poi i cron, il resto è della principale', () => {
  const qa = quadroAmbiente('produzione', {
    deploys: {
      production: {
        builds: [
          b('scraper-dashboard', 'aaaaaaa', '2026-10-03T10:00:00Z', 'SUCCEEDED', { repo: 'https://github.com/acme/Scraper.git' }),
          b('api', 'bbbbbbb', '2026-10-03T10:00:00Z', 'SUCCEEDED', { repo: 'https://github.com/acme/Backend' }),
        ],
      },
    },
    servizi: [
      svc('acme-production-scraper-dashboard', 'production', { tag: 'aaaaaaa', repo: 'scraper-dashboard', da: '2026-10-03T10:05:00Z' }),
      svc('acme-production-api', 'production', { tag: 'bbbbbbb', repo: 'api', da: '2026-10-03T10:05:00Z' }),
      svc('tenders', 'production', { tag: 'e4ce302', repo: 'scraper-image', da: '2026-10-03T09:00:00Z' }),
      svc('acme-production-cron-shadow', 'production', { type: 'ecs-scheduled', tag: 'e4ce302', repo: 'scraper-image', da: '2026-10-03T09:00:00Z' }),
      svc('acme-production-cron-backup-a', 'production', { type: 'ecs-scheduled', tag: 'ccccccc', repo: 'backup', da: '2026-10-03T08:00:00Z' }),
      svc('acme-production-cron-backup-b', 'production', { type: 'ecs-scheduled', tag: 'ccccccc', repo: 'backup', da: '2026-10-03T08:00:00Z' }),
      lam('acme-production-cron-report', 'production', '2026-10-03T07:00:00Z', 'dev'),
      lam('acme-production-deploy-notifier', 'production', '2026-10-03T07:00:00Z', 'codebuild-iac-12'),
    ],
  })
  const d = dividi(qa, { squadre: { data: ['scraper', 'scraper-image'] } })
  assert.deepEqual(d.squadre.data.app.map((r) => r.servizio), ['scraper-dashboard'], 'dal sorgente della build, senza badare alle maiuscole')
  assert.deepEqual(d.squadre.data.immagini.map((g) => g.nome), ['scraper-image'], 'dal repo dell’immagine, cron compresi: la squadra vince')
  assert.deepEqual(d.principale.app.map((r) => r.servizio), ['api'])
  assert.deepEqual(d.cron.immagini.map((g) => g.nome), ['backup'], 'un’immagine fatta di soli cron è dei cron')
  assert.deepEqual(d.cron.lambda.flatMap((l) => l.nomi), ['report'])
  assert.deepEqual(d.principale.lambda.flatMap((l) => l.nomi), ['deploy-notifier'], 'le Lambda dell’infrastruttura restano nella principale')
  assert.equal(dividi(undefined), null)
})

test('configurazione delle squadre: nomi e repository in minuscolo, righe vuote scartate', () => {
  const cfg = quadroConfig({ DADAGUARD_QUADRO_SQUADRE: 'Data=Scraper, scraper-image;vuota=;=x' })
  assert.deepEqual(cfg.squadre, { data: ['scraper', 'scraper-image'] })
  assert.deepEqual(quadroConfig({}).squadre, {})
})

test('i canvas di un giro: uno per ambiente, poi ⏰ CRON e uno per squadra, nel canale del primo ambiente', () => {
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP,staging=CS', DADAGUARD_QUADRO_SQUADRE: 'data=scraper' })
  const q = quadro({ deploys: LETTE_PROD, servizi: [] }, cfg.ambienti)
  const c = canvasDaScrivere(q, cfg, { ora: ORA })
  assert.deepEqual(c.map((x) => `${x.chiave}:${x.canale}:${x.titolo}`), [
    'produzione:CP:🟥 Quadro deploy PRODUZIONE',
    'staging:CS:🟨 Quadro deploy STAGING',
    'cron:CP:⏰ Quadro deploy CRON',
    'data:CP:📊 Quadro deploy DATA',
  ])
  assert.match(c[3].markdown, /## 🟥 Produzione[\s\S]*## 🟨 Staging/, 'una sezione per ambiente')
})

test('lettore leggero: solo le risorse che si rilasciano, e il runtime solo dei servizi ECS', async () => {
  const chiamati = []
  const resolve = async () => ({
    accounts: { production: { profile: 'p', region: 'eu-central-1' } },
    people: null,
    soglie: null,
    services: [
      { name: 'api', account: 'production', aws: { type: 'ecs' } },
      { name: 'acme-production-cron-x', account: 'production', aws: { type: 'lambda' } },
      { name: 'shadow', account: 'production', aws: { type: 'ecs-scheduled' } },
      { name: 'db', account: 'production', aws: { type: 'rds' } },
    ],
  })
  const controlli = {
    version: async (s) => (chiamati.push(`version:${s.name}`), { key: 'version', build: { tag: 'aaaaaaa' } }),
    runtime: async (s) => (chiamati.push(`runtime:${s.name}`), { key: 'runtime', status: 'down', desiredCount: 2, runningCount: 0 }),
  }
  const voci = await statoLeggero({ resolve, controlli })
  assert.deepEqual(voci.map((v) => `${v.type}:${v.name}`), ['ecs:api', 'lambda:acme-production-cron-x', 'ecs-scheduled:shadow'], 'un database non si rilascia')
  assert.deepEqual(chiamati.filter((c) => c.startsWith('runtime')), ['runtime:api'], 'il runtime di Lambda e cron legge metriche a pagamento')
  assert.equal(voci[0].overall, 'down')
  assert.deepEqual(voci[0].account, { key: 'production' })
  assert.equal(voci[0].checks.version.build.tag, 'aaaaaaa')
  const q = quadroAmbiente('produzione', { deploys: LETTE_PROD, servizi: voci })
  assert.equal(q.app[0].stato, 'giu', 'la forma è quella che il quadro si aspetta')
})

test('un canvas uguale all’ultimo scritto non si riscrive, e senza orologio resta uguale finché non succede qualcosa', async () => {
  const chiamate = []
  const api = async (metodo, corpo) => {
    chiamate.push(metodo)
    if (metodo === 'conversations.info') return { channel: { properties: { tabs: [
      { type: 'canvas', label: ':large_red_square: Quadro deploy PRODUZIONE', data: { file_id: 'FP', shared_ts: '1' } },
      { type: 'canvas', label: ':alarm_clock: Quadro deploy CRON', data: { file_id: 'FC', shared_ts: '1' } },
    ] } } }
    return {}
  }
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP' })
  const leggiDati = async () => ({ deploys: LETTE_PROD, servizi: [] })
  const ultimi = new Map()
  const primo = await aggiornaQuadri(cfg, { api, leggiDati, ora: ORA, ultimi })
  assert.deepEqual(primo.map((e) => e.azione), ['riscritto', 'riscritto'])
  const secondo = await aggiornaQuadri(cfg, { api, leggiDati, ora: ORA + 20_000, ultimi })
  assert.deepEqual(secondo.map((e) => e.azione), ['invariato', 'invariato'], 'stesso minuto, stesso contenuto')
  assert.equal(chiamate.filter((m) => m === 'canvases.edit').length, 2)
  const terzo = await aggiornaQuadri(cfg, { api, leggiDati, ora: ORA + 30 * 60_000, ultimi })
  assert.deepEqual(terzo.map((e) => e.azione), ['invariato', 'invariato'], 'mezz’ora dopo, se non è successo niente, niente da riscrivere')
  const conDeploy = async () => ({ deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-03T12:10:00Z')] } }, servizi: [] })
  const quarto = await aggiornaQuadri(cfg, { api, leggiDati: conDeploy, ora: ORA + 31 * 60_000, ultimi })
  assert.equal(quarto[0].azione, 'riscritto', 'un rilascio nuovo sì')
})

test('gli orari sono fissi e in ora di Roma: oggi, ieri, o la data', () => {
  const ora = Date.parse('2026-10-05T10:00:00Z') // 12:00 a Roma
  assert.equal(alle('2026-10-05T06:10:00Z', ora), 'alle 08:10')
  assert.equal(alle('2026-10-04T16:30:00Z', ora), 'ieri alle 18:30')
  assert.equal(alle('2026-10-03T16:30:00Z', ora), 'il 03/10 alle 18:30')
  assert.equal(alle('2026-10-04T22:30:00Z', ora), 'alle 00:30', 'la mezzanotte è quella di Roma, non di Greenwich')
  assert.equal(alle(null, ora), '?')
})

test('allarmi: nel canale dei deploy solo i rilasci rotti, non i servizi giù', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-02T10:00:00Z'), b('api', 'bbbbbbb', '2026-10-03T11:30:00Z', 'FAILED')] } },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa' }), svc('web', 'production', { tag: 'ccccccc', overall: 'down', task: [0, 2] })],
  })
  assert.deepEqual(datiAllarmi(q, { ora: ORA }).rotti.map((r) => r.nome), ['api'], 'web è giù: lo dice il watchdog')
})
