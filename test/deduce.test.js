import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchEnvTargets,
  matchByArn,
  extractArns,
  collectResourceArns,
  topologyNodeId,
  identifiers,
  envTokens,
  extractHosts,
  esterniDaHost,
} from '../server/topology/deduce.js'

const idList = [
  { name: 'webhook-stg', account: 'staging', ids: ['acme-staging-webhook'] },
  { name: 'webhook-prod', account: 'production', ids: ['acme-staging-webhook'] }, // stesso token, account diverso
  { name: 'db-prod', account: 'production', ids: ['reporting-prod-db.cluster-x.rds.amazonaws.com'] },
  { name: 'queue-stg', account: 'staging', ids: ['prod-queue'] },
]

test('collisione cross-account → resta solo lo stesso account', () => {
  const out = matchEnvTargets('WEBHOOK_FN=acme-staging-webhook', { name: 'dispatch', account: 'staging' }, idList)
  assert.deepEqual(out.map((t) => t.name), ['webhook-stg']) // NON webhook-prod
})

test('token unico cross-account → dipendenza vera mantenuta', () => {
  const env = 'DATABASE_URL=postgres://u:p@reporting-prod-db.cluster-x.rds.amazonaws.com:5432/db'
  const out = matchEnvTargets(env, { name: 'syncer', account: 'staging' }, idList)
  assert.deepEqual(out.map((t) => t.name), ['db-prod'])
})

test('niente substring: "prod-queue" dentro "prod-queue-events" non matcha', () => {
  const out = matchEnvTargets('Q=prod-queue-events', { name: 'x', account: 'staging' }, idList)
  assert.deepEqual(out, [])
})

test('non matcha se stesso (token posseduto solo dal self)', () => {
  const out = matchEnvTargets(
    'SELF=reporting-prod-db.cluster-x.rds.amazonaws.com',
    { name: 'db-prod', account: 'production' },
    idList,
  )
  assert.deepEqual(out, []) // il self è escluso e nessun altro possiede quel token
})

test('extractArns: pesca gli ARN da una definizione Step Functions', () => {
  const def = JSON.stringify({
    States: {
      Pay: { Resource: 'arn:aws:lambda:eu-west-1:111:function:acme-staging-webhook', Next: 'Q' },
      Q: { Resource: 'arn:aws:sqs:eu-west-1:111:prod-queue' },
    },
  })
  const arns = extractArns(def)
  assert.deepEqual(arns, [
    'arn:aws:lambda:eu-west-1:111:function:acme-staging-webhook',
    'arn:aws:sqs:eu-west-1:111:prod-queue',
  ])
  assert.deepEqual(extractArns(''), [])
  assert.deepEqual(extractArns(undefined), [])
})

test('matchByArn: risolve un ARN al servizio, preferendo lo stesso account', () => {
  // "acme-staging-webhook" esiste in staging e production: da uno step SFN staging vince lo staging.
  const arn = 'arn:aws:lambda:eu-west-1:111:function:acme-staging-webhook'
  // Ritorna il CANDIDATO, non il nome: serve la sua chiave per non fondere due omonimi in un nodo.
  assert.equal(matchByArn(arn, idList, { name: 'orchestrator', account: 'staging' })?.name, 'webhook-stg')
  // ARN che non punta a nulla di tracciato → null
  assert.equal(matchByArn('arn:aws:s3:::qualche-bucket', idList, { name: 'x', account: 'staging' }), null)
})

test('collectResourceArns: pesca gli ARN Resource dai soli statement Allow', () => {
  const doc = {
    Statement: [
      { Effect: 'Allow', Action: 'rds-db:connect', Resource: 'arn:aws:rds:eu-west-1:111:cluster:reporting-prod-db' },
      { Effect: 'Allow', Action: ['sqs:SendMessage'], Resource: ['arn:aws:sqs:eu-west-1:111:prod-queue', '*'] },
      { Effect: 'Deny', Action: '*', Resource: 'arn:aws:s3:::segreto' }, // Deny → ignorato
    ],
  }
  assert.deepEqual(collectResourceArns(doc), [
    'arn:aws:rds:eu-west-1:111:cluster:reporting-prod-db',
    'arn:aws:sqs:eu-west-1:111:prod-queue',
  ])
  assert.deepEqual(collectResourceArns({}), [])
  // statement singolo (oggetto, non array)
  assert.deepEqual(
    collectResourceArns({ Statement: { Effect: 'Allow', Resource: 'arn:aws:sns:eu-west-1:111:topic' } }),
    ['arn:aws:sns:eu-west-1:111:topic'],
  )
})

test('topologyNodeId: lo stesso nome in due account dà due nodi distinti', () => {
  assert.notEqual(topologyNodeId('backend', 'staging'), topologyNodeId('backend', 'production'))
  assert.equal(topologyNodeId('backend', 'production'), topologyNodeId('backend', 'production'))
})

test('topologyNodeId: account come oggetto o come stringa danno la STESSA chiave', () => {
  // Il server passa una stringa, il payload della UI un oggetto. Se le due forme divergessero, gli
  // archi (chiave lato server) non troverebbero i nodi (chiave lato UI) e il grafo resterebbe vuoto.
  assert.equal(topologyNodeId('backend', 'production'), topologyNodeId('backend', { key: 'production' }))
})

test('topologyNodeId: senza account non collassa su chiavi diverse per nomi diversi', () => {
  assert.notEqual(topologyNodeId('a', null), topologyNodeId('b', null))
  assert.equal(topologyNodeId('a', null), topologyNodeId('a', undefined))
})

// --- I due difetti che rendevano falso l'84% del grafo (misurato: 87 archi su 104) ---

test('il CLUSTER non è un identificativo del servizio: lo condividono tutti i membri', async () => {
  const membro = (name) => ({ name, account: 'prod', aws: { type: 'ecs', cluster: 'acme-production', service: name } })
  const ids = await identifiers(membro('backend'), {})
  // Il nome del cluster da solo NON deve essere un identificativo: se lo fosse, ogni valore che lo
  // nomina (una env var, un ARN in una policy) farebbe match con OGNI membro del cluster, e da una
  // menzione sola nascerebbero nove archi. È esattamente ciò che accadeva.
  assert.equal(ids.includes('acme-production'), false)
  // La coppia cluster/servizio invece resta: quella è specifica, e compare negli ARN veri.
  assert.equal(ids.includes('acme-production/backend'), true)
  assert.equal(ids.includes('backend'), true)
})

test('lo stesso vale per un task schedulato, dove il cluster arriva come ARN', async () => {
  const ids = await identifiers(
    { name: 'nightly', account: 'prod', aws: { type: 'ecs-scheduled', cluster: 'arn:aws:ecs:eu-central-1:1:cluster/acme-production', taskDefinition: 'arn:aws:ecs:eu-central-1:1:task-definition/acme-nightly:3' } },
    {},
  )
  // Né l'ARN del cluster né la sua coda: la coda è il NOME del cluster, cioè lo stesso identificativo
  // condiviso da un'altra porta.
  assert.equal(ids.some((i) => i.includes('cluster/acme-production')), false)
  assert.equal(ids.includes('acme-production'), false)
  assert.equal(ids.some((i) => i.includes('acme-nightly')), true, 'la task definition resta: quella è sua')
})

test('un ARN ambiguo non produce nessun arco, invece di produrne uno inventato', () => {
  const idList = [
    { name: 'agentic-chat', account: 'prod', key: 'prod::agentic-chat', ids: ['agentic-chat', 'acme-production'] },
    { name: 'backend', account: 'prod', key: 'prod::backend', ids: ['backend', 'acme-production'] },
  ]
  const self = { name: 'lambda-x', account: 'prod' }
  // Due candidati con lo stesso token: prima vinceva `[0]`, cioè il primo dell'elenco — e siccome
  // l'elenco è ordinato allo stesso modo per ogni ARN, TUTTI gli ambigui di un account finivano sullo
  // stesso servizio, che nel disegno diventava il centro dell'architettura per un artefatto di ordine.
  assert.equal(matchByArn('arn:aws:ecs:eu-central-1:1:cluster/acme-production', idList, self), null)
  // Un ARN che punta a UN solo candidato continua a funzionare.
  assert.equal(matchByArn('arn:aws:ecs:eu-central-1:1:service/backend', idList, self)?.name, 'backend')
})

test('l’account proprio resta preferito, ma solo se lì il candidato è UNO', () => {
  const idList = [
    { name: 'coda', account: 'prod', key: 'prod::coda', ids: ['coda-lavori'] },
    { name: 'coda', account: 'staging', key: 'staging::coda', ids: ['coda-lavori'] },
  ]
  // Due account, un candidato per account: vince il proprio, come prima.
  assert.equal(matchByArn('arn:aws:sqs:eu-central-1:1:coda-lavori', idList, { name: 'x', account: 'prod' })?.account, 'prod')
  // Nessuno dei due è nel proprio account e sono due: ambiguo → niente arco.
  assert.equal(matchByArn('arn:aws:sqs:eu-central-1:1:coda-lavori', idList, { name: 'x', account: 'security' }), null)
})


test('il PUNTO è un separatore: senza, nel grafo non compariva NESSUN data store', () => {
  // Il bug che teneva la mappa muta sulla metà destra dell'architettura: l'endpoint di un Redis o di un
  // database è un hostname, e finché era UN token non uguagliava mai il nome del servizio che lo serve.
  const env = 'REDIS_URL=rediss://master.acme-production-redis.a1b2c3.euc1.cache.amazonaws.com:6379'
  const tok = envTokens(env)
  assert.ok(tok.has('acme-production-redis'), 'il nome del servizio è una etichetta dell’hostname')
  // L'hostname INTERO resta un token: un endpoint RDS si riconosce anche per intero.
  assert.ok(tok.has('master.acme-production-redis.a1b2c3.euc1.cache.amazonaws.com'))
  // Un servizio elasticache citato solo così ora fa match.
  const lista = [{ name: 'acme-production-redis', account: 'prod', ids: ['acme-production-redis'] }]
  assert.deepEqual(
    matchEnvTargets(env, { name: 'backend', account: 'prod' }, lista).map((x) => x.name),
    ['acme-production-redis'],
  )
})

test('gli hostname si riconoscono per il DOMINIO finale, sennò un id di modello sembra un sito', () => {
  // `eu.anthropic.claude-opus-5` ha la forma di un hostname e non lo è: senza l'elenco dei domini di
  // primo livello, sulla mappa compariva un «sistema esterno» chiamato `anthropic.claude-opus-5`.
  assert.deepEqual(extractHosts('MODEL_ID=eu.anthropic.claude-opus-5'), [])
  assert.deepEqual(extractHosts('DB_URL=postgres://u:p@db.progetto.esempio.co/postgres'), ['db.progetto.esempio.co'])
  // Maiuscole e ripetizioni non generano due nodi per la stessa cosa.
  assert.deepEqual(extractHosts('A=https://API.Esempio.Com/v1 B=https://api.esempio.com/v2'), ['api.esempio.com'])
})

test('i sistemi esterni si raggruppano per dominio, e le risorse AWS non sono «esterne»', () => {
  const out = esterniDaHost([
    'db.progetto.esempio.co',
    'api.progetto.esempio.co',
    'eventi.altro-fornitore.io',
    // Un host AWS che non ha fatto match vuol dire «servizio che non stiamo guardando», non «di terzi»:
    // chiamarlo esterno sarebbe una bugia, e nel disegno un nodo che non esiste.
    'master.acme-production-redis.a1b2c3.euc1.cache.amazonaws.com',
    'kong.internal',
    'localhost',
  ])
  assert.deepEqual(
    out.map((x) => [x.id, x.hosts.length]),
    [
      ['ext:host:esempio.co', 2],
      ['ext:host:altro-fornitore.io', 1],
    ],
  )
  assert.equal(out[0].type, 'esterno')
})
