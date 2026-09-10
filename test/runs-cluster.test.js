import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'

// Perche' esistono queste prove. La pagina Esecuzioni faceva `ListTasks` PER CRON, filtrate per
// famiglia: con quaranta cron sullo stesso cluster erano ottanta chiamate dove ne bastano due, ed era
// il grosso della sua lentezza. Leggere il cluster una volta sola e smistare per famiglia in memoria
// e' la correzione, e sbaglia in un modo che non fa rumore: un cron che mostra le run di un ALTRO.
// Una lista di esecuzioni attribuita al cron sbagliato non sembra un guasto, sembra un cron che ha
// girato quando non ha girato.

const ARN = (famiglia) => `arn:aws:ecs:eu-central-1:1:task-definition/${famiglia}:7`

async function conCluster(taskPerStato) {
  const chiamate = { list: 0, describe: 0, taskdef: 0 }
  const modulo = await import('../server/runs.js?' + Math.random())
  const sdk = await import('@aws-sdk/client-ecs')
  mock.method(sdk.ECSClient.prototype, 'send', async (cmd) => {
    const nome = cmd?.constructor?.name
    if (nome === 'DescribeTaskDefinitionCommand') {
      chiamate.taskdef += 1
      // Una task-def senza `awslogs`: cosi' la prova resta sulle chiamate ECS e non tocca i log.
      return { taskDefinition: { containerDefinitions: [{ name: 'app' }] } }
    }
    if (nome === 'ListTasksCommand') {
      chiamate.list += 1
      const stato = cmd.input.desiredStatus
      // ⚠️ Senza `family` nella richiesta: e' il punto del cambio. Se qualcuno la rimettesse, questa
      // prova continuerebbe a passare, quindi c'e' un'asserzione apposta piu' sotto.
      return { taskArns: (taskPerStato[stato] ?? []).map((t) => t.taskArn) }
    }
    if (nome === 'DescribeTasksCommand') {
      chiamate.describe += 1
      const tutti = [...(taskPerStato.RUNNING ?? []), ...(taskPerStato.STOPPED ?? [])]
      return { tasks: tutti.filter((t) => cmd.input.tasks.includes(t.taskArn)) }
    }
    return {}
  })
  return { modulo, chiamate, sdk }
}

// ⚠️ Date RECENTI, non fisse nel passato: le run fuori dalla finestra vengono scartate a valle, e
// con un timestamp del 2023 la prova falliva dicendo «beta non vede la sua run» mentre il
// raggruppamento funzionava benissimo. Una prova che fallisce per il motivo sbagliato costa piu' di
// una che non c'e'.
const ORA = Date.now()
const task = (famiglia, id, stato = 'RUNNING') => ({
  taskArn: `arn:aws:ecs:eu-central-1:1:task/cl/${id}`,
  taskDefinitionArn: ARN(famiglia),
  lastStatus: stato,
  desiredStatus: stato,
  startedAt: new Date(ORA - 5 * 60_000),
  stoppedAt: stato === 'STOPPED' ? new Date(ORA - 4 * 60_000) : undefined,
  containers: [{ name: 'app', exitCode: stato === 'STOPPED' ? 0 : undefined }],
})

// ⚠️ Un cluster DIVERSO per ogni prova. `cached` vive nel suo modulo, che l'import dinamico di
// `runs.js` non ricrea: senza un nome nuovo, la seconda prova leggerebbe la risposta della prima e
// i contatori resterebbero a zero, cioe' passerebbe senza provare niente.
let contatoreCluster = 0
const nuovoCluster = () => `cl-${++contatoreCluster}`

test('cluster: ogni cron vede SOLO i task della sua famiglia', async () => {
  const { modulo } = await conCluster({
    RUNNING: [task('cron-alfa', 'a1')],
    STOPPED: [task('cron-beta', 'b1', 'STOPPED')],
  })
  const cluster = nuovoCluster()
  const alfa = await modulo.ecsRuns({ cluster, taskDefinition: 'cron-alfa:7', container: 'app' }, {}, {})
  const beta = await modulo.ecsRuns({ cluster, taskDefinition: 'cron-beta:7', container: 'app' }, {}, {})
  assert.equal(alfa.runs.length, 1, 'alfa deve vedere la sua run')
  assert.equal(beta.runs.length, 1, 'beta deve vedere la sua run')
  // ⚠️ La cosa che conta: nessuno dei due vede la run dell'altro.
  assert.ok(!alfa.runs.some((r) => r.id === 'b1'), 'alfa non deve vedere la run di beta')
  assert.ok(!beta.runs.some((r) => r.id === 'a1'), 'beta non deve vedere la run di alfa')
})

test('cluster: due cron sullo stesso cluster fanno DUE ListTasks in tutto, non due a testa', async () => {
  const { modulo, chiamate } = await conCluster({ RUNNING: [task('cron-alfa', 'a1')], STOPPED: [] })
  const cluster = nuovoCluster()
  await modulo.ecsRuns({ cluster, taskDefinition: 'cron-alfa:7', container: 'app' }, {}, {})
  await modulo.ecsRuns({ cluster, taskDefinition: 'cron-beta:7', container: 'app' }, {}, {})
  // Due stati (RUNNING e STOPPED), una pagina ciascuno, per UN cluster: due chiamate in tutto.
  assert.equal(chiamate.list, 2, `attese 2 ListTasks, fatte ${chiamate.list}`)
})

test('cluster: la lettura e condivisa anche fra chiamate CONCORRENTI', async () => {
  // E' il caso vero: la pagina lancia i cron in parallelo, e senza la promessa condivisa quaranta
  // cron farebbero quaranta letture identiche prima che la prima finisca.
  const { modulo, chiamate } = await conCluster({ RUNNING: [task('cron-alfa', 'a1')], STOPPED: [] })
  const cluster = nuovoCluster()
  await Promise.all(
    ['cron-alfa:7', 'cron-beta:7', 'cron-gamma:7'].map((td) =>
      modulo.ecsRuns({ cluster, taskDefinition: td, container: 'app' }, {}, {}),
    ),
  )
  assert.equal(chiamate.list, 2, `attese 2 ListTasks in parallelo, fatte ${chiamate.list}`)
})

test('cluster: cluster diversi non si mescolano', async () => {
  const { modulo, chiamate } = await conCluster({ RUNNING: [task('cron-alfa', 'a1')], STOPPED: [] })
  await modulo.ecsRuns({ cluster: nuovoCluster(), taskDefinition: 'cron-alfa:7', container: 'app' }, {}, {})
  await modulo.ecsRuns({ cluster: nuovoCluster(), taskDefinition: 'cron-alfa:7', container: 'app' }, {}, {})
  assert.equal(chiamate.list, 4, 'due cluster = due letture, non una riusata per sbaglio')
})

test('cluster: la task definition si legge una volta sola per cron, non una per chiamata', async () => {
  const { modulo, chiamate } = await conCluster({ RUNNING: [], STOPPED: [] })
  // ⚠️ Anche il NOME della task-def dev'essere nuovo: la sua cache dura un'ora ed e' nello stesso
  // modulo, quindi con `cron-alfa` una prova precedente l'avrebbe gia' scaldata e il contatore
  // resterebbe a zero. Stessa ragione del cluster nuovo, su una cache diversa.
  const cluster = nuovoCluster()
  const td = `cron-solo-qui-${Date.now()}:7`
  await modulo.ecsRuns({ cluster, taskDefinition: td, container: 'app' }, {}, {})
  await modulo.ecsRuns({ cluster, taskDefinition: td, container: 'app' }, {}, {})
  assert.equal(chiamate.taskdef, 1, 'una revisione di task-def e immutabile: si rilegge una volta sola')
})
