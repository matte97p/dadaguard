// Il quadro dei deploy sostituisce la lettura all'indietro del canale dei rilasci: se sbaglia lo stato
// di un servizio lo sbaglia in cima al canale, fissato, dove tutti lo guardano. Qui si inchiodano i
// tre stati, il ritrovamento del messaggio (che è ciò che lo tiene a un messaggio solo) e il giro.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statoServizio, quadro, rigaServizio, messaggioQuadro, trovaFissato, aggiornaQuadri, quadroConfig } from '../server/notify/quadro.js'

const b = (service, commit, startedAt, status = 'SUCCEEDED', extra = {}) => ({
  service,
  commit,
  startedAt,
  status,
  inProgress: status === 'IN_PROGRESS',
  ...extra,
})

test('ok: l’ultimo tentativo è riuscito, e quello è il commit che gira', () => {
  const s = statoServizio([b('api', 'aaa', '2026-10-01T10:00:00Z'), b('api', 'bbb', '2026-10-02T10:00:00Z', 'SUCCEEDED', { author: 'dev@example.com' })])
  assert.equal(s.stato, 'ok')
  assert.equal(s.commit, 'bbb')
  assert.equal(s.autore, 'dev@example.com')
})

test('fallito: dice anche cosa gira ancora, perché un rosso da solo sembra un servizio giù', () => {
  const s = statoServizio([b('api', 'aaa', '2026-10-01T10:00:00Z'), b('api', 'bbb', '2026-10-02T10:00:00Z', 'FAILED', { failPhase: 'BUILD' })])
  assert.equal(s.stato, 'fallito')
  assert.equal(s.commit, 'aaa', 'il commit che gira è l’ultimo riuscito')
  assert.equal(s.nuovo, 'bbb')
  assert.equal(s.fase, 'BUILD')
})

test('un fallimento VECCHIO, superato da un riuscito, non tiene il servizio rosso per sempre', () => {
  const s = statoServizio([b('api', 'bbb', '2026-10-01T10:00:00Z', 'FAILED'), b('api', 'ccc', '2026-10-02T10:00:00Z')])
  assert.equal(s.stato, 'ok')
  assert.equal(s.commit, 'ccc')
})

test('in corso: il commit che gira resta quello di prima finché il rilascio non finisce', () => {
  const s = statoServizio([b('api', 'aaa', '2026-10-01T10:00:00Z'), b('api', 'bbb', '2026-10-02T10:00:00Z', 'IN_PROGRESS', { phase: 'BUILD' })])
  assert.equal(s.stato, 'in_corso')
  assert.equal(s.commit, 'aaa')
  assert.equal(s.nuovo, 'bbb')
})

test('un riavvio a mano non è un rilascio: il commit non cambia, il riavvio si dice', () => {
  const s = statoServizio([
    b('api', 'aaa', '2026-10-01T10:00:00Z'),
    { service: 'api', kind: 'restart', status: 'SUCCEEDED', startedAt: '2026-10-02T10:00:00Z', commit: null, forcedBy: 'persona' },
  ])
  assert.equal(s.stato, 'ok')
  assert.equal(s.commit, 'aaa')
  assert.equal(s.riavvio.chi, 'persona')
})

test('un riavvio fallito si dice riavvio, e senza riuscito non si inventa cosa gira', () => {
  const s = statoServizio([{ service: 'api', kind: 'restart', status: 'FAILED', startedAt: '2026-10-02T10:00:00Z', commit: null }])
  assert.equal(s.stato, 'fallito')
  const riga = rigaServizio({ servizio: 'api', ...s }, Date.parse('2026-10-02T11:00:00Z'))
  assert.equal(riga, '🔴 `api` riavvio fallito 1 h fa · nessun rilascio riuscito nella finestra')
})

test('il quadro separa gli ambienti, salta gli account senza deploy e segna staging avanti', () => {
  const q = quadro({
    staging: { builds: [b('api', 'nuovo', '2026-10-02T10:00:00Z'), b('web', 'uguale', '2026-10-02T09:00:00Z')] },
    production: { builds: [b('api', 'vecchio', '2026-10-01T10:00:00Z'), b('web', 'uguale', '2026-10-01T09:00:00Z')] },
    management: { builds: [b('dashboard', 'x', '2026-10-01T09:00:00Z')] },
    security: { error: 'AccessDenied' },
  })
  assert.deepEqual(q.produzione.map((r) => r.servizio), ['api', 'web'])
  assert.equal(q.produzione.find((r) => r.servizio === 'api').stagingAvanti, true)
  assert.equal(q.produzione.find((r) => r.servizio === 'web').stagingAvanti, false)
  assert.equal(q.staging.every((r) => r.stagingAvanti === false), true, 'staging non è avanti a sé stesso')
})

test('nel quadro entrano build e riavvii, non le altre azioni a mano', () => {
  const q = quadro({
    production: {
      builds: [
        b('api', 'a', '2026-10-02T10:00:00Z'),
        { service: 'sg-0abc', kind: 'sg-open', status: 'SUCCEEDED', startedAt: '2026-10-02T11:00:00Z' },
        { service: 'worker', kind: 'exec', status: 'SUCCEEDED', startedAt: '2026-10-02T11:00:00Z' },
      ],
    },
  })
  assert.deepEqual(q.produzione.map((r) => r.servizio), ['api'])
})

test('l’autore si accorcia come nella pagina dei rilasci, alias compresi', () => {
  const r = { servizio: 'api', stato: 'ok', commit: 'a', autore: '12345678+dev@users.noreply.github.com' }
  assert.match(rigaServizio(r, Date.now()), / · dev$/)
  assert.match(rigaServizio(r, Date.now(), { dev: 'persona' }), / · persona$/)
})

test('la riga segue la grammatica del canale: emoji, nome e commit in backtick', () => {
  const ora = Date.parse('2026-10-02T10:05:00Z')
  const riga = rigaServizio({ servizio: 'api', stato: 'in_corso', commit: 'aaa', nuovo: 'bbb', fase: 'BUILD', da: '2026-10-02T10:00:00Z' }, ora)
  assert.equal(riga, '⏳ `api` `aaa` → `bbb` · in corso (BUILD) da 5 min')
  assert.match(rigaServizio({ servizio: 'api', stato: 'fallito', commit: 'aaa', nuovo: 'bbb', da: '2026-10-02T10:00:00Z' }, ora), /^🔴 `api` `bbb` fallito .*gira ancora `aaa`/)
  assert.doesNotMatch(riga, /—/, 'niente trattino lungo')
})

test('il testo comincia sempre con l’intestazione: è il marcatore per ritrovarlo', () => {
  const m = messaggioQuadro('produzione', [{ servizio: 'api', stato: 'fallito', commit: 'a', nuovo: 'b', da: null }])
  assert.match(m.text, /^Quadro deploy \[PROD\]: 🔴 1 fallito/)
  assert.equal(m.metadata.event_payload.ambiente, 'produzione')
})

test('le sezioni restano sotto il tetto di Slack anche con molti servizi', () => {
  const righe = Array.from({ length: 80 }, (_, i) => ({ servizio: `servizio-con-un-nome-lungo-${i}`, stato: 'ok', commit: 'abcdef0', autore: 'dev@example.com' }))
  const m = messaggioQuadro('staging', righe)
  for (const blocco of m.blocks.filter((x) => x.type === 'section')) assert.ok(blocco.text.text.length <= 3000)
})

test('si ritrova il quadro giusto, e solo se l’abbiamo scritto noi', () => {
  const items = [
    { type: 'message', message: { ts: '1', bot_id: 'ALTRO', text: 'Quadro deploy [PROD]: a mano' } },
    { type: 'message', message: { ts: '2', bot_id: 'NOI', text: 'Quadro deploy [STAGING]: x', metadata: { event_type: 'dadaguard_quadro', event_payload: { ambiente: 'staging' } } } },
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
  const esiti = await aggiornaQuadri(cfg, { api, leggiDeploy: async () => ({ production: { builds: [b('api', 'a', '2026-10-02T10:00:00Z')] } }) })
  assert.deepEqual(esiti.map((e) => `${e.ambiente}:${e.azione}`), ['produzione:riscritto', 'staging:creato'])
  const metodi = chiamate.map(([m]) => m)
  assert.deepEqual(metodi, ['auth.test', 'pins.list', 'chat.update', 'chat.postMessage', 'pins.add'])
  assert.equal(chiamate.find(([m]) => m === 'pins.add')[1].timestamp, '10')
})

test('senza token o canale il quadro non parte', () => {
  assert.equal(quadroConfig({}).token, null)
  assert.deepEqual(quadroConfig({ DADAGUARD_QUADRO_AMBIENTI: 'staging, inventato' }).ambienti, ['staging'])
})
