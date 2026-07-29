import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestByTask, pctOf, shortTaskId } from '../server/taskMetrics.js'
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
