import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linearConfig, linearAttivo, pianoTicket, testoTicket, giroTicket, urlRisorsa, prefissoRisorse } from '../server/notify/linear.js'
import { runOnce } from '../server/notify/watch.js'
import { makeT } from '../server/i18n.js'

// I ticket valgono solo se sono pochi e veri: uno per guasto conclamato, chiuso quando il guasto
// finisce. Un ticket di troppo insegna a chiuderli senza leggerli, uno che non si chiude mai sporca
// il triage per sempre.

const obs = (name, account = 'production', extra = {}) => ({ name, account, cause: 'runtime', type: 'ecs', detail: '0/2 task in esecuzione', ...extra })

test('linearConfig: destinazioni per route, priorità e opt-in di staging', () => {
  const cfg = linearConfig({
    DADAGUARD_LINEAR_API_KEY: 'k',
    DADAGUARD_LINEAR_DESTINAZIONI: 'main=team-pla:lab-bug,lab-infra; data=team-dat:lab-bug',
    DADAGUARD_PUBLIC_URL: 'https://dg.example.com/',
  })
  assert.deepEqual(cfg.destinazioni, {
    main: { teamId: 'team-pla', labelIds: ['lab-bug', 'lab-infra'] },
    data: { teamId: 'team-dat', labelIds: ['lab-bug'] },
  })
  assert.equal(cfg.priorita, 2)
  assert.equal(cfg.ancheStaging, false)
  assert.equal(linearAttivo(cfg), true)
  assert.equal(linearConfig({ DADAGUARD_LINEAR_PRIORITA: '9' }).priorita, 2, 'una priorità fuori scala torna al default')
  assert.deepEqual(linearConfig({ DADAGUARD_LINEAR_DESTINAZIONI: 'main=team-pla' }).destinazioni.main.labelIds, [])
})

test('linearAttivo: senza chiave, senza main o senza URL pubblico resta spento', () => {
  const base = { DADAGUARD_LINEAR_API_KEY: 'k', DADAGUARD_LINEAR_DESTINAZIONI: 'main=t', DADAGUARD_PUBLIC_URL: 'https://x' }
  assert.equal(linearAttivo(linearConfig({ ...base, DADAGUARD_LINEAR_API_KEY: '' })), false)
  assert.equal(linearAttivo(linearConfig({ ...base, DADAGUARD_LINEAR_DESTINAZIONI: 'data=t' })), false)
  assert.equal(linearAttivo(linearConfig({ ...base, DADAGUARD_PUBLIC_URL: '' })), false)
  assert.equal(linearAttivo(undefined), false)
})

test('urlRisorsa: la chiave torna intera, anche con barre e pipe', () => {
  const key = 'production/production|ecs|app|api'
  const url = urlRisorsa('https://dg.example.com/', key)
  assert.ok(url.startsWith(prefissoRisorse('https://dg.example.com')))
  assert.equal(decodeURIComponent(url.slice(prefissoRisorse('https://dg.example.com').length)), key)
})

test('pianoTicket: apre solo per un rosso confermato e annunciato', () => {
  const stato = {
    'production/api': { confirmed: 'down', alerted: true, route: 'main' },
    'production/web': { confirmed: 'degraded', alerted: true, route: 'main' }, // giallo: resta in chat
    'production/cron': { confirmed: 'down', alerted: false }, // taciuto dal routing o nato rosso
    'production/sparito': { confirmed: 'down', alerted: true },
  }
  const ora = { 'production/api': obs('api'), 'production/web': obs('web'), 'production/cron': obs('cron') }
  const { apri, chiudi } = pianoTicket(stato, ora, {})
  assert.deepEqual(apri.map((x) => x.key), ['production/api'])
  assert.equal(apri[0].route, 'main')
  assert.deepEqual(chiudi, [])
})

test('pianoTicket: un ticket già aperto non se ne apre un secondo', () => {
  const stato = { 'production/api': { confirmed: 'down', alerted: true } }
  const { apri } = pianoTicket(stato, { 'production/api': obs('api') }, { 'production/api': { id: 'i1', identifier: 'PLA-1' } })
  assert.deepEqual(apri, [])
})

test('pianoTicket: staging non apre ticket, se non su richiesta', () => {
  const stato = { 'staging/api': { confirmed: 'down', alerted: true } }
  const ora = { 'staging/api': obs('api', 'staging') }
  assert.deepEqual(pianoTicket(stato, ora, {}).apri, [])
  assert.equal(pianoTicket(stato, ora, {}, { ancheStaging: true }).apri.length, 1)
  // un account infra (security, payer) non è staging
  const infra = { 'security/gw': { confirmed: 'down', alerted: true } }
  assert.equal(pianoTicket(infra, { 'security/gw': obs('gw', 'security') }, {}).apri.length, 1)
})

test('pianoTicket: chiude solo su un verde confermato, non su unknown né su una risorsa sparita', () => {
  const aperti = {
    'production/a': { id: 'a', identifier: 'PLA-1' },
    'production/b': { id: 'b', identifier: 'PLA-2' },
    'production/c': { id: 'c', identifier: 'PLA-3' },
    'production/d': { id: 'd', identifier: 'PLA-4' },
  }
  const stato = {
    'production/a': { confirmed: 'up' },
    'production/b': { confirmed: 'unknown' },
    'production/d': { confirmed: 'degraded', alerted: true }, // alleggerito, non rientrato
  }
  const { chiudi } = pianoTicket(stato, {}, aperti)
  assert.deepEqual(chiudi.map((x) => x.ticket.identifier), ['PLA-1'])
})

test('pianoTicket: dopo un riavvio (stato vuoto) il ticket aperto resta, e si chiude al verde', () => {
  // Il rientro dopo un deploy è «orfano» per Slack (alerted perso): il ticket si chiude lo stesso,
  // perché il piano guarda lo stato e non le transizioni.
  const aperti = { 'production/api': { id: 'i', identifier: 'PLA-9' } }
  assert.deepEqual(pianoTicket({}, {}, aperti).chiudi, [])
  const dopo = pianoTicket({ 'production/api': { confirmed: 'up', alerted: false } }, {}, aperti)
  assert.deepEqual(dopo.chiudi.map((x) => x.ticket.identifier), ['PLA-9'])
})

test('testoTicket: titolo come la riga di Slack, corpo col link alla risorsa', () => {
  const t = makeT('it')
  const { title, description } = testoTicket('production/api', obs('api'), { publicUrl: 'https://dg.example.com', t })
  assert.equal(title, 'api [PROD] GIÙ · task')
  assert.match(description, /0\/2 task in esecuzione/)
  assert.match(description, /https:\/\/dg\.example\.com\/\?risorsa=production%2Fapi/)
})

test('giroTicket: apre e chiude con le dipendenze, e un errore non ferma gli altri', async () => {
  const cfg = linearConfig({ DADAGUARD_LINEAR_API_KEY: 'k', DADAGUARD_LINEAR_DESTINAZIONI: 'main=t', DADAGUARD_PUBLIC_URL: 'https://x' })
  const stato = {
    'production/a': { confirmed: 'down', alerted: true },
    'production/b': { confirmed: 'down', alerted: true },
    'production/c': { confirmed: 'up' },
  }
  const ora = { 'production/a': obs('a'), 'production/b': obs('b'), 'production/c': obs('c') }
  const aperte = []
  const esito = await giroTicket(cfg, stato, ora, {
    deps: {
      ticketAperti: async () => ({ 'production/c': { id: 'c', identifier: 'PLA-3', teamId: 't' } }),
      apriTicket: async (_cfg, voce) => {
        if (voce.key === 'production/a') throw new Error('boom')
        aperte.push(voce.key)
        return { identifier: 'PLA-4' }
      },
      chiudiTicket: async () => {},
    },
  })
  assert.deepEqual(aperte, ['production/b'])
  assert.deepEqual(esito, { aperti: ['PLA-4'], chiusi: ['PLA-3'], falliti: 1 })
})

test('giroTicket: spento senza config, e non chiama nessuno', async () => {
  let chiamato = false
  const esito = await giroTicket(linearConfig({}), {}, {}, { deps: { ticketAperti: async () => ((chiamato = true), {}) } })
  assert.deepEqual(esito, { spento: true })
  assert.equal(chiamato, false)
})

test('runOnce: i ticket vedono il rosso appena annunciato su Slack', async () => {
  const svc = (overall) => ({ name: 'api', account: { key: 'production', label: 'production' }, overall, cause: 'runtime', checks: { runtime: { summary: 'giù' } } })
  let stato = null
  let visto = null
  const deps = {
    getStatus: async () => ({ services: [svc(giro)] }),
    publishStatus: () => {},
    postSlack: async () => true,
    loadState: async () => stato,
    saveState: async (_f, s) => {
      stato = s
    },
    giroTicket: async (_cfg, servizi) => {
      visto = servizi
      return {}
    },
  }
  const cfg = { webhook: 'https://hook', confirmations: 1, stateFile: 'x', lang: 'it', repoData: [], linear: linearConfig({}) }
  let giro = 'up'
  await runOnce(cfg, deps)
  giro = 'down'
  await runOnce(cfg, deps)
  assert.equal(visto['production/api'].confirmed, 'down')
  assert.equal(visto['production/api'].alerted, true)
})
