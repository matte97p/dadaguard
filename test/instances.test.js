import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestByTask, pctOf, shortTaskId, taskIdOfArn, pullMs, stopKind, mergeTargetHealth, familyOfTaskDef } from '../server/taskMetrics.js'
import { ecsStreamName } from '../server/logs.js'
import { prettyBedrock, isNonEuInference } from '../web/serviceName.js'
import { taskOfStream, instanceOptions } from '../web/format.js'

// Le metriche di servizio sono medie sulla flotta, e una media su tre replica nasconde il caso che si
// va a cercare: un task che macina CPU mentre gli altri stanno bene. Qui si fissa che il per-task
// resti per-task, e che i dati mancanti non diventino zeri.

const rec = (TaskId, Timestamp, over = {}) => ({
  Type: 'Task',
  TaskId,
  Timestamp,
  ServiceName: 'backend',
  CpuUtilized: 128,
  CpuReserved: 512,
  MemoryUtilized: 256,
  MemoryReserved: 1024,
  AvailabilityZone: 'eu-central-1a',
  TaskDefinitionRevision: 57,
  KnownStatus: 'RUNNING',
  ...over,
})

test('pctOf: quanto è pieno il riservato', () => {
  assert.equal(pctOf(128, 512), 25)
  assert.equal(pctOf(0, 512), 0)
})

test('pctOf: dato mancante → null, MAI 0%', () => {
  // 0% su un dato che non c'è è un numero inventato: dice "sta a riposo" dove il vero significato è
  // "non lo so", e su un pannello di diagnosi manda a cercare nel posto sbagliato.
  assert.equal(pctOf(128, 0), null)
  assert.equal(pctOf(undefined, 512), null)
  assert.equal(pctOf(128, undefined), null)
  assert.equal(pctOf('x', 512), null)
})

test('latestByTask: un task per riga, col record più recente', () => {
  const tasks = latestByTask([
    rec('aaaa1111bbbb2222cccc3333dddd4444', 1000, { CpuUtilized: 51.2 }),
    rec('aaaa1111bbbb2222cccc3333dddd4444', 2000, { CpuUtilized: 256 }), // più recente
    rec('eeee5555ffff6666aaaa7777bbbb8888', 1500, { CpuUtilized: 25.6 }),
  ])
  assert.equal(tasks.length, 2)
  const first = tasks.find((x) => x.shortId === 'aaaa1111')
  assert.equal(first.cpuPct, 50) // 256/512, cioè il record delle 2000
})

test('latestByTask: il task che consuma più CPU sta in cima', () => {
  const tasks = latestByTask([
    rec('1111', 1000, { CpuUtilized: 51.2 }), // 10%
    rec('2222', 1000, { CpuUtilized: 384 }), // 75% ← il sospetto
    rec('3333', 1000, { CpuUtilized: 102.4 }), // 20%
  ])
  assert.deepEqual(
    tasks.map((x) => x.cpuPct),
    [75, 20, 10],
  )
})

test('latestByTask: record senza TaskId scartati (non è un task)', () => {
  const tasks = latestByTask([{ Type: 'Service', ServiceName: 'backend', Timestamp: 1000 }, rec('1111', 1000)])
  assert.equal(tasks.length, 1)
})

test('shortTaskId: 8 caratteri, quanto basta a distinguere le replica', () => {
  assert.equal(shortTaskId('68228e26661b4de1b7129e4beb6e44d8'), '68228e26')
  assert.equal(shortTaskId(null), '')
})

// Il filtro per istanza deve essere un nome di stream ESATTO: FilterLogEvents non fa match per suffisso,
// e `logs:DescribeLogStreams` non è tra i permessi del ruolo read-only. Si compone dalla task-def.
test('ecsStreamName: prefisso/container/taskId', () => {
  assert.equal(
    ecsStreamName({ streamPrefix: 'agentic-chat', container: 'agentic-chat' }, 'fe93a59259f14ffc83d9d63574f6fae7'),
    'agentic-chat/agentic-chat/fe93a59259f14ffc83d9d63574f6fae7',
  )
})

test('ecsStreamName: pezzo mancante → null, così si legge il servizio intero', () => {
  // Meglio tutte le righe che una lista vuota senza spiegazione: la risposta dice se il filtro ha preso.
  assert.equal(ecsStreamName({ streamPrefix: null, container: 'x' }, 'abc'), null)
  assert.equal(ecsStreamName({ streamPrefix: 'p', container: null }, 'abc'), null)
  assert.equal(ecsStreamName({ streamPrefix: 'p', container: 'c' }, null), null)
})

test('taskOfStream: dal nome dello stream al task', () => {
  assert.equal(taskOfStream('agentic-chat/agentic-chat/fe93a592'), 'fe93a592')
  assert.equal(taskOfStream(''), null)
})

// Il prefisso di un ID Bedrock non è cosmetica: dice DOVE gira l'inferenza. `global` non era
// riconosciuto, quindi `global.anthropic.claude-opus-5` non produceva etichetta e in tabella era
// indistinguibile dal gemello `eu.` dello stesso ambiente — due righe identiche per due modelli diversi.
test('prettyBedrock: riconosce global, non solo le regioni', () => {
  assert.equal(prettyBedrock('eu.anthropic.claude-opus-5').scope, 'eu')
  assert.equal(prettyBedrock('global.anthropic.claude-opus-5').scope, 'global')
  assert.equal(prettyBedrock('us.anthropic.claude-opus-5').scope, 'us')
})

test('prettyBedrock: due profili dello stesso modello si distinguono', () => {
  const eu = prettyBedrock('eu.anthropic.claude-opus-5')
  const global = prettyBedrock('global.anthropic.claude-opus-5')
  assert.equal(eu.name, global.name) // il nome leggibile è lo stesso…
  assert.notEqual(eu.scope, global.scope) // …il profilo no, ed è quello che serve vedere
})

test('isNonEuInference: solo eu.* è in area', () => {
  const bedrock = (name) => ({ type: 'bedrock', name })
  assert.equal(isNonEuInference(bedrock('eu.anthropic.claude-opus-5')), false)
  assert.equal(isNonEuInference(bedrock('global.anthropic.claude-opus-5')), true)
  assert.equal(isNonEuInference(bedrock('us.anthropic.claude-opus-5')), true)
})

test('isNonEuInference: prefisso ignoto NON è "fuori area"', () => {
  // Un ID che non combacia con nessun profilo noto è ignoto, e segnarlo come violazione sarebbe
  // inventare un allarme. Vale anche per i servizi che non sono modelli Bedrock.
  assert.equal(isNonEuInference({ type: 'bedrock', name: 'anthropic.claude-opus-5' }), false)
  assert.equal(isNonEuInference({ type: 'ecs', name: 'backend' }), false)
  assert.equal(isNonEuInference(null), false)
})

// Il selettore di istanza nel pannello log. Sembrano dettagli e sono i due modi in cui un filtro si
// trasforma in un vicolo cieco: nascosto il ritorno a «Tutte», o mostrato vuoto mentre filtra.
test('instanceOptions: «Tutte» c’è sempre, ed è la prima', () => {
  const o = instanceOptions([], null, 'Tutte', (s) => s)
  assert.deepEqual(o, [{ value: '', label: 'Tutte' }])
})

test('instanceOptions: l’istanza attiva è tra le opzioni anche se non è ancora comparsa', () => {
  // Un Select col valore fuori dalle opzioni mostra la casella vuota: leggerebbe "nessun filtro"
  // mentre il filtro è attivo, che è la bugia peggiore su un pannello di diagnosi.
  const o = instanceOptions(['aaaa1111'], 'bbbb2222', 'Tutte', (s) => s)
  assert.deepEqual(o.map((x) => x.value), ['', 'aaaa1111', 'bbbb2222'])
})

test('instanceOptions: nessun duplicato se l’attiva è già nota', () => {
  const o = instanceOptions(['aaaa1111', 'bbbb2222'], 'aaaa1111', 'Tutte', (s) => s)
  assert.deepEqual(o.map((x) => x.value), ['', 'aaaa1111', 'bbbb2222'])
})

test('instanceOptions: le etichette passano dall’accorciatore', () => {
  const o = instanceOptions(['68228e26661b4de1b7129e4beb6e44d8'], null, 'Tutte', (s) => s.slice(0, 8))
  assert.equal(o[1].label, '68228e26')
  assert.equal(o[1].value, '68228e26661b4de1b7129e4beb6e44d8') // il valore resta l'id intero
})

// I tre segnali che rendono il per-istanza azionabile invece che solo descrittivo.

test('taskIdOfArn: l’id dalla coda dell’ARN', () => {
  assert.equal(
    taskIdOfArn('arn:aws:ecs:eu-central-1:521595303218:task/cato-staging/68228e26661b4de1b7129e4beb6e44d8'),
    '68228e26661b4de1b7129e4beb6e44d8',
  )
  assert.equal(taskIdOfArn(null), null)
})

test('pullMs: durata del pull immagine, null se i timestamp non tornano', () => {
  assert.equal(pullMs({ PullStartedAt: 1000, PullStoppedAt: 4200 }), 3200)
  assert.equal(pullMs({ PullStartedAt: 4200, PullStoppedAt: 1000 }), null) // incoerenti
  assert.equal(pullMs({ PullStartedAt: 1000 }), null)
  assert.equal(pullMs({}), null)
})

test('stopKind: OOM riconosciuto sul container, non solo sul task', () => {
  // ECS mette il motivo a volte sul task e a volte sul container: cercarlo in un posto solo significa
  // classificare un OOM come "fermato", e mandare a cercare un bug applicativo dove serve più memoria.
  assert.equal(
    stopKind({ stoppedReason: 'Essential container in task exited', containerReasons: ['OutOfMemoryError: Container killed due to memory usage'] }),
    'oom',
  )
  assert.equal(stopKind({ stoppedReason: 'OutOfMemory: container exceeded memory usage', containerReasons: [] }), 'oom')
})

test('stopKind: distingue health-check, sostituzione e stop a mano', () => {
  assert.equal(stopKind({ stoppedReason: 'Task failed ELB health checks in target-group tg-x' }), 'health')
  assert.equal(stopKind({ stoppedReason: 'Scaling activity initiated by deployment', stopCode: 'ServiceSchedulerInitiated' }), 'scheduler')
  assert.equal(stopKind({ stoppedReason: 'Stopped by user', stopCode: 'UserInitiated' }), 'user')
})

test('stopKind: nessun motivo → null, non "other"', () => {
  // "other" su un task senza motivo affermerebbe che qualcosa è andato storto: non lo sappiamo.
  assert.equal(stopKind({}), null)
  assert.equal(stopKind({ containerReasons: [] }), null)
})

test('mergeTargetHealth: lo stato del LB si attacca al task giusto per IP', () => {
  const tasks = [
    { taskId: 'a', privateIp: '10.0.1.5' },
    { taskId: 'b', privateIp: '10.0.2.9' },
  ]
  const merged = mergeTargetHealth(tasks, {
    '10.0.1.5': { state: 'unhealthy', reason: 'Target.ResponseCodeMismatch' },
    '10.0.2.9': { state: 'healthy', reason: null },
  })
  assert.equal(merged.find((x) => x.taskId === 'a').target.state, 'unhealthy')
  assert.equal(merged.find((x) => x.taskId === 'b').target.state, 'healthy')
})

test('mergeTargetHealth: senza load balancer i task restano intatti', () => {
  // `null` = non si applica (nessun LB) o permesso assente. In entrambi i casi non si inventa uno stato.
  const tasks = [{ taskId: 'a', privateIp: '10.0.1.5' }]
  assert.deepEqual(mergeTargetHealth(tasks, null), tasks)
})

test('mergeTargetHealth: task senza IP o IP non nel target group → nessuno stato', () => {
  const merged = mergeTargetHealth([{ taskId: 'a', privateIp: null }, { taskId: 'b', privateIp: '10.9.9.9' }], {
    '10.0.1.5': { state: 'healthy' },
  })
  assert.equal(merged[0].target, undefined)
  assert.equal(merged[1].target, undefined)
})

test('latestByTask: storage effimero e pacchetti persi arrivano dai record già scaricati', () => {
  const [task] = latestByTask([
    rec('aaaa1111bbbb2222cccc3333dddd4444', 1000, {
      EphemeralStorageUtilized: 5.6,
      EphemeralStorageReserved: 22.4,
      NetworkRxDropped: 7,
      NetworkTxDropped: 5,
      NetworkRxErrors: 1,
      NetworkTxErrors: 0,
    }),
  ])
  assert.equal(task.diskPct, 25)
  assert.equal(task.netDropped, 12)
  assert.equal(task.netErrors, 1)
})

test('familyOfTaskDef: la famiglia senza la revision', () => {
  assert.equal(
    familyOfTaskDef('arn:aws:ecs:eu-central-1:521595303218:task-definition/cato-staging-agentic-chat:39'),
    'cato-staging-agentic-chat',
  )
  assert.equal(familyOfTaskDef(null), null)
})
