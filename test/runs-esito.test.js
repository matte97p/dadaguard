import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'

// Perche' esiste questa prova. La lista delle corse di un cron ECS legge il codice d'uscita dall'API
// finche' il task c'e', cioe' per circa un'ora; dopo resta il log. Un container ucciso per memoria
// finita nel log non scrive errori, quindi qui tornava verde mentre la home, che legge l'esito
// registrato sulla metrica di successo, lo diceva rosso. Due pagine che dicono il contrario sulla
// stessa corsa sono peggio di una sola che sbaglia.

const ORA = Date.now()
const MIN = 60_000

test('corse dimenticate dall’API: l’esito registrato vince sul log, e quella corsa il log non si legge', async () => {
  const modulo = await import('../server/runs.js?' + Math.random())
  const ecs = await import('@aws-sdk/client-ecs')
  const logs = await import('@aws-sdk/client-cloudwatch-logs')
  const cw = await import('@aws-sdk/client-cloudwatch')
  const letti = []

  mock.method(ecs.ECSClient.prototype, 'send', async (cmd) => {
    const nome = cmd?.constructor?.name
    if (nome === 'DescribeTaskDefinitionCommand') {
      return {
        taskDefinition: {
          containerDefinitions: [{ name: 'app', logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/acme-weekly', 'awslogs-stream-prefix': 'cron' } } }],
        },
      }
    }
    // L'API ha gia' dimenticato tutte e due le corse.
    if (nome === 'ListTasksCommand') return { taskArns: [] }
    return { tasks: [] }
  })
  mock.method(logs.CloudWatchLogsClient.prototype, 'send', async (cmd) => {
    const nome = cmd?.constructor?.name
    if (nome === 'DescribeLogStreamsCommand') {
      return {
        logStreams: [
          { logStreamName: 'cron/app/recente', firstEventTimestamp: ORA - 3 * 60 * MIN, lastEventTimestamp: ORA - 3 * 60 * MIN + MIN },
          { logStreamName: 'cron/app/vecchia', firstEventTimestamp: ORA - 10 * 60 * MIN, lastEventTimestamp: ORA - 10 * 60 * MIN + MIN },
        ],
      }
    }
    if (nome === 'FilterLogEventsCommand') {
      letti.push(cmd.input.logStreamNames[0])
      return { events: [] }
    }
    return {}
  })
  mock.method(cw.CloudWatchClient.prototype, 'send', async (cmd) => {
    if (cmd?.constructor?.name === 'DescribeAlarmsCommand') {
      return {
        MetricAlarms: [
          { AlarmName: 'acme-cron-weekly-run-failed', Namespace: 'Acme/Jobs', MetricName: 'Done', Dimensions: [{ Name: 'Job', Value: 'weekly' }], Statistic: 'Minimum', Period: 3600, EvaluationPeriods: 1, ComparisonOperator: 'LessThanThreshold', Threshold: 1, TreatMissingData: 'notBreaching' },
        ],
      }
    }
    // Il punto a zero della corsa recente, due minuti dopo la sua partenza.
    return { MetricDataResults: [{ Id: 'f0', Timestamps: [new Date(ORA - 3 * 60 * MIN + 2 * MIN)], Values: [0] }] }
  })

  try {
    const cron = { cluster: 'cl-esito', taskDefinition: 'acme-weekly:3', container: 'app', key: 'prod/acme-cron-weekly', name: 'acme-cron-weekly', scheduleMinutes: 10080 }
    const out = await modulo.ecsRuns(cron, { profile: 'prova-corse-esito' }, { minutes: 24 * 60 })
    const per = Object.fromEntries(out.runs.map((r) => [r.stream, r]))
    assert.equal(per['cron/app/recente'].outcome, 'failed', 'il punto a zero dice fallita, anche senza errori nel log')
    assert.equal(per['cron/app/recente'].failedScanned, true, 'e’ una risposta, non una mancanza')
    assert.equal(per['cron/app/vecchia'].outcome, 'ok', 'senza punti resta il log, pulito')
    assert.deepEqual(letti, ['cron/app/vecchia'], 'il log si legge solo per la corsa senza esito registrato')
  } finally {
    mock.restoreAll()
  }
})
