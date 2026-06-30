// Logica di discovery condivisa tra CLI (scripts/discover.js) ed endpoint (/api/discover).
// Read-only su AWS: lista le risorse di un account e le restituisce come candidati
// pronti per la watchlist. Se l'account ha un bucket di state Terraform, marca ogni
// candidato come gestito/non-gestito (#7). NON scrive niente.
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda'
import { ECSClient, ListClustersCommand, ListServicesCommand } from '@aws-sdk/client-ecs'
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling'
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from './runtime/awsClient.js'
import { managedResources } from './terraform/state.js'

async function listLambda(aws) {
  const client = new LambdaClient(clientOpts(aws))
  const names = []
  let Marker
  do {
    const out = await client.send(new ListFunctionsCommand({ Marker, MaxItems: 50 }))
    for (const f of out.Functions ?? []) names.push(f.FunctionName)
    Marker = out.NextMarker
  } while (Marker)
  return names.sort()
}

async function filterActiveLambda(aws, names, days) {
  if (!names.length) return names
  const cw = new CloudWatchClient(clientOpts(aws))
  const endTime = new Date()
  const startTime = new Date(endTime.getTime() - days * 86400 * 1000)
  const mkQuery = (n, i) => ({
    Id: `m${i}`, // l'indice è GLOBALE su `names` → riconducibile anche fra i batch
    MetricStat: {
      Metric: {
        Namespace: 'AWS/Lambda',
        MetricName: 'Invocations',
        Dimensions: [{ Name: 'FunctionName', Value: n }],
      },
      Period: 86400,
      Stat: 'Sum',
    },
    ReturnData: true,
  })
  const active = new Set()
  // GetMetricData ammette al massimo 500 query per chiamata → batch (con >500 lambda crasherebbe).
  const BATCH = 500
  for (let start = 0; start < names.length; start += BATCH) {
    const queries = names.slice(start, start + BATCH).map((n, j) => mkQuery(n, start + j))
    const res = await cw.send(
      new GetMetricDataCommand({ StartTime: startTime, EndTime: endTime, MetricDataQueries: queries }),
    )
    for (const r of res.MetricDataResults ?? []) {
      const sum = (r.Values ?? []).reduce((a, b) => a + b, 0)
      if (sum > 0) active.add(names[Number(r.Id.slice(1))])
    }
  }
  return names.filter((n) => active.has(n))
}

async function listEcs(aws) {
  const client = new ECSClient(clientOpts(aws))
  // paginazione: senza il loop su nextToken si perdono cluster/servizi oltre la prima pagina.
  const clusters = []
  let cTok
  do {
    const out = await client.send(new ListClustersCommand({ nextToken: cTok, maxResults: 100 }))
    clusters.push(...(out.clusterArns ?? []))
    cTok = out.nextToken
  } while (cTok)
  const out = []
  for (const c of clusters) {
    const clusterName = c.split('/').pop()
    let sTok
    do {
      const r = await client.send(new ListServicesCommand({ cluster: c, nextToken: sTok, maxResults: 100 }))
      for (const s of r.serviceArns ?? []) out.push({ cluster: clusterName, service: s.split('/').pop() })
      sTok = r.nextToken
    } while (sTok)
  }
  return out
}

async function listAsg(aws) {
  const client = new AutoScalingClient(clientOpts(aws))
  const groups = []
  let tok
  do {
    const out = await client.send(new DescribeAutoScalingGroupsCommand({ NextToken: tok, MaxRecords: 100 }))
    groups.push(...(out.AutoScalingGroups ?? []))
    tok = out.NextToken
  } while (tok)
  return groups.map((g) => g.AutoScalingGroupName).sort()
}

// Ritorna { candidates: [{ name, kind, aws, managed? }], activeInfo, tfState? }.
export async function discover({ profile, roleArn, externalId, region, activeDays = 30, exclude, all, stateBucket } = {}) {
  const aws = { profile, roleArn, externalId, region }
  const ex = exclude ? new RegExp(exclude) : null

  let [lambdas, ecs, asgs] = await Promise.all([
    listLambda(aws).catch(() => []),
    listEcs(aws).catch(() => []),
    listAsg(aws).catch(() => []),
  ])

  let activeInfo = null
  if (!all && lambdas.length) {
    const total = lambdas.length
    lambdas = await filterActiveLambda(aws, lambdas, activeDays).catch(() => lambdas)
    activeInfo = { kept: lambdas.length, total, days: activeDays }
  }

  if (ex) {
    lambdas = lambdas.filter((n) => !ex.test(n))
    ecs = ecs.filter((e) => !ex.test(e.service))
    asgs = asgs.filter((n) => !ex.test(n))
  }

  const candidates = [
    ...lambdas.map((n) => ({
      name: n,
      kind: 'lambda',
      aws: { type: 'lambda', function: n, windowMinutes: 60 },
    })),
    ...ecs.map((e) => ({
      name: e.service,
      kind: 'ecs',
      aws: { type: 'ecs', cluster: e.cluster, service: e.service },
    })),
    ...asgs.map((n) => ({ name: n, kind: 'asg', aws: { type: 'asg', asg: n } })),
  ]

  // #7: confronto con lo state Terraform → managed true/false per candidato.
  let tfState = null
  if (stateBucket) {
    try {
      const { managed, stateCount } = await managedResources({ profile, roleArn, externalId, region, stateBucket })
      for (const c of candidates) c.managed = managed[c.kind]?.has(c.name) ?? false
      tfState = { stateCount, unmanaged: candidates.filter((c) => !c.managed).length }
    } catch (err) {
      tfState = { error: err.message }
    }
  }

  return { candidates, activeInfo, tfState }
}
