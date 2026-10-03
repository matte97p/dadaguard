// Il quadro dei deploy sostituisce la lettura all'indietro del canale dei rilasci: se sbaglia lo stato
// di un servizio lo sbaglia in cima al canale, fissato, dove tutti lo guardano. Qui si inchiodano gli
// stati, l'unione fra ECS e CodeBuild, le immagini condivise, il ritrovamento del messaggio (che è ciò
// che lo tiene a un messaggio solo) e il giro.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  statoBuild,
  quadroAmbiente,
  quadro,
  rigaServizio,
  rigaImmagine,
  rigaInfra,
  messaggioQuadro,
  trovaFissato,
  aggiornaQuadri,
  quadroConfig,
} from '../server/notify/quadro.js'
import { imageRepo } from '../server/checks/version.js'
import { serviceFromProject } from '../server/deploys.js'

const ORA = Date.parse('2026-10-03T12:00:00Z')
const b = (service, commit, startedAt, status = 'SUCCEEDED', extra = {}) => ({
  service,
  commit,
  startedAt,
  status,
  inProgress: status === 'IN_PROGRESS',
  ...extra,
})
// Un servizio come lo restituisce /api/status: runtime e version sono i due check che servono.
const svc = (name, account, { type = 'ecs', tag = null, repo = null, da = null, by = null, overall = 'up', deploying = false, task = [1, 1] } = {}) => ({
  name,
  type,
  overall,
  account: { key: account },
  checks: {
    runtime: { desiredCount: task[1], runningCount: task[0], deploying },
    version: { build: { tag, repo, deployedAt: da, by } },
  },
})

test('le build: l’ultimo tentativo decide, ma un fallimento superato non tiene rosso', () => {
  assert.equal(statoBuild([b('api', 'a', '2026-10-01T10:00:00Z'), b('api', 'b', '2026-10-02T10:00:00Z', 'FAILED')]).stato, 'fallito')
  assert.equal(statoBuild([b('api', 'b', '2026-10-01T10:00:00Z', 'FAILED'), b('api', 'c', '2026-10-02T10:00:00Z')]).stato, 'ok')
  assert.equal(statoBuild([b('api', 'a', '2026-10-01T10:00:00Z'), b('api', 'b', '2026-10-02T10:00:00Z', 'IN_PROGRESS')]).stato, 'in_corso')
  assert.equal(statoBuild([]), null)
})

test('cosa gira lo dice ECS, e l’autore viene dalla build che l’ha prodotto', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-02T10:00:00Z', 'SUCCEEDED', { author: 'dev@example.com', repo: 'https://github.com/x/api' })] } },
    servizi: [svc('api', 'production', { tag: 'aaaaaaa1', repo: 'api', da: '2026-10-02T10:05:00Z', task: [3, 3] })],
  })
  const [r] = q.app
  assert.equal(r.commit, 'aaaaaaa')
  assert.equal(r.chi, 'dev')
  assert.equal(r.task, '3/3')
  assert.equal(r.repo, 'https://github.com/x/api')
})

test('una revisione promossa a mano: gira un’immagine di nessuna build, e l’autore è chi l’ha registrata', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('api', 'aaaaaaa', '2026-10-01T10:00:00Z', 'SUCCEEDED', { author: 'dev@example.com' })] } },
    servizi: [svc('api', 'production', { tag: 'bbbbbbbb', repo: 'api', da: '2026-10-02T10:00:00Z', by: 'persona' })],
  })
  assert.equal(q.app[0].commit, 'bbbbbbb')
  assert.equal(q.app[0].chi, 'persona')
})

test('un rollout in ECS è «in corso» anche senza una build (riavvio, segreto cambiato)', () => {
  const q = quadroAmbiente('staging', { servizi: [svc('api', 'staging', { tag: 'aaaaaaa', deploying: true })] })
  assert.equal(q.app[0].stato, 'in_corso')
})

test('un servizio giù vince su tutto', () => {
  const q = quadroAmbiente('staging', {
    deploys: { staging: { builds: [b('api', 'a', '2026-10-02T10:00:00Z', 'FAILED')] } },
    servizi: [svc('api', 'staging', { overall: 'down', task: [0, 2] })],
  })
  assert.equal(q.app[0].stato, 'giu')
  assert.match(rigaServizio(q.app[0], { ora: ORA }), /^🚨 {2}\*api\* {2}\*giù\* {2}· {2}0\/2 task/)
})

test('le immagini condivise senza build diventano una riga sola, coi ritardatari per nome', () => {
  const q = quadroAmbiente('produzione', {
    servizi: [
      svc('tenders', 'production', { tag: 'e4ce3020d1c2', repo: 'scraper', da: '2026-10-03T10:00:00Z', by: 'acme-production-refresh' }),
      svc('enrich', 'production', { tag: 'e4ce3020d1c2', repo: 'scraper', da: '2026-10-03T10:00:00Z' }),
      svc('shadow', 'production', { type: 'ecs-scheduled', tag: '3e2f9371c5f1', repo: 'scraper', da: '2026-10-03T08:00:00Z' }),
      svc('api', 'production', { tag: 'aaaaaaa', repo: 'api' }),
    ],
  })
  assert.deepEqual(q.app.map((r) => r.servizio), ['api'], 'chi sta in un’immagine condivisa non ha la sua riga')
  const [g] = q.immagini
  assert.equal(g.repo, 'scraper')
  assert.deepEqual(g.servizi, ['enrich', 'tenders'])
  assert.deepEqual(g.cron, ['shadow'])
  assert.deepEqual(g.indietro, [{ nome: 'shadow', tag: '3e2f937' }])
  assert.equal(g.chi, 'refresh', 'l’organizzazione e l’ambiente si tolgono dal nome dell’automatismo')
  assert.match(rigaImmagine(g, { ora: ORA }), /^⚠️ {2}\*scraper\* {2}`e4ce302` su 2 servizi e 1 cron/)
})

test('un repo condiviso da un servizio con una build sua NON è un’immagine condivisa', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('backend', 'aaaaaaa', '2026-10-02T10:00:00Z')] } },
    servizi: [svc('backend', 'production', { tag: 'aaaaaaa', repo: 'backend' }), svc('garanzia', 'production', { tag: 'aaaaaaa', repo: 'backend' })],
  })
  assert.equal(q.immagini.length, 0)
  assert.deepEqual(q.app.map((r) => r.servizio).sort(), ['backend', 'garanzia'])
})

test('le altre azioni a mano non diventano servizi, l’IaC ha la sua riga', () => {
  const q = quadroAmbiente('staging', {
    deploys: {
      staging: {
        builds: [
          b('api', 'a', '2026-10-02T10:00:00Z'),
          { service: 'sg-0abc', kind: 'sg-open', status: 'SUCCEEDED', startedAt: '2026-10-02T11:00:00Z' },
          { service: 'worker', kind: 'exec', status: 'SUCCEEDED', startedAt: '2026-10-02T11:00:00Z' },
          b('IaC', 'd25f688', '2026-10-03T11:00:00Z', 'IN_PROGRESS', { iac: true, author: 'dev@example.com' }),
        ],
      },
    },
  })
  assert.deepEqual(q.app.map((r) => r.servizio), ['api'])
  assert.equal(q.infra.stato, 'in_corso')
  assert.match(rigaInfra(q.infra, { ora: ORA }), /^⏳ {2}\*IaC\* {2}apply in corso da 1 h/)
})

test('produzione dice quando staging è su un altro commit, e solo lì', () => {
  const q = quadro({
    servizi: [svc('api', 'staging', { tag: 'nuovo00' }), svc('api', 'production', { tag: 'vecchio' }), svc('web', 'staging', { tag: 'uguale0' }), svc('web', 'production', { tag: 'uguale0' })],
  })
  assert.equal(q.produzione.app.find((r) => r.servizio === 'api').staging, 'nuovo00')
  assert.equal(q.produzione.app.find((r) => r.servizio === 'web').staging, undefined)
  assert.ok(q.staging.app.every((r) => r.staging === undefined))
})

test('la riga: stato, nome, cosa gira, task, da quanto e chi, sempre in quest’ordine', () => {
  const ok = { servizio: 'api', stato: 'ok', commit: 'aaaaaaa', task: '3/3', quando: '2026-10-03T08:00:00Z', chi: 'dev', staging: 'bbbbbbb' }
  assert.equal(rigaServizio(ok, { ora: ORA }), '✅  *api*  `aaaaaaa`  ·  3/3 task  ·  4 h fa, dev  ·  staging su `bbbbbbb`')
  const fallito = { servizio: 'api', stato: 'fallito', commit: 'aaaaaaa', nuovo: 'bbbbbbb', fase: 'BUILD', tentativoDa: '2026-10-03T11:30:00Z' }
  assert.equal(rigaServizio(fallito, { ora: ORA }), '🔴  *api*  `bbbbbbb` fallito al BUILD 30 min fa  ·  gira ancora `aaaaaaa`')
  const riavvio = { servizio: 'api', stato: 'fallito', commit: null, riavvioFallito: true, tentativoDa: '2026-10-03T11:00:00Z' }
  assert.equal(rigaServizio(riavvio, { ora: ORA }), '🔴  *api*  riavvio fallito 1 h fa  ·  nessun rilascio riuscito visto')
})

test('nome e commit sono link: alla pagina Deploy filtrata e al commit su GitHub', () => {
  const r = { servizio: 'api', chiave: 'production', stato: 'ok', commit: 'aaaaaaa', repo: 'https://github.com/x/api', quando: null }
  const riga = rigaServizio(r, { ora: ORA, url: 'https://dg.example.com' })
  assert.match(riga, /<https:\/\/dg\.example\.com\/deploy\?service=api&account=production\|api>/)
  assert.match(riga, /<https:\/\/github\.com\/x\/api\/commit\/aaaaaaa\|`aaaaaaa`>/)
})

test('il messaggio: barra del colore dell’ambiente, sintesi in testa, problemi in cima, fermi in fondo', () => {
  const q = {
    ambiente: 'produzione',
    chiave: 'production',
    app: [
      { servizio: 'vecchio', stato: 'ok', commit: 'a', quando: '2026-09-01T00:00:00Z' },
      { servizio: 'recente', stato: 'ok', commit: 'b', quando: '2026-10-03T11:00:00Z' },
      { servizio: 'rotto', stato: 'fallito', commit: 'c', nuovo: 'd', tentativoDa: '2026-10-03T11:00:00Z' },
    ],
    immagini: [],
    infra: null,
  }
  const m = messaggioQuadro(q, { ora: ORA, url: 'https://dg.example.com' })
  assert.equal(m.attachments[0].color, '#E01E5A')
  assert.match(m.text, /^Quadro deploy \[PROD\]: 🔴 1 da guardare/)
  const blocchi = m.attachments[0].blocks
  assert.equal(blocchi[0].text.text, '🟥  PRODUZIONE')
  const app = blocchi.find((x) => x.type === 'section').text.text
  assert.ok(app.indexOf('rotto') < app.indexOf('recente'), 'il problema sale in cima')
  assert.doesNotMatch(app, /vecchio/, 'il fermo da settimane non ha una riga sua')
  assert.match(JSON.stringify(blocchi), /Fermi e sani\* da più di 7 giorni: vecchio/)
  assert.ok(blocchi.some((x) => x.type === 'actions'), 'i filtri sono pulsanti verso Dadaguard')
  assert.doesNotMatch(JSON.stringify(m), /—/, 'niente trattino lungo')
})

test('nomi senza prefisso, ECS e CodeBuild si incontrano, un cron rosso non è un deploy rotto', () => {
  const q = quadroAmbiente('produzione', {
    deploys: { production: { builds: [b('dashboard', 'aaaaaaa', '2026-10-02T10:00:00Z')] } },
    servizi: [
      svc('acme-production-dashboard', 'production', { tag: 'aaaaaaa', repo: 'dashboard' }),
      svc('acme-production-cron-pulizia', 'production', { type: 'ecs-scheduled', tag: 'bbbbbbb', repo: 'jobs', overall: 'down' }),
      svc('acme-production-cron-report', 'production', { type: 'ecs-scheduled', tag: 'bbbbbbb', repo: 'jobs' }),
    ],
  })
  assert.deepEqual(q.app.map((r) => r.servizio), ['dashboard'], 'una riga sola, non due')
  assert.deepEqual(q.immagini[0].cron, ['pulizia', 'report'])
  assert.deepEqual(q.immagini[0].giu, [], 'il cron fallito lo racconta il canale dei cron')
})

test('i componenti esterni stanno in una riga piccola, separati dalle nostre applicazioni', () => {
  const q = quadroAmbiente('produzione', {
    servizi: [
      svc('acme-production-orchestratore', 'production', { tag: '3.6.26-python3.12', repo: 'orch', da: '2026-10-03T11:59:00Z', deploying: true }),
      svc('acme-production-orchestratore-worker', 'production', { tag: '3.6.26-python3.12', repo: 'orch', da: '2026-10-03T11:59:00Z' }),
      svc('acme-production-db-ui', 'production', { tag: 'v2.195.0', repo: 'db-ui', da: '2026-09-28T00:00:00Z' }),
      svc('api', 'production', { tag: 'aaaaaaa', repo: 'api', da: '2026-10-03T11:00:00Z' }),
    ],
  })
  const m = messaggioQuadro(q, { ora: ORA })
  const blocchi = m.attachments[0].blocks
  const app = blocchi.find((x) => x.type === 'section').text.text
  assert.match(app, /api/)
  assert.doesNotMatch(app, /db-ui|orch/)
  const esterni = JSON.stringify(blocchi.filter((x) => x.type === 'context'))
  assert.match(esterni, /Componenti esterni.*⏳ orch `3\.6\.26-python3\.12` ×2 1 min.*db-ui `v2\.195\.0` 6 g/)
})

test('le sezioni restano sotto il tetto di Slack anche con molti servizi', () => {
  const app = Array.from({ length: 80 }, (_, i) => ({ servizio: `servizio-con-un-nome-lungo-${i}`, stato: 'ok', commit: 'abcdef0', quando: '2026-10-03T11:00:00Z' }))
  const m = messaggioQuadro({ ambiente: 'staging', app, immagini: [], infra: null }, { ora: ORA })
  for (const x of m.attachments[0].blocks.filter((x) => x.type === 'section')) assert.ok(x.text.text.length <= 3000)
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

test('configurazione: senza token il quadro è spento, gli ambienti ignoti si scartano', () => {
  assert.equal(quadroConfig({}).token, null)
  assert.deepEqual(quadroConfig({ DADAGUARD_QUADRO_AMBIENTI: 'staging, inventato' }).ambienti, ['staging'])
  assert.equal(quadroConfig({ DADAGUARD_QUADRO_FERMI_GIORNI: 'mezzo' }).fermiGiorni, 7)
})

test('repo dell’immagine e progetto IaC, i due dati nuovi che il quadro legge', () => {
  assert.equal(imageRepo('123.dkr.ecr.eu-central-1.amazonaws.com/team/scraper:e4ce302'), 'scraper')
  assert.equal(imageRepo('scraper@sha256:abc'), 'scraper')
  assert.equal(imageRepo(null), null)
  assert.equal(serviceFromProject('acme-staging-iac-apply'), 'IaC')
  assert.equal(serviceFromProject('acme-staging-backend-deploy'), 'backend')
})
