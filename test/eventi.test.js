// Gli eventi della coda anticipano il giro del quadro: se sbagliano, una riga dice ⏳ o 🧪 per una cosa
// che non sta succedendo, oppure un messaggio di chiunque possa spingere su un ramo finisce sul canvas.
// Qui si inchiodano la forma dei tre tipi di messaggio, cosa si scarta, quando un evento vale ancora e
// il lettore della coda (che cancella tutto quello che legge).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ambienteDaNome, applicaEventi, ascoltaCoda, normalizza, nuoviEventi, regioneDaUrl, unisciTest, TTL_DEPLOY_MS } from '../server/notify/eventi.js'

const ORA = Date.parse('2026-10-08T10:20:00Z')
const ci = (extra = {}) => ({
  fonte: 'ci',
  evento: 'test_avviati',
  progetto: 'acme-staging-agentic-chat-deploy',
  repo: 'Acme/agentic-chat',
  commit: 'db445eb0123456789abcdef0123456789abcdef0',
  run: 'https://github.com/Acme/agentic-chat/actions/runs/123',
  quando: '2026-10-08T10:18:45Z',
  ...extra,
})
const cb = (stato, extra = {}) => ({
  source: 'aws.codebuild',
  'detail-type': 'CodeBuild Build State Change',
  time: '2026-10-08T10:25:00Z',
  detail: {
    'build-status': stato,
    'project-name': 'acme-staging-agentic-chat-deploy',
    'additional-information': {
      'build-number': 284,
      'build-start-time': 'Oct 8, 2026 10:25:00 AM',
      'source-version': 'db445eb0123456789abcdef0123456789abcdef0',
      logs: { 'deep-link': 'https://console.aws.amazon.com/cloudwatch/home?region=eu-central-1#logEvent:group=x' },
      phases: [{ 'phase-type': 'SUBMITTED', 'phase-status': 'SUCCEEDED' }, { 'phase-type': 'BUILD', 'phase-status': 'FAILED' }],
    },
    ...extra,
  },
})
const ecs = (eventName, time = '2026-10-08T10:30:00Z') => ({
  source: 'aws.ecs',
  'detail-type': 'ECS Deployment State Change',
  time,
  resources: ['arn:aws:ecs:eu-central-1:123456789012:service/acme-staging/acme-staging-agentic-chat'],
  detail: { eventName, reason: 'ECS deployment circuit breaker: tasks failed to start.' },
})

test('l’ambiente viene dal nome, come le righe: `<org>-<env>-<servizio>`', () => {
  assert.equal(ambienteDaNome('acme-production-backend-deploy'), 'produzione')
  assert.equal(ambienteDaNome('acme-staging-backend'), 'staging')
  assert.equal(ambienteDaNome('staging-backend'), 'staging')
  assert.equal(ambienteDaNome('acme-management-dadaguard'), null, 'un conto senza quadro non ha ambiente')
  assert.equal(regioneDaUrl('https://sqs.eu-central-1.amazonaws.com/123456789012/dadaguard-eventi'), 'eu-central-1')
})

test('un messaggio della CI: servizio dal progetto, repository in minuscolo, run e commit solo se hanno la forma giusta', () => {
  const ev = normalizza(JSON.stringify(ci()))
  assert.deepEqual(ev, {
    tipo: 'test',
    fonte: 'ci',
    ambiente: 'staging',
    servizio: 'agentic-chat',
    repo: 'acme/agentic-chat',
    stato: 'in_corso',
    da: '2026-10-08T10:18:45.000Z',
    sha: 'db445eb0123456789abcdef0123456789abcdef0',
    url: 'https://github.com/Acme/agentic-chat/actions/runs/123',
  })
  assert.equal(normalizza(ci({ evento: 'test_falliti' })).stato, 'fallito')
  const sporco = normalizza(ci({ run: 'https://evil.example.com/x', commit: '<!channel>' }))
  assert.equal(sporco.url, null, 'un link che non è un run di GitHub non entra')
  assert.equal(sporco.sha, null)
})

test('un messaggio della CI che non ha la forma si scarta intero', () => {
  assert.equal(normalizza('non json'), null)
  assert.equal(normalizza(ci({ evento: 'deploy_ok' })), null, 'la CI dice solo dei test')
  assert.equal(normalizza(ci({ progetto: 'acme-staging-iac-apply' })), null, 'solo progetti di deploy')
  assert.equal(normalizza(ci({ progetto: 'acme-dev-x-deploy' })), null, 'un ambiente senza quadro')
  assert.equal(normalizza(ci({ repo: 'non un repo' })), null)
  assert.equal(normalizza(ci({ quando: 'ieri' })), null)
  assert.equal(normalizza({ source: 'aws.codebuild', 'detail-type': 'altro' }), null)
})

test('un evento di CodeBuild: stato, numero, commit, fase rotta e log; l’ora è quella dell’evento', () => {
  const ev = normalizza(cb('FAILED'))
  assert.equal(ev.tipo, 'deploy')
  assert.equal(ev.servizio, 'agentic-chat')
  assert.equal(ev.stato, 'fallito')
  assert.equal(ev.numero, 284)
  assert.equal(ev.fase, 'BUILD')
  assert.equal(ev.da, '2026-10-08T10:25:00.000Z')
  assert.match(ev.log, /^https:\/\/console\.aws\.amazon\.com\//)
  assert.equal(normalizza(cb('IN_PROGRESS')).stato, 'in_corso')
  assert.equal(normalizza(cb('SUCCEEDED')).fase, null, 'una build riuscita non ha fase rotta')
  assert.equal(normalizza(cb('STOPPED')).stato, 'fallito')
})

test('un evento di ECS: il servizio dall’ARN, il motivo solo se fallito', () => {
  const ev = normalizza(ecs('SERVICE_DEPLOYMENT_FAILED'))
  assert.equal(ev.servizio, 'agentic-chat')
  assert.equal(ev.ambiente, 'staging')
  assert.equal(ev.stato, 'fallito')
  assert.match(ev.motivo, /circuit breaker/)
  assert.equal(normalizza(ecs('SERVICE_DEPLOYMENT_IN_PROGRESS')).motivo, null)
  assert.equal(normalizza(ecs('SERVICE_TASK_PLACEMENT_FAILURE')), null)
})

test('la memoria: tiene l’ultimo per riga, dice se è cambiato qualcosa e dimentica dopo il TTL', () => {
  const e = nuoviEventi()
  assert.equal(e.registra(normalizza(cb('IN_PROGRESS')), ORA), true)
  assert.equal(e.registra(normalizza(cb('IN_PROGRESS')), ORA), false, 'un doppione non cambia niente')
  assert.equal(e.registra(normalizza(ecs('SERVICE_DEPLOYMENT_COMPLETED', '2026-10-08T10:20:00Z')), ORA), false, 'più vecchio dell’ultimo')
  assert.equal(e.registra({ ...normalizza(cb('SUCCEEDED')), da: '2026-10-08T10:27:00.000Z' }, ORA), true)
  assert.equal(e.attivi(ORA).deploy.get('staging|agentic-chat').stato, 'ok')
  assert.equal(e.attivi(ORA + TTL_DEPLOY_MS + 1).deploy.size, 0)
})

const appFerma = (extra = {}) => ({
  servizio: 'agentic-chat',
  stato: 'ok',
  quando: '2026-10-07T21:55:00Z',
  tentativo: null,
  come: { tipo: 'ci', build: 283 },
  ...extra,
})
const conUno = (ev) => {
  const e = nuoviEventi()
  e.registra(normalizza(ev), ORA)
  return e.attivi(ORA).deploy
}

test('un deploy dalla coda cambia i dati della riga come se l’avesse visto il giro', () => {
  const q = { staging: { app: [appFerma()] } }
  applicaEventi(q, conUno(cb('IN_PROGRESS')))
  assert.equal(q.staging.app[0].stato, 'in_corso')
  assert.equal(q.staging.app[0].tentativo.numero, 284)

  const f = { staging: { app: [appFerma()] } }
  applicaEventi(f, conUno(cb('FAILED')))
  assert.equal(f.staging.app[0].stato, 'fallito')
  assert.equal(f.staging.app[0].tentativo.fase, 'BUILD')

  const r = { staging: { app: [appFerma()] } }
  applicaEventi(r, conUno(ecs('SERVICE_DEPLOYMENT_IN_PROGRESS')))
  assert.equal(r.staging.app[0].stato, 'in_corso')
  assert.equal(r.staging.app[0].tentativo, null, 'un rollout senza build si racconta come rollout')
})

test('un deploy dalla coda non vale più quando il giro sa la stessa cosa o una più nuova', () => {
  const giaVista = { staging: { app: [appFerma({ come: { tipo: 'ci', build: 284 }, quando: '2026-10-08T10:26:00Z' })] } }
  applicaEventi(giaVista, conUno(cb('IN_PROGRESS')))
  assert.equal(giaVista.staging.app[0].stato, 'ok', 'il giro ha già la build finita')

  const piuNuova = { staging: { app: [appFerma({ stato: 'in_corso', tentativo: { numero: 285, da: '2026-10-08T10:24:00Z' } })] } }
  applicaEventi(piuNuova, conUno(cb('FAILED')))
  assert.equal(piuNuova.staging.app[0].tentativo.numero, 285, 'il giro conosce già una build dopo')

  const inCorso = { staging: { app: [appFerma({ stato: 'in_corso', tentativo: { numero: 284, da: '2026-10-08T10:20:00Z' } })] } }
  applicaEventi(inCorso, conUno(cb('SUCCEEDED')))
  assert.equal(inCorso.staging.app[0].stato, 'ok', 'il giro la vede ancora in corso, l’evento sa che è finita')

  const giu = { staging: { app: [appFerma({ stato: 'giu' })] } }
  applicaEventi(giu, conUno(cb('IN_PROGRESS')))
  assert.equal(giu.staging.app[0].stato, 'giu', 'un servizio giù resta giù')
})

test('i test dalla CI con quelli di GitHub: la CI anticipa, GitHub corregge', () => {
  const e = nuoviEventi()
  e.registra(normalizza(ci()), ORA)
  const test = e.attivi(ORA).test
  const k = 'staging|acme/agentic-chat'

  assert.equal(unisciTest(new Map(), test, { lettoAlle: ORA }).get(k).stato, 'in_corso', 'GitHub letto adesso non vede ancora il run')
  assert.equal(unisciTest(new Map(), test, { lettoAlle: ORA + 5 * 60_000 }).has(k), false, 'letto ben dopo e niente: i test sono finiti verdi')
  assert.equal(unisciTest(null, test).get(k).stato, 'in_corso', 'senza GitHub vale l’evento')

  const vecchio = new Map([[k, { stato: 'fallito', da: '2026-10-07T21:00:00Z', sha: '922ea44' }]])
  assert.equal(unisciTest(vecchio, test, { lettoAlle: ORA }).get(k).stato, 'in_corso', 'un rosso di un commit di ieri non vince sul push di oggi')

  const stesso = new Map([[k, { stato: 'fallito', da: '2026-10-08T10:18:41Z', sha: 'db445eb0123456789abcdef0123456789abcdef0' }]])
  assert.equal(unisciTest(stesso, test, { lettoAlle: ORA }).get(k).stato, 'fallito', 'sullo stesso commit GitHub sa di più')

  const rossi = nuoviEventi()
  rossi.registra(normalizza(ci({ evento: 'test_falliti', quando: '2026-10-08T10:22:00Z' })), ORA)
  const ancoraInCorso = new Map([[k, { stato: 'in_corso', da: '2026-10-08T10:18:41Z', sha: 'db445eb' }]])
  assert.equal(unisciTest(ancoraInCorso, rossi.attivi(ORA).test, { lettoAlle: ORA }).get(k).stato, 'fallito', 'i check rossi vincono su un altro workflow ancora in corso')
})

test('il lettore della coda registra, cancella tutto quello che ha letto e avvisa solo se è cambiato qualcosa', async () => {
  const chiamate = []
  const msgs = [
    { Body: JSON.stringify(ci()), ReceiptHandle: 'r1' },
    { Body: 'spazzatura', ReceiptHandle: 'r2' },
  ]
  const client = {
    send: async (cmd) => {
      chiamate.push(cmd.constructor.name)
      if (cmd.constructor.name === 'ReceiveMessageCommand') return { Messages: msgs }
      assert.deepEqual(cmd.input.Entries.map((x) => x.ReceiptHandle), ['r1', 'r2'], 'anche quello che non si capisce: tornerebbe per sempre')
      return {}
    },
  }
  const eventi = nuoviEventi()
  let avvisi = 0
  ascoltaCoda('https://sqs.eu-central-1.amazonaws.com/1/coda', eventi, () => avvisi++, { client, unGiro: true })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(chiamate, ['ReceiveMessageCommand', 'DeleteMessageBatchCommand'])
  assert.equal(avvisi, 1)
  assert.equal(eventi.attivi().test.size, 1)
})
