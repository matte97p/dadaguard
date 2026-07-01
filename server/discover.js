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
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch'
import { clientOpts } from './runtime/awsClient.js'
import { managedResources } from './terraform/state.js'
import { scheduleForLambdas, minutesToSchedule } from './schedules.js'

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

// Modelli Bedrock EFFETTIVAMENTE invocati: dai metric di CloudWatch (AWS/Bedrock) leggo i ModelId
// che hanno una metrica Invocations. Non è il catalogo (centinaia di foundation model), ma solo
// ciò che l'account ha davvero usato di recente → candidati sensati. Permesso: cloudwatch:ListMetrics.
async function listBedrockModels(aws) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const models = new Set()
  let token
  do {
    const out = await cw.send(
      new ListMetricsCommand({ Namespace: 'AWS/Bedrock', MetricName: 'Invocations', NextToken: token }),
    )
    for (const m of out.Metrics ?? []) {
      const dim = (m.Dimensions ?? []).find((d) => d.Name === 'ModelId')
      if (dim?.Value) models.add(dim.Value)
    }
    token = out.NextToken
  } while (token)
  return [...models].sort()
}

// Valori distinti di una dimension da ListMetrics (es. EndpointName per SageMaker). Best-effort.
async function listMetricDimension(aws, namespace, metricName, dimName) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const vals = new Set()
  let token
  do {
    const r = await cw.send(new ListMetricsCommand({ Namespace: namespace, MetricName: metricName, NextToken: token }))
    for (const m of r.Metrics ?? []) {
      const v = (m.Dimensions ?? []).find((d) => d.Name === dimName)?.Value
      if (v) vals.add(v)
    }
    token = r.NextToken
  } while (token)
  return [...vals].sort()
}

// Domini OpenSearch dai metric AWS/ES: salvo le dimension COMPLETE (ClientId+DomainName) perché
// servono al provider per interrogare CloudWatch.
async function listOpenSearchDomains(aws) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const out = []
  const seen = new Set()
  let token
  do {
    const r = await cw.send(
      new ListMetricsCommand({ Namespace: 'AWS/ES', MetricName: 'ClusterStatus.red', NextToken: token }),
    )
    for (const m of r.Metrics ?? []) {
      const dims = m.Dimensions ?? []
      const domain = dims.find((d) => d.Name === 'DomainName')?.Value
      if (!domain || seen.has(domain)) continue
      seen.add(domain)
      out.push({
        domain,
        clientId: dims.find((d) => d.Name === 'ClientId')?.Value,
        dimensions: dims.map((d) => ({ Name: d.Name, Value: d.Value })),
      })
    }
    token = r.NextToken
  } while (token)
  return out.sort((a, b) => a.domain.localeCompare(b.domain))
}

// SES è attivo nell'account? (esistono metriche di invio)
async function sesActive(aws) {
  const cw = new CloudWatchClient(clientOpts(aws))
  const r = await cw.send(new ListMetricsCommand({ Namespace: 'AWS/SES', MetricName: 'Send' }))
  return (r.Metrics ?? []).length > 0
}

// Mappa i candidati discovery → voci servizio pronte per getStatus (in memoria, read-only).
// Pura/testabile. Usata dall'auto-discovery zero-config (server/autodiscover.js).
// region: se passata (sweep multi-region #8) viene iniettata in aws.region del servizio.
export function candidatesToServices(candidates, accountKey, region) {
  return (candidates ?? []).map((c) => ({
    name: c.name,
    account: accountKey,
    aws: region ? { ...c.aws, region } : c.aws,
    ...(c.managed !== undefined ? { managed: c.managed } : {}),
  }))
}

// Ritorna { candidates: [{ name, kind, aws, managed? }], activeInfo, tfState? }.
export async function discover({ profile, roleArn, externalId, region, activeDays = 30, exclude, all, stateBucket } = {}) {
  const aws = { profile, roleArn, externalId, region }
  const ex = exclude ? new RegExp(exclude) : null

  let [lambdas, ecs, asgs, schedules, bedrockModels, smEndpoints, osDomains, ses] = await Promise.all([
    listLambda(aws).catch(() => []),
    listEcs(aws).catch(() => []),
    listAsg(aws).catch(() => []),
    scheduleForLambdas(aws).catch(() => new Map()),
    listBedrockModels(aws).catch(() => []),
    listMetricDimension(aws, 'AWS/SageMaker', 'Invocations', 'EndpointName').catch(() => []),
    listOpenSearchDomains(aws).catch(() => []),
    sesActive(aws).catch(() => false),
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
    bedrockModels = bedrockModels.filter((m) => !ex.test(m))
    smEndpoints = smEndpoints.filter((n) => !ex.test(n))
    osDomains = osDomains.filter((d) => !ex.test(d.domain))
  }

  const candidates = [
    ...lambdas.map((n) => {
      const svcAws = { type: 'lambda', function: n, windowMinutes: 60 }
      const sched = schedules.get(n)
      if (sched?.minutes) {
        svcAws.schedule = minutesToSchedule(sched.minutes) // cadenza attesa → attiva il dead-man switch
        svcAws.scheduleExpr = sched.expr // espressione originale, per la UI
        svcAws.scheduleState = sched.state // ENABLED/DISABLED → 'disabled' se la rule è spenta di proposito
      }
      return { name: n, kind: 'lambda', aws: svcAws }
    }),
    ...ecs.map((e) => ({
      name: e.service,
      kind: 'ecs',
      aws: { type: 'ecs', cluster: e.cluster, service: e.service },
    })),
    ...asgs.map((n) => ({ name: n, kind: 'asg', aws: { type: 'asg', asg: n } })),
    ...bedrockModels.map((model) => ({ name: model, kind: 'bedrock', aws: { type: 'bedrock', model } })),
    ...smEndpoints.map((endpoint) => ({ name: endpoint, kind: 'sagemaker', aws: { type: 'sagemaker', endpoint } })),
    ...osDomains.map((d) => ({
      name: d.domain,
      kind: 'opensearch',
      aws: { type: 'opensearch', domain: d.domain, clientId: d.clientId, dimensions: d.dimensions },
    })),
    ...(ses ? [{ name: 'ses', kind: 'ses', aws: { type: 'ses' } }] : []),
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
