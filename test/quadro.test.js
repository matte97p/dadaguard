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
  listeDaScrivere,
  regoleSquadre,
  TITOLO_CRON,
  leggiCanvasHtml,
  pianoCelle,
  testoPiatto,
  righeTabella,
  conTest,
  quandoBreve,
  nuovaMemoriaListe,
  SCHEMA_LISTA,
  STATI,
  MAX_MODIFICHE_GIRO,
  stessoTitolo,
  AMBIENTI,
  listaVecchia,
  celleLista,
} from '../server/notify/quadro.js'
import { log } from '../server/log.js'
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

test('la build che rilascia una Lambda non diventa una riga a sé: la Lambda resta la sua, in CRON se è un cron', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('report', 'aaaaaaa', '2026-10-03T10:00:00Z'), b('sito', 'bbbbbbb', '2026-10-03T10:00:00Z')] } },
    servizi: [lam('acme-production-cron-report', 'production', '2026-10-03T10:05:00Z', 'dev')],
  })
  assert.deepEqual(q.app.map((r) => r.servizio), ['sito'], 'un sito statico si conosce solo dalle build e resta una riga')
  const d = dividi(q)
  assert.deepEqual(d.principale.app.map((r) => r.servizio), ['sito'])
  assert.deepEqual(d.cron.lambda.map((l) => l.nomi), [['report']], 'la Lambda resta in CRON, una volta sola')
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
  const cron = q.app.filter((r) => r.cron)
  assert.deepEqual(cron.map((r) => r.servizio), ['pulizia', 'report'], 'ogni cron ECS ha la sua riga')
  assert.deepEqual(cron.map((r) => r.stato), ['ok', 'ok'], 'il cron fallito lo racconta il canale dei cron')
})

test('immagini condivise senza build: una riga per risorsa, e chi è rimasto indietro sale in «Adesso»', () => {
  const q = quadroAmbiente('produzione', {
    deploys: LETTE_PROD,
    servizi: [
      svc('tenders', 'production', { tag: 'e4ce3020d1c2', repo: 'scraper', da: '2026-10-03T10:00:00Z', by: 'acme-production-refresh' }),
      svc('enrich', 'production', { tag: 'e4ce3020d1c2', repo: 'scraper', da: '2026-10-03T10:00:00Z' }),
      svc('acme-production-cron-shadow', 'production', { type: 'ecs-scheduled', tag: '3e2f9371c5f1', repo: 'scraper', da: '2026-10-03T08:00:00Z' }),
      svc('api', 'production', { tag: 'aaaaaaa', repo: 'api' }),
    ],
  })
  assert.deepEqual(q.app.map((r) => r.servizio).sort(), ['api', 'enrich', 'shadow', 'tenders'], 'l’immagine condivisa non fa una riga sua: ogni risorsa ha la sua')
  const per = Object.fromEntries(righeTabella(q, { ora: ORA }).map((r) => [r.nome, r]))
  assert.equal(per.tenders.stato, 'deploy_ok')
  assert.match(per.tenders.dettagli, /stessa immagine di 3$/, 'il raggruppamento sta nei Dettagli')
  assert.equal(per.shadow.stato, 'indietro')
  assert.equal(per.shadow.celle[2], '`3e2f937` · la più recente è `e4ce302` · stessa immagine di 3')
  assert.doesNotMatch(per.api.dettagli, /stessa immagine/, 'un’immagine sola non si dice')
  const v = voce(q.app.find((r) => r.servizio === 'shadow'), { ora: ORA })
  assert.equal(v.livello, 'adesso')
  assert.equal(`${v.emoji} ${v.stato}`, '⚠️ su un’immagine più vecchia')
  assert.match(canvasQuadro(q, { ora: ORA }).sintesi, /⚠️ 1 da guardare/)
})

test('un repo condiviso da un servizio con una build sua: nessuno è «indietro», ha un’altra strada di rilascio', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('backend', 'aaaaaaa', '2026-10-02T10:00:00Z')] } },
    servizi: [svc('backend', 'production', { tag: 'aaaaaaa', repo: 'backend' }), svc('acme-production-cron-pulizia', 'production', { type: 'ecs-scheduled', tag: 'latest', repo: 'backend' })],
  })
  assert.deepEqual(q.app.map((r) => r.servizio), ['backend', 'pulizia'], 'anche il cron ECS senza build ha la sua riga')
  assert.deepEqual(q.app.map((r) => r.condivisa), [{ n: 2, tag: 'aaaaaaa', indietro: false }, { n: 2, tag: 'aaaaaaa', indietro: false }])
  assert.equal(q.esterni.length, 0, '`latest` non è un commit, ma nemmeno una versione: non è un componente esterno')
})

test('i componenti esterni (tag di versione) hanno una riga per risorsa, condivisi o no', () => {
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
  assert.deepEqual(q.esterni.map((e) => e.nome).sort(), ['db-ui', 'orchestratore', 'orchestratore-worker'])
  assert.equal(voce(q.esterni.find((e) => e.nome === 'orchestratore'), { ora: ORA }).livello, 'adesso', 'un rollout in corso si vede')
  const worker = righeTabella(q, { ora: ORA }).find((r) => r.nome === 'orchestratore-worker')
  assert.equal(worker.celle[2], '`3.6.26-python3.12` · esterno · stessa immagine di 2')
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
  assert.deepEqual(q.app.map((r) => r.servizio), ['backend', 'pulizia'], 'le righe sono le stesse di quando le build si leggono')
  assert.equal(q.app[1].condivisa.indietro, false, 'senza build non si sa chi ne ha una propria: nessuno è «indietro»')
  assert.equal(q.incompleto, true)
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
  assert.equal(linkRisorsa({ tipo: 'esterno', nomi: ['x'], chiave: 'production' }, URL), `${URL}/servizi?account=production&q=x`)
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

test('tabella stabile: TUTTE le risorse, in ordine alfabetico, tre colonne, e il nome senza emoji', () => {
  const qa = ambienteGrande()
  const c = canvasQuadro(dividi(qa).principale, { ora: ORA, url: URL })
  const md = c.markdown
  assert.equal(c.titolo, 'Quadro deploy PRODUZIONE')
  assert.doesNotMatch(md, /## Adesso|## Ultime/, 'niente sottotitoli: una tabella sola')
  assert.equal(md.split('\n').filter((l) => l.startsWith('| Risorsa | Stato | Dettagli |')).length, 1, 'una tabella, tre colonne: la versione apre i Dettagli')
  const righe = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Risorsa'))
  assert.equal(righe.length, 27, '12 ferme, 14 nuove e quella giù: anche le ferme hanno la loro riga')
  const nomi = righe.map((l) => /\*\*([^*]+)\*\*/.exec(l)[1])
  assert.deepEqual(nomi, [...nomi].sort((a, b) => a.localeCompare(b, 'it', { numeric: true })), 'in ordine alfabetico, non per gravità né per data')
  assert.ok(righe.every((l) => l.startsWith('| [**')), 'la prima cella è il nome e basta: niente emoji, che starebbe nella cella che non si riscrive mai')
  assert.ok(righe.includes('| [**rotta**](https://dg.example.com/deploy?service=rotta&account=production) | 🚨 giù · 0/2 task attivi | `ccccccc` |'))
  assert.match(md, /\| \[\*\*app-ferma-3\*\*\]\([^)]+\) \| ➖ fermo · 01\/09 02:00 \| `aaaaaa3` · 1\/1 task \|/, 'una risorsa ferma è ➖, con la data del suo ultimo cambio')
  assert.match(md, /\| \[\*\*app-nuova-9\*\*\]\([^)]+\) \| 🚀 OK · oggi 11:30 \| `bbbbbb9` · 1\/1 task \|/)
  assert.doesNotMatch(md, /E altri|Senza novità/, 'niente resto contato: le righe ci sono tutte')
  assert.match(md, /\n\nDadaguard: \[Deploy PROD\]\(https:\/\/dg\.example\.com\/deploy\?account=production\)/)
  assert.doesNotMatch(md, /Lambda/, 'i cron Lambda stanno nella loro scheda')
  assert.doesNotMatch(md, /\u2014/, 'niente trattino lungo')
  assert.match(c.sintesi, /^❌ 1 rotto · 🚀 14 rilasci nelle ultime 24 h/)
  assert.match(md, /^## Produzione\n\n\*\*❌ 1 rotto/, 'ogni scheda: titolo dell’ambiente, poi la sintesi')
  assert.equal(c.modello.sezioni[0].righe.length, 27, 'il modello ha le stesse righe del markdown')

  const cron = canvasTrasversale(TITOLO_CRON, [dividi(qa).cron], { ora: ORA, url: URL })
  assert.equal(cron.titolo, 'Quadro deploy CRON')
  assert.doesNotMatch(cron.markdown, /aggiornato alle/, 'un orologio riscriverebbe una cella ogni minuto')
  assert.match(cron.markdown, /## Produzione\n\n\*\*✅ niente di rotto, niente in corso · 🚀 1 rilascio nelle ultime 24 h\*\*/)
  assert.equal(cron.markdown.split('\n').filter((l) => l.startsWith('| [**')).length, 60, 'una riga per Lambda: un giro non ha una riga fissa')
  assert.match(cron.markdown, /\| \[\*\*nuovo-0\*\*\]\([^)]+\) \| 🚀 OK · oggi 11:00 \| da dev \|/, 'una Lambda non ha versione: i Dettagli partono da chi')
  assert.match(cron.markdown, /\| \[\*\*vecchio-12\*\*\]\([^)]+\) \| ➖ fermo · 01\/09 02:00 \|/)
})

test('tutto tranquillo: la sintesi lo dice per prima, e la riga c’è lo stesso', () => {
  const q = quadroAmbiente('staging', { deploys: LETTE_STG, servizi: [svc('api', 'staging', { tag: 'aaaaaaa', da: '2026-09-01T00:00:00Z' })] })
  const c = canvasQuadro(q, { ora: ORA })
  assert.equal(c.titolo, 'Quadro deploy STAGING')
  assert.match(c.sintesi, /^✅ niente di rotto, niente in corso · 🚀 0 rilasci/)
  assert.match(c.markdown, /\| \*\*api\*\* \| ➖ fermo · 01\/09 02:00 \| `aaaaaaa` · 1\/1 task \|/)
  const vuoto = canvasQuadro(quadroAmbiente('staging', { deploys: LETTE_STG, servizi: [] }), { ora: ORA })
  assert.doesNotMatch(vuoto.markdown, /\| Risorsa/, 'senza risorse niente tabella vuota')
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
  const T = 'Quadro deploy PRODUZIONE'
  const scheda = (file_id, label, shared_ts) => ({ type: 'canvas', label, data: { file_id, shared_ts } })
  const info = (tabs) => ({ channel: { properties: { tabs, canvas: null } } })
  // Slack scrive l'emoji dell'etichetta come codice: il testo basta a riconoscerlo.
  assert.deepEqual(canvasDelCanale(info([{ type: 'files' }, scheda('F1', ':large_red_square: Quadro deploy PRODUZIONE', '1')]), T), { id: 'F1', doppioni: [] })
  assert.deepEqual(canvasDelCanale(info([scheda('F2', 'Quadro deploy PRODUZIONE', '1')]), T), { id: 'F2', doppioni: [] })
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
  // Le List hanno le loro prove: qui si guardano i canvas.
  const cfg = quadroConfig({ DADAGUARD_SLACK_BOT_TOKEN: 'x', DADAGUARD_QUADRO_CANALI: 'produzione=CPROD,staging=CSTG', DADAGUARD_QUADRO_LISTE: '0' })
  const leggiDati = async () => ({ deploys: { production: { builds: [b('api', 'a', '2026-10-02T10:00:00Z')] }, staging: { builds: [] } }, servizi: [] })
  const esiti = await aggiornaQuadri(cfg, { api, leggiDati, ora: ORA })
  assert.deepEqual(esiti.map((e) => `${e.ambiente}:${e.azione}`), ['produzione:riscritto', 'staging:creato', 'cron:creato'])
  assert.equal(chiamate.filter(([m, c]) => m === 'conversations.canvases.create' && c.title === 'Quadro deploy CRON')[0][1].channel_id, 'CPROD', 'le schede trasversali stanno nel canale del primo ambiente')
  assert.equal(chiamate.filter(([m, c]) => m === 'conversations.info' && c.channel === 'CPROD').length, 1, 'le schede di un canale si chiedono una volta per giro')
  assert.ok(esiti.find((e) => e.ambiente === 'produzione').allarmi, 'gli ambienti portano i dati degli allarmi')
  assert.equal(esiti.find((e) => e.ambiente === 'cron').allarmi, undefined, 'le schede trasversali no: gli allarmi sono per ambiente')
  assert.ok(chiamate.some(([m, c]) => m === 'canvases.edit' && c.changes[0].operation === 'rename' && c.changes[0].title_content.markdown === 'Quadro deploy PRODUZIONE'), 'il canvas col titolo di prima si rinomina sul posto')
  const edit = chiamate.find(([m, c]) => m === 'canvases.edit' && c.changes[0].operation === 'replace')[1]
  assert.equal(edit.canvas_id, 'FPROD')
  assert.equal(edit.changes[0].operation, 'replace', 'un canvas che non si riesce a leggere si riscrive intero, come prima')
  assert.equal(edit.changes[0].section_id, undefined)
  assert.equal(edit.changes[0].document_content.type, 'markdown')
  const crea = chiamate.find(([m]) => m === 'conversations.canvases.create')[1]
  assert.equal(crea.channel_id, 'CSTG')
  assert.equal(crea.title, 'Quadro deploy STAGING')
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
  assert.deepEqual(d.squadre.data.app.map((r) => r.servizio).sort(), ['scraper-dashboard', 'shadow', 'tenders'], 'dal sorgente della build o dal repo dell’immagine, cron compresi: la squadra vince')
  assert.deepEqual(d.principale.app.map((r) => r.servizio), ['api'])
  assert.deepEqual(d.cron.app.map((r) => r.servizio), ['backup-a', 'backup-b'], 'i cron ECS sono dei cron')
  assert.deepEqual(d.cron.lambda.flatMap((l) => l.nomi), ['report'])
  assert.deepEqual(d.principale.lambda.flatMap((l) => l.nomi), ['deploy-notifier'], 'le Lambda dell’infrastruttura restano nella principale')
  assert.equal(dividi(undefined), null)
})

test('configurazione delle squadre: nomi e repository in minuscolo, righe vuote scartate', () => {
  const cfg = quadroConfig({ DADAGUARD_QUADRO_SQUADRE: 'Data=Scraper, scraper-image;vuota=;=x' })
  assert.deepEqual(cfg.squadre, { data: ['scraper', 'scraper-image'] })
  assert.deepEqual(quadroConfig({}).squadre, {})
})

// Le squadre anche per NOME: quello che un repository nostro non ce l'ha (un componente esterno,
// una Lambda fatta dall'IaC) entra nella scheda della squadra con un glob.
function ambienteConSquadre() {
  const P = 'production'
  return quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-03T10:00:00Z', 'SUCCEEDED', { repo: 'https://github.com/acme/api' })] } },
    servizi: [
      svc('acme-production-api', P, { tag: 'aaaaaaa', repo: 'api', da: '2026-10-03T10:05:00Z' }),
      svc('acme-production-worker-server', P, { tag: '3.6.26-python3.12', repo: 'orch', da: '2026-09-20T10:00:00Z' }),
      svc('acme-production-worker-doc', P, { tag: '3.6.26-python3.12', repo: 'orch', da: '2026-09-20T10:00:00Z' }),
      svc('acme-production-tunnel', P, { tag: '2026.8.1', repo: 'tunnel', da: '2026-09-03T00:00:00Z' }),
      svc('acme-production-tenders', P, { tag: 'e4ce302', repo: 'scraper-image', da: '2026-10-03T09:00:00Z' }),
      svc('acme-production-cron-shadow', P, { type: 'ecs-scheduled', tag: 'e4ce302', repo: 'scraper-image', da: '2026-10-03T09:00:00Z' }),
      svc('acme-production-cron-sync-orari', P, { type: 'ecs-scheduled', tag: 'ccccccc', repo: 'backup', da: '2026-10-03T08:00:00Z' }),
      svc('acme-production-cron-backup-a', P, { type: 'ecs-scheduled', tag: 'ccccccc', repo: 'backup', da: '2026-10-03T08:00:00Z' }),
      // Due Lambda dell'IaC rilasciate insieme: un giro solo, finché una delle due non va a una squadra.
      lam('acme-production-worker-notifier', P, '2026-10-03T07:00:00Z', 'codebuild-iac-12'),
      lam('acme-production-deploy-notifier', P, '2026-10-03T07:01:00Z', 'codebuild-iac-12'),
      lam('acme-production-cron-sync-report', P, '2026-10-03T06:00:00Z', 'dev'),
      lam('acme-production-cron-report', P, '2026-10-03T06:00:00Z', 'dev'),
      lam('acme-production-sync-senza-data', P, null, null),
    ],
  })
}
const nomiParte = (p) => [...p.app.map((r) => r.servizio), ...p.esterni.map((e) => e.nome), ...p.lambdaTutte.map((l) => l.nomi[0]), ...(p.infra ? ['IaC'] : [])].sort()

test('le squadre per nome: un elemento con `*` è un glob sul nome breve, su app, esterni e Lambda, cron comprese', () => {
  const qa = ambienteConSquadre()
  const d = dividi(qa, { squadre: { data: ['scraper-image', 'worker-*', 'sync-*'] } })
  const data = d.squadre.data
  assert.deepEqual(data.app.map((r) => r.servizio).sort(), ['shadow', 'sync-orari', 'tenders'], 'il repository come prima, e il glob su un cron ECS: la squadra vince su CRON')
  assert.deepEqual(data.esterni.map((e) => e.nome).sort(), ['worker-doc', 'worker-server'], 'i componenti esterni, che un repository nostro non ce l’hanno')
  assert.deepEqual(data.lambdaTutte.map((l) => l.nomi[0]).sort(), ['sync-report', 'sync-senza-data', 'worker-notifier'], 'le Lambda dell’infrastruttura e quelle col nome da cron')
  assert.equal(data.lambdaSenzaData, 1)
  assert.deepEqual(data.lambda.map((l) => l.nomi), [['worker-notifier'], ['sync-report']], 'i giri si rifanno sulle Lambda della scheda')
  assert.ok(data.lambda.every((l) => l.tipo === 'lambda' && l.chiave === qa.chiave))

  assert.deepEqual(nomiParte(d.principale), ['api', 'deploy-notifier', 'tunnel'])
  assert.deepEqual(d.principale.lambda.map((l) => l.nomi), [['deploy-notifier']], 'il giro dell’IaC perde la Lambda andata alla squadra')
  assert.equal(d.principale.lambdaSenzaData, 0)
  assert.deepEqual(nomiParte(d.cron), ['backup-a', 'report'])
  assert.deepEqual(d.cron.lambda.map((l) => l.nomi), [['report']])

  // Nessuna risorsa in due schede, e nessuna persa per strada.
  const tutte = [d.principale, d.cron, ...Object.values(d.squadre)].flatMap(nomiParte).sort()
  assert.deepEqual(tutte, nomiParte(dividi(qa).principale).concat(nomiParte(dividi(qa).cron)).sort())
  assert.equal(new Set(tutte).size, tutte.length)
})

test('le squadre per nome: senza `*` è un repository, e il repository vince sul glob', () => {
  const qa = ambienteConSquadre()
  const senza = dividi(qa, { squadre: { x: ['deploy-notifier', 'worker-server', 'report'] } })
  assert.deepEqual(nomiParte(senza.squadre.x), [], 'un nome senza `*` non prende per nome: è un repository, come prima')
  assert.deepEqual(senza.principale.lambda, qa.lambda, 'se nessuna Lambda se ne va, i giri restano quelli dell’ambiente intero')
  assert.deepEqual(senza.cron.lambda, qa.lambdaCron)
  // `altra` viene prima, ma `tenders` è di `data` per repository: il fatto più preciso vince.
  const d = dividi(qa, { squadre: { altra: ['tend*', 'worker-d*'], data: ['scraper-image', 'worker-*'] } })
  assert.deepEqual(nomiParte(d.squadre.altra), ['worker-doc'], 'fra due glob vince la squadra scritta prima')
  assert.deepEqual(nomiParte(d.squadre.data), ['shadow', 'tenders', 'worker-notifier', 'worker-server'])
  assert.deepEqual(regoleSquadre({ a: ['repo', 'w.r-*'] }).map((r) => [r.repo, r.glob.map((g) => g.test('w.r-1')), r.glob.map((g) => g.test('wxr-1'))]), [[['repo'], [true], [false]]], 'il punto vale se stesso')
  assert.deepEqual(quadroConfig({ DADAGUARD_QUADRO_SQUADRE: 'Data=Scraper, Worker-*' }).squadre, { data: ['scraper', 'worker-*'] })
})

test('le squadre per nome: le Lambda della squadra nella sua scheda, con le stesse colonne, e la List non cambia', () => {
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_QUADRO_SQUADRE: 'data=scraper-image,worker-*,sync-*' })
  const q = { produzione: ambienteConSquadre() }
  const c = Object.fromEntries(canvasDaScrivere(q, cfg, { ora: ORA }).map((x) => [x.chiave, x]))
  const righe = (k) => c[k].modello.sezioni[0].righe.map((r) => testoPiatto(r[0]))
  assert.deepEqual(righe('data'), ['shadow', 'sync-orari', 'sync-report', 'sync-senza-data', 'tenders', 'worker-doc', 'worker-notifier', 'worker-server'], 'una riga per risorsa, in ordine alfabetico')
  assert.deepEqual(righe('produzione'), ['api', 'deploy-notifier', 'tunnel'])
  assert.deepEqual(righe('cron'), ['backup-a', 'report'])
  const riga = c.data.modello.sezioni[0].righe[righe('data').indexOf('worker-notifier')]
  assert.equal(riga.length, 3)
  assert.match(testoPiatto(riga[2]), /dall'IaC/, 'la Lambda dice chi l’ha aggiornata, come nella principale')
  // La List dell'ambiente ha tutte le risorse di tutte le schede: dividerle diversamente non la cambia.
  const lista = (sq) => listeDaScrivere(q, quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_QUADRO_SQUADRE: sq }), { ora: ORA })[0].righe.map((r) => r.nome)
  assert.deepEqual(lista('data=scraper-image,worker-*,sync-*'), lista(''))
  assert.equal(lista('').length, 13)
})

test('i canvas di un giro: uno per ambiente, poi ⏰ CRON e uno per squadra, nel canale del primo ambiente', () => {
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP,staging=CS', DADAGUARD_QUADRO_SQUADRE: 'data=scraper' })
  const q = quadro({ deploys: LETTE_PROD, servizi: [] }, cfg.ambienti)
  const c = canvasDaScrivere(q, cfg, { ora: ORA })
  assert.deepEqual(c.map((x) => `${x.chiave}:${x.canale}:${x.titolo}`), [
    'produzione:CP:Quadro deploy PRODUZIONE',
    'staging:CS:Quadro deploy STAGING',
    'cron:CP:Quadro deploy CRON',
    'data:CP:Quadro deploy DATA',
  ])
  assert.match(c[3].markdown, /## Produzione[\s\S]*## Staging/, 'una sezione per ambiente')
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
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_QUADRO_LISTE: '0' })
  const leggiDati = async () => ({ deploys: LETTE_PROD, servizi: [] })
  const ultimi = new Map()
  const primo = await aggiornaQuadri(cfg, { api, leggiDati, ora: ORA, ultimi })
  assert.deepEqual(primo.map((e) => e.azione), ['riscritto', 'riscritto'])
  const secondo = await aggiornaQuadri(cfg, { api, leggiDati, ora: ORA + 20_000, ultimi })
  assert.deepEqual(secondo.map((e) => e.azione), ['invariato', 'invariato'], 'stesso minuto, stesso contenuto')
  assert.equal(chiamate.filter((m) => m === 'canvases.edit').length, 4, 'due rinomine (il titolo di prima) e due riscritture')
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

// ── Celle del canvas e Slack List ─────────────────────────────────────────────────────────────────
//
// Un Slack finto che fa con i canvas quello che fa quello vero (visto in un canale di prova il 05/10/2026): il
// markdown diventa blocchi con un id ciascuno, ogni cella di tabella ha il suo paragrafo, l'HTML che
// si scarica ha quella forma, un `replace` con `section_id` cambia il solo blocco e tiene l'id, uno
// senza rifà tutto con id nuovi. E le List: righe, celle, pagine.
function slackFinto({ bot = 'UBOT', pagina = 100 } = {}) {
  let n = 0
  const nuovoId = () => `temp:C:${++n}`
  const canvas = new Map()
  const liste = new Map()
  const chiamate = []
  const mdInHtml = (md) =>
    String(md)
      .replace(/\\\|/g, '\u0000')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, '<lnk href="$2">$1</lnk>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\u0000/g, '|')
  const blocchiDa = (titolo, md) => [
    { tipo: 'h1', id: nuovoId(), md: titolo },
    ...md.split('\n\n').map((parte) => {
      if (parte.startsWith('## ')) return { tipo: 'h2', id: nuovoId(), md: parte.slice(3) }
      if (parte.startsWith('|'))
        return {
          tipo: 'table',
          righe: parte
            .split('\n')
            .filter((l) => !/^\|-/.test(l))
            .map((l) => l.slice(2, -2).split(/ (?<!\\)\| /).map((c) => ({ id: nuovoId(), md: c }))),
        }
      return { tipo: 'p', id: nuovoId(), md: parte }
    }),
  ]
  const html = (blocchi) =>
    `<div class="quip-canvas-content">${blocchi
      .map((b) =>
        b.tipo === 'table'
          ? `<table>${b.righe.map((r) => `<tr>${r.map((c) => `<td><p id="${c.id}" class="line">${mdInHtml(c.md)}</p></td>`).join('')}</tr>`).join('')}</table>`
          : b.tipo === 'p'
            ? `<p id="${b.id}" class="line">${mdInHtml(b.md)}</p>`
            : `<${b.tipo} id="${b.id}">${mdInHtml(b.md)}</${b.tipo}>`,
      )
      .join('')}</div>`
  const trova = (blocchi, id) => blocchi.flatMap((b) => (b.tipo === 'table' ? b.righe.flat() : [b])).find((x) => x.id === id)
  const colonneDi = (schema) => schema.map((c, i) => ({ ...c, id: `Col${i}` }))
  const api = async (metodo, corpo) => {
    chiamate.push([metodo, corpo])
    if (metodo === 'auth.test') return { user_id: bot }
    if (metodo === 'conversations.info') return { channel: { properties: { tabs: [...canvas.values()].filter((c) => c.canale === corpo.channel).map((c) => ({ type: 'canvas', label: c.titolo, data: { file_id: c.id, shared_ts: c.ts } })) } } }
    if (metodo === 'conversations.canvases.create') {
      const id = `F${++n}`
      canvas.set(id, { id, canale: corpo.channel_id, titolo: corpo.title, ts: String(n), blocchi: blocchiDa(corpo.title, corpo.document_content.markdown) })
      return { canvas_id: id }
    }
    if (metodo === 'canvases.edit') {
      const c = canvas.get(corpo.canvas_id)
      const [m] = corpo.changes
      if (m.operation === 'rename') c.titolo = m.title_content.markdown
      else if (!m.section_id) c.blocchi = blocchiDa(c.titolo, m.document_content.markdown)
      else {
        const b = trova(c.blocchi, m.section_id)
        if (!b) throw new Error('slack canvases.edit: canvas_editing_failed')
        b.md = m.document_content.markdown
      }
      return {}
    }
    if (metodo === 'files.info') {
      if (canvas.has(corpo.file)) return { file: { id: corpo.file, title: canvas.get(corpo.file).titolo, url_private_download: `mem://${corpo.file}` } }
      const l = liste.get(corpo.file)
      return { file: { id: l.id, title: l.titolo, permalink: `https://x.slack.com/lists/T1/${l.id}`, list_metadata: { schema: l.schema } } }
    }
    if (metodo === 'files.list')
      return { files: [...liste.values()].filter((l) => l.user === corpo.user).map((l) => ({ id: l.id, title: l.titolo, created: l.creata, channels: l.canali, filetype: 'list' })) }
    if (metodo === 'slackLists.create') {
      const id = `FL${++n}`
      const schema = colonneDi(corpo.schema)
      liste.set(id, { id, titolo: corpo.name, user: bot, creata: n, canali: [], schema, righe: new Map(), segnalibri: [] })
      return { list_id: id, list_metadata: { schema } }
    }
    if (metodo === 'slackLists.access.set') {
      liste.get(corpo.list_id).canali.push(...corpo.channel_ids)
      return {}
    }
    if (metodo === 'bookmarks.add') return { bookmark: { id: 'Bk1' } }
    const l = liste.get(corpo.list_id)
    const metti = (riga, cella) => riga.set(cella.column_id, cella)
    if (metodo === 'slackLists.items.create') {
      const id = `Rec${++n}`
      const riga = new Map()
      for (const f of corpo.initial_fields) metti(riga, f)
      l.righe.set(id, riga)
      return { item: { id } }
    }
    if (metodo === 'slackLists.items.update') {
      for (const c of corpo.cells) metti(l.righe.get(c.row_id), c)
      return {}
    }
    if (metodo === 'slackLists.items.delete') {
      l.righe.delete(corpo.id)
      return {}
    }
    if (metodo === 'slackLists.items.list') {
      // Come quella vera: testo in `text`, link in camelCase, pagine con un cursore.
      const tutte = [...l.righe.entries()].map(([id, riga]) => ({
        id,
        fields: [...riga.values()].map((c) => ({
          column_id: c.column_id,
          ...(c.rich_text ? { text: c.rich_text.flatMap((r) => r.elements.flatMap((s) => s.elements.map((e) => e.text))).join('') } : {}),
          ...(c.select ? { select: c.select } : {}),
          ...(c.link ? { link: c.link.map((x) => ({ originalUrl: x.original_url, displayName: x.display_name, displayAsUrl: false })) } : {}),
        })),
      }))
      const da = Number(corpo.cursor ?? 0)
      const fine = da + Math.min(pagina, corpo.limit ?? 100)
      return { items: tutte.slice(da, fine), response_metadata: { next_cursor: fine < tutte.length ? String(fine) : '' } }
    }
    throw new Error(`metodo non previsto: ${metodo}`)
  }
  const scarica = async (url) => html(canvas.get(url.replace('mem://', '')).blocchi)
  return { api, scarica, canvas, liste, chiamate, html }
}

// L'HTML vero di un canvas del quadro, preso da un canale di prova il 05/10/2026 e accorciato a due righe.
const HTML_VERO =
  '<div class="quip-canvas-content"><h1 id="temp:C:UAf7c">Prova quadro tutti</h1><h2 id="temp:C:UAfc9">Produzione</h2><p id="temp:C:UAfd7" class="line"><b>❌ 2 rotti · 🚀 10 rilasciati</b></p><table><tr><td><p id="temp:C:h1" class="line">Risorsa</p></td><td><p id="temp:C:h2" class="line">Stato</p></td><td><p id="temp:C:h4" class="line">Dettagli</p></td></tr><tr><td><p id="temp:C:a1" class="line"><lnk href="https://dg.example.com/deploy?account=production&amp;service=agentic-chat"><b>agentic-chat</b></lnk></p></td><td><p id="temp:C:a2" class="line">🚀 OK · oggi 10:40</p></td><td><p id="temp:C:a4" class="line"><lnk href="https://github.com/x/agentic-chat/commit/15ee8d1">15ee8d1</lnk> · rev 80 · <code>2/2</code> task</p></td></tr><tr><td><p id="temp:C:b1" class="line"><lnk href="https://dg.example.com/deploy?account=production&amp;service=IaC"><b>IaC</b></lnk></p></td><td><p id="temp:C:b2" class="line">🚀 OK · oggi 13:49</p></td><td><p id="temp:C:b4" class="line"><lnk href="https://github.com/x/aws-management/commit/3ec82ac">3ec82ac</lnk> · a | b &amp; c</p></td></tr></table><p id="temp:C:f1" class="line">Dadaguard: <lnk href="https://dg.example.com/deploy?account=production">Deploy PROD</lnk></p></div>'

test('l’HTML del canvas: titoli, paragrafi e tabelle, con l’id di ogni cella e il testo senza tag', () => {
  const b = leggiCanvasHtml(HTML_VERO)
  assert.deepEqual(b.map((x) => x.tipo), ['h1', 'h2', 'p', 'table', 'p'])
  assert.deepEqual(b[2], { tipo: 'p', id: 'temp:C:UAfd7', testo: '❌ 2 rotti · 🚀 10 rilasciati' })
  assert.deepEqual(b[3].righe[1].map((c) => c.id), ['temp:C:a1', 'temp:C:a2', 'temp:C:a4'])
  assert.deepEqual(b[3].righe[1].map((c) => c.testo), ['agentic-chat', '🚀 OK · oggi 10:40', '15ee8d1 · rev 80 · 2/2 task'])
  assert.equal(b[3].righe[2][2].testo, '3ec82ac · a | b & c', 'le entità tornano caratteri')
  assert.equal(testoPiatto('[**IaC**](https://x?a=1&b=2) · `abc` · a \\| b'), 'IaC · abc · a | b')
})

test('il piano delle celle: solo quelle cambiate, mai la prima colonna; forma diversa vuol dire riscrivere tutto', () => {
  const modello = {
    sezioni: [
      {
        titolo: 'Produzione',
        sintesi: '**❌ 2 rotti · 🚀 10 rilasciati**',
        righe: [
          ['[**agentic-chat**](https://dg.example.com/x)', '🚀 OK · oggi 10:40', '[15ee8d1](https://github.com/x/agentic-chat/commit/15ee8d1) · rev 80 · `2/2` task'],
          ['[**IaC**](https://dg.example.com/y)', '⏳ in corso · oggi 14:02', '[3ec82ac](https://github.com/x/aws-management/commit/3ec82ac) · a \\| b & c'],
        ],
        fondo: 'Dadaguard: [Deploy PROD](https://dg.example.com/deploy?account=production)',
      },
    ],
  }
  const blocchi = leggiCanvasHtml(HTML_VERO)
  assert.deepEqual(pianoCelle(modello, blocchi), [{ id: 'temp:C:b2', markdown: '⏳ in corso · oggi 14:02' }], 'una cella cambiata, una modifica; i link e il codice non contano')
  const giaUguale = structuredClone(modello)
  giaUguale.sezioni[0].righe[1][1] = '🚀 OK · oggi 13:49'
  assert.deepEqual(pianoCelle(giaUguale, blocchi), [], 'niente da fare')
  const sintesi = structuredClone(giaUguale)
  sintesi.sezioni[0].sintesi = '**✅ niente di rotto**'
  assert.deepEqual(pianoCelle(sintesi, blocchi), [{ id: 'temp:C:UAfd7', markdown: '**✅ niente di rotto**' }], 'la sintesi si riscrive per id come una cella')

  const nuova = structuredClone(giaUguale)
  nuova.sezioni[0].righe.splice(1, 0, ['**backend**', '🚀 OK', 'n/d', 'n/d'])
  assert.equal(pianoCelle(nuova, blocchi), null, 'una risorsa nuova: le righe non tornano')
  const rinominata = structuredClone(giaUguale)
  rinominata.sezioni[0].righe[1][0] = '**IaC-2**'
  assert.equal(pianoCelle(rinominata, blocchi), null, 'la prima colonna non si riscrive: se il nome non torna, si rifà tutto')
  const senzaFondo = structuredClone(giaUguale)
  senzaFondo.sezioni[0].fondo = null
  assert.equal(pianoCelle(senzaFondo, blocchi), null, 'un paragrafo in più o in meno è un’altra forma')
  const tre = structuredClone(giaUguale)
  tre.sezioni[0].righe = tre.sezioni[0].righe.map((r) => r.slice(0, 2))
  assert.equal(pianoCelle(tre, blocchi), null, 'colonne diverse: altra forma')
})

test('il giro: un cambio riscrive le sole celle cambiate, per id; una risorsa nuova riscrive tutto', async () => {
  const s = slackFinto()
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_QUADRO_LISTE: '0' })
  const servizi = [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-02T10:00:00Z' }), svc('web', 'production', { tag: 'ccccccc', da: '2026-09-01T00:00:00Z' })]
  const dati = (builds, extra = []) => async () => ({ deploys: { production: { builds } }, servizi: [...servizi, ...extra] })
  const fermi = [b('api', 'aaaaaaa', '2026-10-02T10:00:00Z', 'SUCCEEDED', { repo: 'https://github.com/x/api', number: 10 })]
  const ultimi = new Map()
  const giro = (leggiDati, ora = ORA) => aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati, ora, ultimi })
  const primo = await giro(dati(fermi))
  assert.deepEqual(primo.map((e) => `${e.ambiente}:${e.azione}`), ['produzione:creato', 'cron:creato'])
  const fp = primo[0].canvas
  const idPrima = leggiCanvasHtml(s.html(s.canvas.get(fp).blocchi))

  s.chiamate.length = 0
  const conBuild = [...fermi, b('api', 'bbbbbbb', '2026-10-03T11:50:00Z', 'IN_PROGRESS', { repo: 'https://github.com/x/api', number: 11, phase: 'BUILD' })]
  const secondo = await giro(dati(conBuild))
  assert.equal(secondo[0].azione, 'celle')
  const edit = s.chiamate.filter(([m]) => m === 'canvases.edit').map(([, c]) => c.changes[0])
  assert.ok(edit.length >= 2 && edit.every((m) => m.section_id && m.operation === 'replace'), 'solo replace per id: niente riscrittura intera, quindi niente sdoppio')
  assert.ok(edit.some((m) => m.document_content.markdown === '⏳ in corso · oggi 13:50'), 'lo stato della riga di api')
  assert.ok(edit.some((m) => /^\*\*⏳ 1 in corso/.test(m.document_content.markdown)), 'e la sintesi, per id anche lei')
  const tabella = leggiCanvasHtml(s.html(s.canvas.get(fp).blocchi)).find((x) => x.tipo === 'table')
  assert.deepEqual(tabella.righe.map((r) => r[0].testo), ['Risorsa', 'api', 'web'], 'le righe restano dov’erano')
  assert.deepEqual(tabella.righe.flat().map((c) => c.id), idPrima.find((x) => x.tipo === 'table').righe.flat().map((c) => c.id), 'e con gli stessi id')
  assert.equal(tabella.righe[1][2].testo, 'aaaaaaa · build #11 · verso bbbbbbb', 'quello che gira, poi la build e dove va')

  s.chiamate.length = 0
  const terzo = await giro(dati(conBuild))
  assert.deepEqual(terzo.map((e) => e.azione), ['invariato', 'invariato'])
  assert.equal(s.chiamate.filter(([m]) => m === 'files.info' || m === 'canvases.edit').length, 0, 'niente di cambiato: non si rilegge nemmeno il canvas')

  s.chiamate.length = 0
  const quarto = await giro(dati(conBuild, [svc('nuovo', 'production', { tag: 'ddddddd', da: '2026-10-03T11:00:00Z' })]))
  assert.equal(quarto[0].azione, 'riscritto', 'una risorsa nuova cambia le righe: si riscrive tutto, e lì lo sdoppio si accetta')
  const intero = s.chiamate.filter(([m]) => m === 'canvases.edit')
  assert.equal(intero.length, 1)
  assert.equal(intero[0][1].changes[0].section_id, undefined)
  assert.deepEqual(leggiCanvasHtml(s.html(s.canvas.get(fp).blocchi)).find((x) => x.tipo === 'table').righe.map((r) => r[0].testo), ['Risorsa', 'api', 'nuovo', 'web'])
})

test('il giro: al massimo MAX_MODIFICHE_GIRO celle, il resto al giro dopo rileggendo il canvas', async () => {
  const s = slackFinto()
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_QUADRO_LISTE: '0' })
  const nomi = ['a', 'b', 'c', 'd']
  const leggi = (da) => async () => ({ deploys: LETTE_PROD, servizi: nomi.map((n) => svc(n, 'production', { tag: 'aaaaaaa', da })) })
  const ultimi = new Map()
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: leggi('2026-09-01T00:00:00Z'), ora: ORA, ultimi })
  // Quattro rilasci insieme: quattro celle di stato più la sintesi.
  const giro = () => aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: leggi('2026-10-03T11:00:00Z'), ora: ORA, ultimi, maxModifiche: 3 })
  const primo = await giro()
  assert.deepEqual([primo[0].azione, primo[0].celle, primo[0].restano], ['celle', 3, 2])
  const secondo = await giro()
  assert.deepEqual([secondo[0].azione, secondo[0].celle, secondo[0].restano], ['celle', 2, 0])
  s.chiamate.length = 0
  assert.equal((await giro())[0].azione, 'invariato')
  assert.equal(s.chiamate.filter(([m]) => m === 'files.info').length, 0)
  assert.equal(MAX_MODIFICHE_GIRO, 10, '10 ogni 15 secondi resta sotto le ~50 modifiche al minuto di Slack')
})

test('gli stati delle righe: deploy avviato, fallito, OK, invariato; l’IaC dice apply', () => {
  const q = quadroAmbiente('produzione', {
    deploys: {
      production: {
        builds: [
          b('api', 'aaaaaaa', '2026-10-02T10:00:00Z'),
          b('api', 'bbbbbbb', '2026-10-03T11:30:00Z', 'FAILED', { number: 12, failPhase: 'BUILD' }),
          b('web', 'ccccccc', '2026-10-03T11:40:00Z', 'IN_PROGRESS', { number: 7 }),
          b('infra-iac-apply', 'ddddddd', '2026-10-03T09:00:00Z', 'SUCCEEDED', { iac: true, number: 93, durationMs: 300_000 }),
        ],
      },
    },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa' }), svc('web', 'production', { tag: 'eeeeeee', da: '2026-10-01T10:00:00Z' })],
  })
  const righe = righeTabella(q, { ora: ORA })
  assert.deepEqual(righe.map((r) => `${r.nome}:${r.stato}`), ['api:deploy_fallito', 'IaC:deploy_ok', 'web:deploy_avviato'], 'IaC fra api e web: l’ordine non bada alle maiuscole')
  assert.equal(righe[0].celle[1], '❌ fallito · oggi 13:30')
  assert.equal(righe[0].celle[2], '`aaaaaaa` · build #12 · al BUILD', 'quello che gira ancora, poi la build fallita')
  assert.equal(righe[1].celle[1], '🚀 OK · oggi 11:00')
  assert.equal(righe[2].celle[1], '⏳ in corso · oggi 13:40')
  assert.equal(righe[2].celle[2], '`eeeeeee` · build #7 · verso `ccccccc`', 'la versione è quello che gira, non quello che sta partendo')
  assert.equal(quandoBreve('2026-10-02T20:05:00Z', ORA), 'ieri 22:05')
  assert.equal(quandoBreve('2026-09-30T20:05:00Z', ORA), '30/09 22:05')
  assert.equal(quandoBreve(null, ORA), null)
  assert.deepEqual(Object.keys(STATI), ['test_avviati', 'test_falliti', 'deploy_avviato', 'deploy_ok', 'deploy_fallito', 'giu', 'indietro', 'invariato'])
})

test('lo stato dei test è predisposto: vale solo se più recente dell’ultimo cambio e la riga è ferma', () => {
  const ok = { stato: 'deploy_ok', quando: '2026-10-03T10:00:00Z', quandoTesto: 'oggi 12:00', dettagli: ['rev 3'] }
  const avviati = conTest(ok, { stato: 'in_corso', da: '2026-10-03T11:00:00Z', url: 'https://github.com/x/api/actions/runs/1' }, { ora: ORA })
  assert.equal(avviati.stato, 'test_avviati')
  assert.equal(avviati.quandoTesto, 'oggi 13:00')
  assert.equal(avviati.dettagli[0], '[run](https://github.com/x/api/actions/runs/1)')
  assert.equal(conTest(ok, { stato: 'fallito', da: '2026-10-03T11:00:00Z' }, { ora: ORA }).stato, 'test_falliti')
  assert.equal(conTest(ok, { stato: 'fallito', da: '2026-10-03T09:00:00Z' }, { ora: ORA }), ok, 'un test più vecchio del rilascio non lo racconta')
  const inCorso = { ...ok, stato: 'deploy_avviato' }
  assert.equal(conTest(inCorso, { stato: 'in_corso', da: '2026-10-03T11:00:00Z' }, { ora: ORA }), inCorso, 'un deploy in corso dice di più')
  assert.equal(conTest(ok, null), ok, 'oggi nessuno li riempie: la riga resta com’è')
  const q = quadroAmbiente('produzione', { deploys: LETTE_PROD, servizi: [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-03T10:00:00Z' })] })
  q.app[0].test = { stato: 'fallito', da: '2026-10-03T11:30:00Z' }
  assert.equal(righeTabella(q, { ora: ORA })[0].celle[1], '❌ test KO · oggi 13:30', 'la riga lo mostra quando la risorsa lo porta')
})

const LISTA_CFG = { DADAGUARD_QUADRO_CANALI: 'produzione=CP' }
const listaDati = (servizi) => async () => ({ deploys: LETTE_PROD, servizi })
const SERVIZI_LISTA = [
  svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-03T10:00:00Z' }),
  svc('web', 'production', { tag: 'ccccccc', da: '2026-09-01T00:00:00Z' }),
  lam('acme-production-cron-report', 'production', '2026-10-03T07:00:00Z', 'dev'),
]

test('la List: la prima volta si crea, in sola lettura per il canale, col segnalibro e una riga per risorsa', async () => {
  const s = slackFinto()
  const cfg = quadroConfig({ ...LISTA_CFG, DADAGUARD_PUBLIC_URL: URL })
  const liste = nuovaMemoriaListe()
  const esiti = await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(SERVIZI_LISTA), ora: ORA, liste })
  assert.equal(esiti.find((e) => e.ambiente === 'lista-produzione').azione, 'creata')
  const crea = s.chiamate.find(([m]) => m === 'slackLists.create')[1]
  assert.equal(crea.name, 'Lista deploy PRODUZIONE')
  assert.deepEqual(crea.schema.map((c) => `${c.key}:${c.type}`), ['risorsa:text', 'stato:select', 'quando:text', 'dettagli:text', 'versione:text', 'dadaguard:link'], 'Dettagli prima di Versione, e Versione testo')
  assert.deepEqual(crea.schema[1].options.choices.map((c) => c.value), Object.keys(STATI))
  assert.equal(crea.schema[1].options.choices[3].label, '🚀 OK')
  assert.deepEqual(s.chiamate.find(([m]) => m === 'slackLists.access.set')[1], { list_id: [...s.liste.keys()][0], access_level: 'read', channel_ids: ['CP'] })
  const segnalibro = s.chiamate.find(([m]) => m === 'bookmarks.add')[1]
  assert.equal(segnalibro.channel_id, 'CP')
  assert.match(segnalibro.link, /^https:\/\/x\.slack\.com\/lists\//)
  const create = s.chiamate.filter(([m]) => m === 'slackLists.items.create').map(([, c]) => c)
  assert.equal(create.length, 3, 'api, web e il cron: la List ha tutte le schede dell’ambiente')
  const api = create.find((c) => c.initial_fields[0].rich_text[0].elements[0].elements[0].text === 'api')
  assert.deepEqual(api.initial_fields.find((f) => f.column_id === 'Col1').select, ['deploy_ok'])
  assert.deepEqual(api.initial_fields.find((f) => f.column_id === 'Col5').link, [{ original_url: `${URL}/deploy?service=api&account=production`, display_as_url: false, display_name: 'apri' }])
  assert.equal(api.initial_fields.find((f) => f.column_id === 'Col4'), undefined, 'senza repository niente link al commit: la cella vuota non si manda')

  s.chiamate.length = 0
  const secondo = await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(SERVIZI_LISTA), ora: ORA, liste })
  assert.equal(secondo.find((e) => e.ambiente === 'lista-produzione').azione, 'invariato')
  assert.equal(s.chiamate.filter(([m]) => m.startsWith('slackLists') || m === 'files.list' || m === 'auth.test').length, 0, 'niente di cambiato, nessuna chiamata')
})

test('la List: un cambio è UNA chiamata con le sole celle cambiate; una risorsa sparita si toglie', async () => {
  const s = slackFinto()
  const cfg = quadroConfig(LISTA_CFG)
  const liste = nuovaMemoriaListe()
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(SERVIZI_LISTA), ora: ORA, liste })
  s.chiamate.length = 0
  const conRilascio = [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-03T10:00:00Z' }), svc('web', 'production', { tag: 'fffffff', da: '2026-10-03T11:45:00Z' }), SERVIZI_LISTA[2]]
  const e = (await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(conRilascio), ora: ORA, liste })).find((x) => x.ambiente === 'lista-produzione')
  assert.equal(e.azione, 'aggiornata')
  const update = s.chiamate.filter(([m]) => m === 'slackLists.items.update')
  assert.equal(update.length, 1)
  assert.deepEqual(update[0][1].cells.map((c) => c.column_id).sort(), ['Col1', 'Col2'], 'stato e quando di web; la versione senza repository resta vuota')
  assert.deepEqual(update[0][1].cells.find((c) => c.column_id === 'Col1').select, ['deploy_ok'])

  s.chiamate.length = 0
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(conRilascio.slice(0, 2)), ora: ORA, liste })
  assert.equal(s.chiamate.filter(([m]) => m === 'slackLists.items.delete').length, 1, 'il cron non c’è più: la sua riga si toglie')
  assert.equal([...s.liste.values()][0].righe.size, 2)
  s.chiamate.length = 0
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati([]), ora: ORA, liste })
  assert.equal(s.chiamate.filter(([m]) => m.startsWith('slackLists')).length, 0, 'un ambiente vuoto è una lettura andata male: non si cancella niente')
})

test('la List dopo un riavvio: si ritrova dal titolo e dal canale, righe rilette per nome, niente doppioni', async () => {
  const s = slackFinto({ pagina: 2 })
  const cfg = quadroConfig(LISTA_CFG)
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(SERVIZI_LISTA), ora: ORA, liste: nuovaMemoriaListe() })
  // Una List con lo stesso titolo ma in un altro canale (una prova in un altro canale): non è questa.
  const altra = await s.api('slackLists.create', { name: 'Lista deploy PRODUZIONE', schema: SCHEMA_LISTA })
  await s.api('slackLists.access.set', { list_id: altra.list_id, access_level: 'read', channel_ids: ['CPROVA'] })
  const nostra = [...s.liste.keys()][0]

  s.chiamate.length = 0
  const dopo = nuovaMemoriaListe() // Dadaguard riavviato: memoria vuota
  const e = (await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(SERVIZI_LISTA), ora: ORA, liste: dopo })).find((x) => x.ambiente === 'lista-produzione')
  assert.equal(e.azione, 'invariato', 'ritrovata, e già allineata')
  assert.equal(e.lista, nostra)
  assert.equal(s.chiamate.filter(([m]) => m === 'slackLists.create' || m === 'slackLists.items.create').length, 0, 'nessuna List e nessuna riga nuova')
  assert.equal(s.chiamate.filter(([m]) => m === 'slackLists.items.list').length, 2, 'tre righe su pagine da due: si seguono le pagine')
  assert.equal(s.chiamate.filter(([m]) => m === 'slackLists.items.update').length, 0, 'le firme rilette tornano con quelle calcolate')
  assert.deepEqual([...dopo.ambienti.get('produzione').righe.keys()].sort(), ['api', 'report', 'web'])

  // Una riga doppia (un giro morto fra la creazione e la memoria) si toglie al ritrovamento.
  const id = [...s.liste.get(nostra).righe.keys()][0]
  s.liste.get(nostra).righe.set('RecDoppia', new Map(s.liste.get(nostra).righe.get(id)))
  s.chiamate.length = 0
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(SERVIZI_LISTA), ora: ORA, liste: nuovaMemoriaListe() })
  assert.deepEqual(s.chiamate.filter(([m]) => m === 'slackLists.items.delete').map(([, c]) => c.id), ['RecDoppia'])
})

test('la List: un errore la fa ritrovare al giro dopo, e la guardia la chiama per nome', async () => {
  const s = slackFinto()
  const cfg = quadroConfig(LISTA_CFG)
  const liste = nuovaMemoriaListe()
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(SERVIZI_LISTA), ora: ORA, liste })
  const rotta = async (m, c) => {
    if (m === 'slackLists.items.update') throw new Error('slack slackLists.items.update: list_not_found')
    return s.api(m, c)
  }
  const cambiati = [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-03T11:55:00Z' }), ...SERVIZI_LISTA.slice(1)]
  const e = (await aggiornaQuadri(cfg, { api: rotta, scarica: s.scarica, leggiDati: listaDati(cambiati), ora: ORA, liste })).find((x) => x.ambiente === 'lista-produzione')
  assert.equal(e.azione, 'errore')
  assert.equal(liste.ambienti.has('produzione'), false, 'la memoria si butta: al giro dopo si riparte dal ritrovarla')
  s.chiamate.length = 0
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(cambiati), ora: ORA, liste })
  assert.equal(s.chiamate.filter(([m]) => m === 'files.list').length, 1)
  assert.equal(s.chiamate.filter(([m]) => m === 'slackLists.items.update').length, 1, 'e la cella rimasta indietro si scrive')
  assert.match(testoAvviso({ ambiente: 'lista-produzione', tipo: 'fermo', fermoDa: ORA - 11 * 60_000, errore: 'x' }, { ora: ORA }), /\[LISTA PROD\] FERMO · la List non si aggiorna da 11 min/)
  assert.equal(quadroConfig({ DADAGUARD_QUADRO_LISTE: '0' }).liste, false)
  assert.equal(quadroConfig({}).liste, true)
})

test('lo stato dei test da GitHub sulle righe: 🧪 sul repository della build, e un deploy più recente vince', async () => {
  const s = slackFinto()
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_QUADRO_LISTE: '0' })
  const leggiDati = async () => ({
    deploys: {
      production: {
        builds: [
          b('api', 'aaaaaaa', '2026-10-02T10:00:00Z', 'SUCCEEDED', { repo: 'https://github.com/acme/api.git' }),
          b('web', 'ccccccc', '2026-10-03T11:45:00Z', 'SUCCEEDED', { repo: 'https://github.com/acme/web' }),
        ],
      },
    },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-02T10:05:00Z' }), svc('web', 'production', { tag: 'ccccccc', da: '2026-10-03T11:50:00Z' })],
  })
  const chiesti = []
  const github = {
    org: null,
    leggi: async (repos) => {
      chiesti.push(repos.map((r) => `${r.owner}/${r.repo}`))
      return new Map([
        ['produzione|acme/api', { stato: 'in_corso', da: '2026-10-03T11:50:00Z', url: 'https://github.com/acme/api/actions/runs/9' }],
        ['produzione|acme/web', { stato: 'fallito', da: '2026-10-03T11:40:00Z', url: 'https://github.com/acme/web/actions/runs/8' }],
      ])
    },
  }
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati, ora: ORA, github })
  assert.deepEqual(chiesti, [['acme/api', 'acme/web']], 'i repository vengono dalle build delle righe')
  const righe = leggiCanvasHtml(s.html([...s.canvas.values()].find((c) => c.titolo === 'Quadro deploy PRODUZIONE').blocchi)).find((x) => x.tipo === 'table').righe
  assert.equal(righe[1][1].testo, '🧪 test · oggi 13:50')
  assert.equal(righe[1][2].testo, 'aaaaaaa · run · 1/1 task')
  assert.equal(righe[2][1].testo, '🚀 OK · oggi 13:50', 'i test falliti sono delle 13:40, il rilascio delle 13:50: vince il più recente')
})

// ── Titoli senza emoji, List visibile e leggibile ─────────────────────────────────────────────────

test('i titoli di prima, con l’emoji o col suo codice, sono gli stessi di adesso', () => {
  assert.equal(stessoTitolo(':large_red_square: Quadro deploy PRODUZIONE', 'Quadro deploy PRODUZIONE'), true, 'l’etichetta della scheda di prima')
  assert.equal(stessoTitolo('🟨 Quadro deploy STAGING', 'Quadro deploy STAGING'), true)
  assert.equal(stessoTitolo(':alarm_clock: Quadro deploy CRON', 'Quadro deploy CRON'), true)
  assert.equal(stessoTitolo('📊 Quadro deploy DATA', 'Quadro deploy DATA'), true)
  assert.equal(stessoTitolo('Quadro deploy PRODUZIONE', 'Quadro deploy PRODUZIONE'), true)
  assert.equal(stessoTitolo('Quadro deploy PRODUZIONE, appunti', 'Quadro deploy PRODUZIONE'), false)
  assert.equal(stessoTitolo('Quadro deploy STAGING', 'Quadro deploy PRODUZIONE'), false)
  assert.equal(stessoTitolo('', ''), false)
  assert.doesNotMatch(Object.values(AMBIENTI).map((a) => `${a.titolo} ${a.sezione}`).join(' ') + TITOLO_CRON, /\p{Extended_Pictographic}/u, 'niente emoji nei titoli')
})

test('un canvas col titolo di prima si rinomina sul posto, una volta, e la sezione nuova lo riscrive una volta', async () => {
  const s = slackFinto()
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_QUADRO_LISTE: '0' })
  const leggiDati = async () => ({ deploys: LETTE_PROD, servizi: [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-09-01T00:00:00Z' })] })
  // Com'era prima del cambio: titolo con l'emoji, sezione con l'emoji.
  const vecchio = await s.api('conversations.canvases.create', {
    channel_id: 'CP',
    title: ':large_red_square: Quadro deploy PRODUZIONE',
    document_content: { type: 'markdown', markdown: '## 🟥 Produzione\n\n**✅ niente di rotto**\n\n| Risorsa | Stato | Versione | Dettagli |\n|---|---|---|---|\n| **api** | ➖ invariato | `aaaaaaa` | n/d |' },
  })
  s.chiamate.length = 0
  const ultimi = new Map()
  const primo = await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati, ora: ORA, ultimi })
  assert.equal(primo[0].canvas, vecchio.canvas_id, 'lo stesso canvas, non uno nuovo')
  assert.equal(primo[0].azione, 'riscritto', 'la sezione senza emoji è un’altra forma: una riscrittura intera, una volta')
  assert.deepEqual(s.chiamate.filter(([m]) => m === 'conversations.canvases.create').map(([, c]) => c.title), ['Quadro deploy CRON'], 'si crea solo quello che non c’era')
  const rinomine = s.chiamate.filter(([m, c]) => m === 'canvases.edit' && c.changes[0].operation === 'rename')
  assert.deepEqual(rinomine.map(([, c]) => c.changes[0].title_content), [{ type: 'markdown', markdown: 'Quadro deploy PRODUZIONE' }])
  s.chiamate.length = 0
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati, ora: ORA, ultimi })
  assert.equal(s.chiamate.filter(([m]) => m === 'files.info' || m === 'canvases.edit').length, 0, 'al giro dopo niente da rinominare né da riscrivere')
})

test('la List di prima: si ritrova, si rinomina, si usa con le sue colonne, e il log dice come averla nuova', async () => {
  const s = slackFinto()
  // Lo schema del 05/10/2026: etichette lunghe, Versione di tipo link prima dei Dettagli.
  const vecchio = [
    { key: 'risorsa', name: 'Risorsa', type: 'text', is_primary_column: true },
    { key: 'stato', name: 'Stato', type: 'select', options: { format: 'single_select', choices: Object.keys(STATI).map((value) => ({ value, label: `x ${value}` })) } },
    { key: 'quando', name: 'Quando', type: 'text' },
    { key: 'versione', name: 'Versione', type: 'link' },
    { key: 'dettagli', name: 'Dettagli', type: 'text' },
    { key: 'dadaguard', name: 'Dadaguard', type: 'link' },
  ]
  assert.equal(listaVecchia(vecchio), true)
  assert.equal(listaVecchia(SCHEMA_LISTA.map((c, i) => ({ ...c, id: `C${i}` }))), false)
  const l = await s.api('slackLists.create', { name: ':large_red_square: Lista deploy PRODUZIONE', schema: vecchio })
  await s.api('slackLists.access.set', { list_id: l.list_id, channel_ids: ['CP'] })
  s.chiamate.length = 0
  const avvisi = []
  const warn = log.warn
  log.warn = (m) => avvisi.push(m)
  try {
    const servizi = [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-03T10:00:00Z' })]
    const deploys = { production: { builds: [b('api', 'aaaaaaa', '2026-10-03T09:55:00Z', 'SUCCEEDED', { repo: 'https://github.com/acme/api', number: 3 })] } }
    const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_PUBLIC_URL: URL })
    await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: async () => ({ deploys, servizi }), ora: ORA, liste: nuovaMemoriaListe() })
  } finally {
    log.warn = warn
  }
  assert.equal(s.chiamate.filter(([m]) => m === 'slackLists.create').length, 0, 'non se ne crea un’altra')
  assert.deepEqual(s.chiamate.find(([m]) => m === 'slackLists.update')[1], { id: l.list_id, name: 'Lista deploy PRODUZIONE' })
  assert.equal(avvisi.filter((m) => /schema di prima/.test(m)).length, 1)
  const riga = [...s.liste.get(l.list_id).righe.values()][0]
  assert.deepEqual(riga.get('Col3').link, [{ original_url: 'https://github.com/acme/api/commit/aaaaaaa', display_as_url: false, display_name: 'aaaaaaa' }], 'nella List vecchia Versione è un link, e lì si scrive un link')
})

test('la List nuova: Versione è un testo col link dentro, vuoto senza commit, e i Dettagli sono corti', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-03T10:00:00Z', 'SUCCEEDED', { repo: 'https://github.com/acme/api', number: 661, durationMs: 360_000, author: 'dev' })] } },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa', da: '2026-10-03T10:05:00Z', rev: 9, task: [2, 2], target: [4, 4] }), svc('chat', 'production', { tag: 'latest', da: '2026-10-03T10:05:00Z' })],
  })
  const [api, chat] = righeTabella(q, { ora: ORA })
  const c = celleLista(api)
  assert.deepEqual(c.versione.valore.rich_text[0].elements[0].elements, [{ type: 'link', url: 'https://github.com/acme/api/commit/aaaaaaa', text: 'aaaaaaa' }])
  assert.equal(c.versione.firma, 'aaaaaaa', 'la firma è il testo del link, com’è riletto')
  assert.equal(c.dettagli.firma, 'rev 9 · 2/2 task', 'le due cose che contano, uguali al canvas')
  assert.equal(api.celle[2], '[aaaaaaa](https://github.com/acme/api/commit/aaaaaaa) · rev 9 · 2/2 task', 'anche nel canvas: versione e due voci corte')
  assert.deepEqual(celleLista(chat).versione, { firma: '', valore: { rich_text: [] } }, 'un tag che non è un commit: niente link')
  assert.equal(chat.celle[2], '`latest` · 1/1 task', 'e nel canvas resta testo: /commit/latest porterebbe a un 404')
})

test('il canvas porta in fondo il link alla List del suo ambiente', async () => {
  const s = slackFinto()
  const cfg = quadroConfig({ DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_PUBLIC_URL: URL })
  await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: listaDati(SERVIZI_LISTA), ora: ORA, liste: nuovaMemoriaListe() })
  const md = [...s.canvas.values()].map((c) => s.html(c.blocchi)).join('')
  const lista = [...s.liste.keys()][0]
  assert.match(md, new RegExp(`<lnk href="https://x\\.slack\\.com/lists/T1/${lista}">Lista PROD</lnk>  \\|  Dadaguard:`), 'nel canvas principale e in quelli trasversali')
})

// ── Le righe sono le risorse ──────────────────────────────────────────────────────────────────────
//
// Una riga in più o in meno vuol dire riscrivere il canvas intero, cioè lo sdoppio nel client aperto.
// Il 05/10/2026 è successo senza che nascesse o sparisse niente: un riavvio a mano di un orchestratore
// con sei servizi sulla stessa immagine esterna ha separato la riga sola dell'immagine in sei righe.
// Qui una serie di istantanee in cui cambia SOLO lo stato (riavvii, deploy in corso, immagini che si
// separano e si riuniscono, Lambda aggiornate insieme, build e risorse non lette): nessuna deve
// cambiare la forma, né del canvas né della List.
const RIGHE_ORA = ORA
const minFa = (m) => new Date(RIGHE_ORA - m * 60_000).toISOString()
const riavvio = (service, startedAt) => ({ service, kind: 'restart', status: 'SUCCEEDED', startedAt, forcedBy: 'dev' })
function istantanea({
  riavvii = [],
  inCorso = false,
  rollout = [],
  tagShadow = 'e4ce302',
  tagTunnel = '2026.8.1',
  lambdaInsieme = false,
  buildLette = true,
  buildEnrich = false,
  senzaLambda = false,
  fantasma = false,
} = {}) {
  const P = 'production'
  const builds = [
    b('api', 'aaaaaaa', minFa(600), 'SUCCEEDED', { repo: 'https://github.com/acme/api', number: 10 }),
    ...(inCorso ? [b('api', 'bbbbbbb', minFa(3), 'IN_PROGRESS', { repo: 'https://github.com/acme/api', number: 11, phase: 'BUILD' })] : []),
    b('sito', 'ccccccc', minFa(900), 'SUCCEEDED', { repo: 'https://github.com/acme/sito', number: 4 }),
    b('IaC', 'ddddddd', minFa(800), 'SUCCEEDED', { iac: true, repo: 'https://github.com/acme/infra', number: 90 }),
    ...(buildEnrich ? [b('enrich', 'e4ce302', minFa(20), 'SUCCEEDED', { repo: 'https://github.com/acme/scraper', number: 2 })] : []),
    ...riavvii.map((n) => riavvio(n, minFa(2))),
    ...(fantasma ? [riavvio('fantasma', minFa(1))] : []),
  ]
  const orch = (n) => svc(`acme-production-${n}`, P, { tag: '3.6.26-python3.12', repo: 'orch', da: '2026-09-20T10:00:00Z', deploying: rollout.includes(n) })
  const servizi = [
    svc('acme-production-api', P, { tag: 'aaaaaaa', repo: 'api', da: minFa(590), deploying: inCorso }),
    orch('orch-server'),
    orch('orch-worker'),
    orch('orch-worker-doc'),
    svc('acme-production-tenders', P, { tag: 'e4ce302', repo: 'scraper-image', da: minFa(120) }),
    svc('acme-production-enrich', P, { tag: 'e4ce302', repo: 'scraper-image', da: minFa(120) }),
    svc('acme-production-cron-shadow', P, { type: 'ecs-scheduled', tag: tagShadow, repo: 'scraper-image', da: tagShadow === 'e4ce302' ? minFa(120) : '2026-09-01T00:00:00Z' }),
    svc('acme-production-cron-backup-a', P, { type: 'ecs-scheduled', tag: 'fffffff', repo: 'backup', da: '2026-09-02T00:00:00Z' }),
    svc('acme-production-cron-backup-b', P, { type: 'ecs-scheduled', tag: 'fffffff', repo: 'backup', da: '2026-09-02T00:00:00Z' }),
    svc('acme-production-tunnel', P, { tag: '2026.8.1', repo: 'tunnel', da: '2026-09-03T00:00:00Z' }),
    svc('acme-production-tunnel-b', P, { tag: tagTunnel, repo: 'tunnel', da: '2026-09-03T00:00:00Z' }),
    ...(senzaLambda
      ? []
      : [
          lam('acme-production-cron-report', P, lambdaInsieme ? minFa(10) : '2026-09-10T00:00:00Z', 'dev'),
          lam('acme-production-cron-pulizia', P, lambdaInsieme ? minFa(8) : '2026-09-11T00:00:00Z', 'dev'),
          lam('acme-production-notifier-a', P, lambdaInsieme ? minFa(9) : '2026-09-12T00:00:00Z', lambdaInsieme ? 'dev' : 'codebuild-iac-80'),
          lam('acme-production-notifier-b', P, lambdaInsieme ? minFa(7) : '2026-09-13T00:00:00Z', 'dev'),
        ]),
  ]
  // La discovery che non legge le Lambda le fa sparire, e lo dice come fa quella vera.
  servizi.problemi = senzaLambda ? [{ account: P, region: 'eu-central-1', problems: [{ what: 'lambda', err: 'ThrottlingException' }] }] : []
  return { deploys: { production: buildLette ? { builds } : { error: 'Could not connect to the endpoint URL' } }, servizi }
}
const CFG_RIGHE = { DADAGUARD_QUADRO_CANALI: 'produzione=CP', DADAGUARD_QUADRO_SQUADRE: 'data=scraper-image', DADAGUARD_PUBLIC_URL: URL }
const nomiTabella = (s, id) =>
  leggiCanvasHtml(s.html(s.canvas.get(id).blocchi))
    .filter((x) => x.tipo === 'table')
    .map((t) => t.righe.slice(1).map((r) => r[0].testo))

test('righe = risorse: un riavvio, un deploy in corso, un’immagine che si separa o si unisce non cambiano le righe', () => {
  const cfg = quadroConfig(CFG_RIGHE)
  const modelli = (dati) => Object.fromEntries(canvasDaScrivere(quadro(dati, cfg.ambienti), cfg, { ora: RIGHE_ORA }).map((c) => [c.chiave, c]))
  const s = slackFinto()
  const prima = modelli(istantanea())
  // Il canvas com'è dopo la prima istantanea, per ogni scheda: lo si scrive nello Slack finto e lo si rilegge.
  const blocchi = Object.fromEntries(
    Object.values(prima).map((c) => {
      const id = `F-${c.chiave}`
      s.api('conversations.canvases.create', { channel_id: 'CP', title: c.titolo, document_content: { markdown: c.markdown } })
      const creato = [...s.canvas.values()].at(-1)
      s.canvas.set(id, { ...creato, id })
      return [c.chiave, leggiCanvasHtml(s.html(creato.blocchi))]
    }),
  )
  assert.deepEqual(prima.produzione.modello.sezioni[0].righe.map((r) => testoPiatto(r[0])), ['api', 'IaC', 'notifier-a', 'notifier-b', 'orch-server', 'orch-worker', 'orch-worker-doc', 'sito', 'tunnel', 'tunnel-b'])
  assert.deepEqual(prima.cron.modello.sezioni[0].righe.map((r) => testoPiatto(r[0])), ['backup-a', 'backup-b', 'pulizia', 'report'])
  assert.deepEqual(prima.data.modello.sezioni[0].righe.map((r) => testoPiatto(r[0])), ['enrich', 'shadow', 'tenders'])
  const casi = {
    'riavvio a mano di tutti i servizi sulla stessa immagine esterna': { riavvii: ['orch-server', 'orch-worker', 'orch-worker-doc'] },
    'riavvio di uno solo, con un rollout in corso': { riavvii: ['orch-worker'], rollout: ['orch-worker'] },
    'deploy in corso': { inCorso: true },
    'un cron rimasto su un’immagine più vecchia (l’immagine si separa)': { tagShadow: '1111111' },
    'un componente esterno su una versione diversa dall’altro': { tagTunnel: '2026.9.0' },
    'una build propria per uno dei servizi con l’immagine condivisa': { buildEnrich: true },
    'Lambda aggiornate insieme dalla stessa persona': { lambdaInsieme: true },
    'il riavvio di un servizio che la discovery non vede': { fantasma: true },
  }
  for (const [caso, stato] of Object.entries(casi)) {
    const dopo = modelli(istantanea(stato))
    for (const chiave of Object.keys(prima)) assert.notEqual(pianoCelle(dopo[chiave].modello, blocchi[chiave]), null, `${caso}: la scheda ${chiave} si aggiorna cella per cella`)
  }
  const cambi = pianoCelle(modelli(istantanea({ tagShadow: '1111111' })).data.modello, blocchi.data)
  assert.ok(cambi.some((m) => /⚠️ indietro/.test(m.markdown)), 'chi è rimasto indietro lo dice il suo stato, non una riga in più')
})

test('righe = risorse anche con le squadre per nome: cambia lo stato, non la scheda né le righe', () => {
  // Esterni, Lambda dell'infrastruttura e Lambda da cron presi per nome: la scheda la decide il nome,
  // che un riavvio o un giro di Lambda non cambiano.
  const cfg = quadroConfig({ ...CFG_RIGHE, DADAGUARD_QUADRO_SQUADRE: 'data=scraper-image,orch-*,notifier-*,pulizia*' })
  const modelli = (dati) => Object.fromEntries(canvasDaScrivere(quadro(dati, cfg.ambienti), cfg, { ora: RIGHE_ORA }).map((c) => [c.chiave, c.modello]))
  const righe = (m) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, x.sezioni[0].righe.map((r) => testoPiatto(r[0]))]))
  const prima = righe(modelli(istantanea()))
  assert.deepEqual(prima.data, ['enrich', 'notifier-a', 'notifier-b', 'orch-server', 'orch-worker', 'orch-worker-doc', 'pulizia', 'shadow', 'tenders'])
  assert.deepEqual(prima.produzione, ['api', 'IaC', 'sito', 'tunnel', 'tunnel-b'])
  assert.deepEqual(prima.cron, ['backup-a', 'backup-b', 'report'])
  for (const stato of [{ riavvii: ['orch-server', 'orch-worker'] }, { rollout: ['orch-worker'] }, { inCorso: true }, { lambdaInsieme: true }, { tagShadow: '1111111' }])
    assert.deepEqual(righe(modelli(istantanea(stato))), prima, JSON.stringify(stato))
})

test('righe = risorse: build o Lambda non lette lasciano le righe dove sono, nel canvas e nella List', async () => {
  const s = slackFinto()
  const cfg = quadroConfig(CFG_RIGHE)
  const liste = nuovaMemoriaListe()
  const ultimi = new Map()
  const giro = (stato) => aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: async () => istantanea(stato), ora: RIGHE_ORA, ultimi, liste })
  const primo = await giro({})
  assert.deepEqual(primo.map((e) => `${e.ambiente}:${e.azione}`), ['produzione:creato', 'cron:creato', 'data:creato', 'lista-produzione:creata'])
  const prod = primo[0].canvas
  const righePrima = nomiTabella(s, prod)
  const lista = [...s.liste.values()][0]
  const righeLista = () => [...lista.righe.keys()].sort()
  const listaPrima = righeLista()
  assert.equal(listaPrima.length, 17, 'una riga per risorsa: 10 della principale, 4 cron e 3 della squadra')

  for (const stato of [
    { riavvii: ['orch-server', 'orch-worker', 'orch-worker-doc'] },
    { inCorso: true, lambdaInsieme: true },
    { tagShadow: '1111111', tagTunnel: '2026.9.0' },
    { buildLette: false },
    {},
    { senzaLambda: true },
    { buildLette: false, senzaLambda: true },
    {},
  ]) {
    const esiti = await giro(stato)
    const riscritti = esiti.filter((e) => e.azione === 'riscritto' || e.azione === 'creato' || e.azione === 'creata' || e.azione === 'errore')
    assert.deepEqual(riscritti, [], `${JSON.stringify(stato)}: niente riscritture intere`)
    assert.deepEqual(nomiTabella(s, prod), righePrima, `${JSON.stringify(stato)}: le righe del canvas restano quelle`)
    assert.deepEqual(righeLista(), listaPrima, `${JSON.stringify(stato)}: e quelle della List`)
  }
  const ignote = leggiCanvasHtml(s.html(s.canvas.get(prod).blocchi))
  assert.ok(ignote.some((x) => x.tipo === 'p' && /niente di rotto/.test(x.testo)), 'tornate le letture, la sintesi torna quella vera')

  // Una risorsa nuova invece cambia le righe, ed è l'unico caso in cui il canvas si riscrive intero.
  const conNuova = async () => {
    const d = istantanea()
    d.servizi.push(svc('acme-production-nuovo', 'production', { tag: '9999999', repo: 'nuovo', da: minFa(5) }))
    return d
  }
  const ultimo = await aggiornaQuadri(cfg, { api: s.api, scarica: s.scarica, leggiDati: conNuova, ora: RIGHE_ORA, ultimi, liste })
  assert.equal(ultimo[0].azione, 'riscritto')
})

test('build non lette: la riga che il canvas ha e il modello no resta, ma una risorsa nuova riscrive lo stesso', () => {
  const modello = (righe, tollera) => ({ sezioni: [{ titolo: 'Produzione', sintesi: '**x**', righe: righe.map((n) => [`**${n}**`, '🚀 OK', 'n/d']), fondo: null, tollera }] })
  const html = `<h2 id="h">Produzione</h2><p id="s" class="line"><b>x</b></p><table><tr>${INTESTAZIONE_HTML}</tr>${['api', 'IaC', 'sito', 'web']
    .map((n, i) => `<tr><td><p id="n${i}" class="line"><b>${n}</b></p></td><td><p id="t${i}" class="line">🚀 OK</p></td><td><p id="d${i}" class="line">n/d</p></td></tr>`)
    .join('')}</table>`
  const blocchi = leggiCanvasHtml(html)
  assert.deepEqual(pianoCelle(modello(['api', 'web'], true), blocchi), [], 'IaC e sito non letti: restano com’erano')
  assert.equal(pianoCelle(modello(['api', 'web'], false), blocchi), null, 'letti e spariti: sono un’altra forma')
  assert.equal(pianoCelle(modello(['api', 'nuovo', 'web'], true), blocchi), null, 'una risorsa nuova vuole la riscrittura anche così')
  assert.equal(pianoCelle(modello([], true), blocchi).length, 0, 'anche senza nessuna riga letta')
})
const INTESTAZIONE_HTML = ['Risorsa', 'Stato', 'Dettagli'].map((h, i) => `<td><p id="i${i}" class="line">${h}</p></td>`).join('')
