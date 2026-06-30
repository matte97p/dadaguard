// Deduzione automatica delle dipendenze tra servizi, SENZA che l'utente dichiari nulla
// (config-free → adatto a un uso "quasi-SaaS"). Tre sorgenti, tutte read-only e best-effort:
//
//   env   — variabili d'ambiente Lambda che CITANO l'identificativo di un altro servizio
//           (endpoint RDS, nome funzione, URL coda). Chi cita dipende da chi è citato.
//           Permesso: lambda:GetFunctionConfiguration (già nel ruolo read-only).
//   event — event source mapping Lambda (SQS/Kinesis/DynamoDB/MSK): la Lambda è innescata
//           dalla sorgente → ne dipende. Permesso: lambda:ListEventSourceMappings.
//   net   — regole di ingress dei security group: se l'SG del servizio T ammette come
//           sorgente l'SG del servizio A, allora A può raggiungere T → A dipende da T.
//           Permesso: ec2:DescribeSecurityGroups (+ describe già concessi per i singoli tipi).
//
// Ogni sorgente è isolata in try/catch: un permesso mancante non rompe nulla, semplicemente
// non produce quegli archi. I VALORI delle env var sono usati solo per il match a runtime e
// non vengono MAI restituiti al client né salvati (coerente con "secret solo per nome").
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
  ListEventSourceMappingsCommand,
} from '@aws-sdk/client-lambda'
import { RDSClient, DescribeDBClustersCommand, DescribeDBInstancesCommand } from '@aws-sdk/client-rds'
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs'
import { EC2Client, DescribeInstancesCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2'
import { clientOpts } from '../runtime/awsClient.js'

// Credenziali/region per un servizio: dall'account, con override di region per-servizio.
function awsFor(service, accounts) {
  const a = service.account ? accounts[service.account] : null
  return {
    profile: a?.profile,
    roleArn: a?.roleArn,
    externalId: a?.externalId,
    region: service.aws?.region ?? a?.region,
  }
}

// Stringhe che, se trovate altrove, implicano "dipende da QUESTO servizio".
// Token < 5 caratteri scartati: troppo corti → rischio di falso positivo nel substring match.
async function identifiers(service, aws) {
  const cfg = service.aws ?? {}
  const ids = []
  if (cfg.type === 'lambda' && cfg.function) ids.push(cfg.function)
  if (cfg.type === 'ecs') {
    if (cfg.service) ids.push(cfg.service)
    if (cfg.cluster && cfg.service) ids.push(`${cfg.cluster}/${cfg.service}`)
  }
  if (cfg.type === 'alb' && cfg.name) ids.push(cfg.name)
  if (cfg.type === 'ec2' && cfg.instanceId) ids.push(cfg.instanceId)
  if (cfg.type === 'rds') {
    if (cfg.cluster) ids.push(cfg.cluster)
    if (cfg.instance) ids.push(cfg.instance)
    // l'endpoint host è l'identificativo più specifico (lo si trova nelle env DB_HOST/DATABASE_URL).
    try {
      const rds = new RDSClient(clientOpts(aws))
      if (cfg.cluster) {
        const o = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: cfg.cluster }))
        const c = o.DBClusters?.[0]
        if (c?.Endpoint) ids.push(c.Endpoint)
        if (c?.ReaderEndpoint) ids.push(c.ReaderEndpoint)
      } else if (cfg.instance) {
        const o = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: cfg.instance }))
        const ep = o.DBInstances?.[0]?.Endpoint?.Address
        if (ep) ids.push(ep)
      }
    } catch {
      /* endpoint non leggibile: resta l'id del cluster/istanza */
    }
  }
  return ids.filter((t) => t && t.length >= 5).map((t) => t.toLowerCase())
}

// Riferimenti che una Lambda "emette": valori env (concatenati, mai esposti) + ARN delle sorgenti evento.
async function lambdaReferences(service, aws) {
  const lambda = new LambdaClient(clientOpts(aws))
  let env = ''
  const sources = []
  try {
    const conf = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: service.aws.function }),
    )
    env = Object.values(conf.Environment?.Variables ?? {})
      .join(' \n ')
      .toLowerCase()
  } catch {
    /* niente env leggibili */
  }
  try {
    const o = await lambda.send(
      new ListEventSourceMappingsCommand({ FunctionName: service.aws.function }),
    )
    for (const m of o.EventSourceMappings ?? []) if (m.EventSourceArn) sources.push(m.EventSourceArn)
  } catch {
    /* permesso lambda:ListEventSourceMappings assente → niente archi 'event' */
  }
  return { env, sources }
}

// Security group esposti da un servizio (per la sorgente di rete).
async function serviceSecurityGroups(service, aws) {
  const cfg = service.aws ?? {}
  try {
    if (cfg.type === 'lambda') {
      const conf = await new LambdaClient(clientOpts(aws)).send(
        new GetFunctionConfigurationCommand({ FunctionName: cfg.function }),
      )
      return conf.VpcConfig?.SecurityGroupIds ?? []
    }
    if (cfg.type === 'rds') {
      const rds = new RDSClient(clientOpts(aws))
      if (cfg.cluster) {
        const o = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: cfg.cluster }))
        return (o.DBClusters?.[0]?.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId)
      }
      if (cfg.instance) {
        const o = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: cfg.instance }))
        return (o.DBInstances?.[0]?.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId)
      }
    }
    if (cfg.type === 'ecs') {
      const o = await new ECSClient(clientOpts(aws)).send(
        new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }),
      )
      return o.services?.[0]?.networkConfiguration?.awsvpcConfiguration?.securityGroups ?? []
    }
    if (cfg.type === 'ec2') {
      const o = await new EC2Client(clientOpts(aws)).send(
        new DescribeInstancesCommand({ InstanceIds: [cfg.instanceId] }),
      )
      return (o.Reservations?.[0]?.Instances?.[0]?.SecurityGroups ?? []).map((g) => g.GroupId)
    }
  } catch {
    /* best effort */
  }
  return []
}

// Pass di rete: per ogni account, mappa SG→servizi e leggi le regole di ingress.
// Se l'SG del servizio T ammette come sorgente l'SG del servizio A → A dipende da T.
async function deduceBySecurityGroups(services, accounts, push) {
  const perAccount = new Map() // accountKey -> { sgToServices: Map<sgId, Set<name>>, aws }
  await Promise.all(
    services.map(async (s) => {
      const aws = awsFor(s, accounts)
      const sgs = await serviceSecurityGroups(s, aws)
      if (!sgs.length) return
      const key = s.account ?? '__none__'
      if (!perAccount.has(key)) perAccount.set(key, { sgToServices: new Map(), aws })
      const m = perAccount.get(key).sgToServices
      for (const sg of sgs) {
        if (!m.has(sg)) m.set(sg, new Set())
        m.get(sg).add(s.name)
      }
    }),
  )

  for (const { sgToServices, aws } of perAccount.values()) {
    const ids = [...sgToServices.keys()]
    if (!ids.length) continue
    let groups
    try {
      const o = await new EC2Client(clientOpts(aws)).send(
        new DescribeSecurityGroupsCommand({ GroupIds: ids }),
      )
      groups = o.SecurityGroups ?? []
    } catch {
      continue // permesso ec2:DescribeSecurityGroups assente → niente archi 'net'
    }
    for (const g of groups) {
      const targets = sgToServices.get(g.GroupId) // servizi che ESPONGONO questo SG (es. il DB)
      if (!targets) continue
      for (const perm of g.IpPermissions ?? []) {
        for (const pair of perm.UserIdGroupPairs ?? []) {
          const sources = sgToServices.get(pair.GroupId) // servizi che usano l'SG sorgente (es. l'app)
          if (!sources) continue
          for (const a of sources) for (const t of targets) if (a !== t) push(a, t, 'net')
        }
      }
    }
  }
}

// Match env→servizio (puro, testabile): token ESATTO (no substring, niente "prod" dentro
// "production") + disambiguazione per account. Se c'è un candidato nello STESSO account è quello
// (uccide le collisioni di nomi tra ambienti); se il token è unico e vive in un altro account,
// è una dipendenza cross-account VERA (es. lambda staging che legge il DB prod) → la tengo.
export function matchEnvTargets(env, self, idList) {
  const tokens = new Set(String(env || '').split(/[\s,;:'"(){}\[\]|=/@?&]+/).filter(Boolean))
  const candidates = idList.filter((t) => t.name !== self.name && t.ids.some((tok) => tokens.has(tok)))
  const sameAcct = candidates.filter((t) => t.account === self.account)
  return sameAcct.length ? sameAcct : candidates
}

// Deduzione completa. Ritorna { edges:[{source,target,vias[]}], extraNodes:[{id,type,label}] }.
// extraNodes = sorgenti evento non tracciate (code/stream) da disegnare come nodi esterni.
export async function deduceTopology(services, accounts) {
  const idList = await Promise.all(
    services.map(async (s) => ({
      name: s.name,
      account: s.account ?? '__none__', // serve a disambiguare i match tra account diversi
      ids: await identifiers(s, awsFor(s, accounts)),
    })),
  )
  const byName = new Set(services.map((s) => s.name))

  const edges = []
  const extra = new Map()
  const push = (source, target, via) => {
    const e = edges.find((x) => x.source === source && x.target === target)
    if (e) {
      if (!e.vias.includes(via)) e.vias.push(via)
      return
    }
    edges.push({ source, target, vias: [via] })
  }

  // relazioni dichiarate a mano (se presenti) — restano valide e marcate 'declared'.
  for (const s of services)
    for (const d of s.dependsOn ?? []) if (byName.has(d)) push(s.name, d, 'declared')

  // env + event source dalle Lambda.
  await Promise.all(
    services
      .filter((s) => s.aws?.type === 'lambda' && s.aws.function)
      .map(async (s) => {
        const { env, sources } = await lambdaReferences(s, awsFor(s, accounts))

        // Match a TOKEN ESATTO (non substring): le env sono già stringhe separate; tokenizzo su
        // spazi e separatori comuni di URL/connection-string. Evita i falsi positivi del substring
        // (es. "prod" dentro "production"). Endpoint RDS e nomi funzione restano token interi.
        for (const t of matchEnvTargets(env, { name: s.name, account: s.account ?? '__none__' }, idList))
          push(s.name, t.name, 'env')

        for (const arn of sources) {
          const lower = arn.toLowerCase()
          const arnTokens = new Set(lower.split(/[\s:/]+/).filter(Boolean))
          const evCandidates = idList.filter(
            (t) => t.name !== s.name && t.ids.some((tok) => arnTokens.has(tok)),
          )
          // gli event source mapping sono tipicamente nello stesso account della Lambda → preferiscilo
          const evSame = evCandidates.filter((t) => t.account === s.account)
          const matched = (evSame.length ? evSame : evCandidates)[0]
          if (matched) {
            push(s.name, matched.name, 'event')
            continue
          }
          // sorgente non tracciata → nodo esterno (arn:aws:<kind>:region:acct:<name>)
          const parts = arn.split(':')
          const kind = parts[2] || 'evento'
          const resName = parts.slice(5).join(':') || arn
          const id = `ext:${kind}:${resName}`
          if (!extra.has(id)) extra.set(id, { id, type: kind, label: resName })
          push(s.name, id, 'event')
        }
      }),
  )

  // rete (security group) — best effort, non blocca se manca il permesso.
  await deduceBySecurityGroups(services, accounts, push).catch(() => {})

  return { edges, extraNodes: [...extra.values()] }
}
