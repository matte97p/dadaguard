// Deduzione automatica delle dipendenze tra servizi, SENZA che l'utente dichiari nulla
// (config-free → adatto a un uso "quasi-SaaS"). Sorgenti, tutte read-only e best-effort:
//
//   env   — variabili d'ambiente che CITANO l'identificativo di un altro servizio (endpoint RDS,
//           nome funzione, URL coda). Chi cita dipende da chi è citato. Lette dalle Lambda
//           (GetFunctionConfiguration) E dalle task definition ECS (DescribeTaskDefinition):
//           così anche uno stack ECS/Fargate — non solo serverless — mostra le sue dipendenze.
//   event — event source mapping Lambda (SQS/Kinesis/DynamoDB/MSK): la Lambda è innescata
//           dalla sorgente → ne dipende. Permesso: lambda:ListEventSourceMappings.
//   flow  — Step Functions: le risorse (ARN) citate nella definizione della macchina a stati
//           sono i task che orchestra → dipende da esse. Permesso: states:DescribeStateMachine.
//   lb    — Application Load Balancer: i servizi dietro i suoi target group (ECS via
//           loadBalancers, EC2 via target di tipo instance) sono ciò che l'ALB serve → ne dipende.
//           Permessi: elasticloadbalancing:DescribeTargetGroups/DescribeTargetHealth.
//   iam   — policy del ruolo (inline + customer-managed): le Resource a cui il servizio può accedere
//           → dipendenza. È il segnale più affidabile quando le connessioni passano per Secrets
//           Manager (l'endpoint non è nelle env, ma il permesso IAM verso la risorsa resta esplicito).
//           Permessi: iam:ListRolePolicies/GetRolePolicy/ListAttachedRolePolicies/GetPolicy/GetPolicyVersion.
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
import { ECSClient, DescribeServicesCommand, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs'
import { EC2Client, DescribeInstancesCommand, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2'
import { SFNClient, DescribeStateMachineCommand } from '@aws-sdk/client-sfn'
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import {
  IAMClient,
  ListRolePoliciesCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
} from '@aws-sdk/client-iam'
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
  // Identificativi generici: il nome del servizio + ogni nome/ARN/id di risorsa dichiarato nel cfg
  // (function, cluster, service, name, instanceId, arn, table, queue, stream, topic, domain, …).
  // Così il match "per ARN" (event source, Step Functions, IAM) copre tutti i tipi senza casistiche
  // per tipo. Dagli ARN estraiamo anche il nome-risorsa finale (dopo l'ultimo : o /).
  const ids = [service.name]
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'type' || k === 'region' || typeof v !== 'string') continue
    ids.push(v)
    if (v.startsWith('arn:')) {
      const tail = v.split(/[:/]/).pop()
      if (tail) ids.push(tail)
    }
  }
  if (cfg.type === 'ecs' && cfg.cluster && cfg.service) ids.push(`${cfg.cluster}/${cfg.service}`)
  if (cfg.type === 'rds') {
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
  return [...new Set(ids)].filter((t) => t && t.length >= 5).map((t) => t.toLowerCase())
}

// Riferimenti che una Lambda "emette": valori env (concatenati, mai esposti) + ARN delle sorgenti evento.
async function lambdaReferences(service, aws) {
  const lambda = new LambdaClient(clientOpts(aws))
  let env = ''
  let role = null
  const sources = []
  try {
    const conf = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: service.aws.function }),
    )
    env = Object.values(conf.Environment?.Variables ?? {})
      .join(' \n ')
      .toLowerCase()
    role = conf.Role ?? null // ARN del ruolo di esecuzione → sorgente 'iam'
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
  return { env, sources, role }
}

// Info ECS lette UNA volta per servizio (una DescribeServices + una DescribeTaskDefinition): env
// delle task definition (per gli archi 'env') e target group agganciati (per gli archi 'lb').
// Accorpate qui apposta per non ripetere le chiamate — il throttling AWS è già un tema noto.
async function ecsInfo(service, aws) {
  const cfg = service.aws
  try {
    const ecs = new ECSClient(clientOpts(aws))
    const so = await ecs.send(
      new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }),
    )
    const svc = so.services?.[0]
    const tgArns = (svc?.loadBalancers ?? []).map((lb) => lb.targetGroupArn).filter(Boolean)
    const tdArn = svc?.deployments?.find((d) => d.status === 'PRIMARY')?.taskDefinition ?? svc?.taskDefinition
    let env = ''
    let roleArn = null
    if (tdArn) {
      const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: tdArn }))
      const vals = []
      for (const c of td.taskDefinition?.containerDefinitions ?? [])
        for (const e of c.environment ?? []) if (e.value) vals.push(e.value)
      env = vals.join(' \n ').toLowerCase()
      roleArn = td.taskDefinition?.taskRoleArn ?? null // ruolo del task → sorgente 'iam'
    }
    return { env, tgArns, roleArn }
  } catch {
    return { env: '', tgArns: [], roleArn: null }
  }
}

// ARN citati nel testo (definizione Step Functions, ecc.). Puro e testabile.
export function extractArns(text) {
  return [...String(text ?? '').matchAll(/arn:aws[a-z-]*:[^"'\s,}\]]+/gi)].map((m) => m[0])
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

// Match di un singolo ARN → nome di un servizio tracciato (puro, testabile). Token esatti dell'ARN;
// a parità preferisce il candidato dello stesso account (event source e task SFN stanno di norma lì).
// Ritorna il nome del servizio o null se l'ARN non punta a niente che stiamo monitorando.
export function matchByArn(arn, idList, self) {
  const arnTokens = new Set(String(arn).toLowerCase().split(/[\s:/]+/).filter(Boolean))
  const cands = idList.filter((t) => t.name !== self.name && t.ids.some((tok) => arnTokens.has(tok)))
  const same = cands.filter((t) => t.account === self.account)
  return (same.length ? same : cands)[0] ?? null
}

// Identificatore di un servizio nel grafo. NON è il nome: lo stesso nome esiste in più account
// (`backend` sta in staging e in produzione, gli stessi modelli Bedrock stanno in ogni account).
// Usare il nome fondeva due servizi in un nodo solo, con lo stato di quello letto per ultimo.
// `account` arriva come stringa dal risolutore dei servizi e come oggetto `{key,label,color}` nel
// payload della UI: si normalizza qui, perché una chiave costruita su un oggetto diventa
// "[object Object]" per tutti gli account e le collisioni tornano tutte insieme.
export function serviceKey(name, account) {
  const acct = (typeof account === 'string' ? account : account?.key) ?? '__none__'
  return `${acct}::${name}`
}
const keyOf = (s) => serviceKey(s.name, s.account)

// Estrae gli ARN dalle Resource degli statement Allow di un policy document IAM. Puro e testabile.
export function collectResourceArns(policyDoc) {
  const out = new Set()
  const stmts = Array.isArray(policyDoc?.Statement) ? policyDoc.Statement : [policyDoc?.Statement].filter(Boolean)
  for (const st of stmts) {
    if (st.Effect && st.Effect !== 'Allow') continue
    const res = Array.isArray(st.Resource) ? st.Resource : [st.Resource]
    for (const r of res) if (typeof r === 'string' && r.startsWith('arn:')) out.add(r)
  }
  return [...out]
}

// Legge le policy (inline + customer-managed) del ruolo e ne raccoglie gli ARN Resource: a cosa il
// servizio può accedere. È il segnale più ricco quando le connection string stanno in Secrets Manager
// (l'endpoint non è nelle env, ma il permesso IAM verso la risorsa resta esplicito). Cache per ruolo
// (più servizi lo condividono). Le managed AWS-owned (arn:aws:iam::aws:policy/…) sono saltate: danno
// permessi generici (log/metriche), non risorse del cliente. Best effort: senza iam:* niente archi.
async function iamResourceArns(roleArn, aws, cache) {
  if (cache.has(roleArn)) return cache.get(roleArn)
  const arns = new Set()
  const roleName = roleArn.split('/').pop()
  try {
    const iam = new IAMClient(clientOpts(aws))
    const inline = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName }))
    for (const name of inline.PolicyNames ?? []) {
      const p = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: name }))
      try {
        for (const a of collectResourceArns(JSON.parse(decodeURIComponent(p.PolicyDocument)))) arns.add(a)
      } catch {
        /* documento non parsabile */
      }
    }
    const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }))
    for (const ap of attached.AttachedPolicies ?? []) {
      if (!ap.PolicyArn || ap.PolicyArn.startsWith('arn:aws:iam::aws:policy/')) continue
      const pol = await iam.send(new GetPolicyCommand({ PolicyArn: ap.PolicyArn }))
      const ver = pol.Policy?.DefaultVersionId
      if (!ver) continue
      const pv = await iam.send(new GetPolicyVersionCommand({ PolicyArn: ap.PolicyArn, VersionId: ver }))
      try {
        for (const a of collectResourceArns(JSON.parse(decodeURIComponent(pv.PolicyVersion?.Document ?? '{}')))) arns.add(a)
      } catch {
        /* documento non parsabile */
      }
    }
  } catch {
    /* permessi iam:* assenti → niente archi 'iam' */
  }
  const list = [...arns]
  cache.set(roleArn, list)
  return list
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
      const acct = s.account ?? '__none__'
      if (!perAccount.has(acct)) perAccount.set(acct, { sgToServices: new Map(), aws })
      const m = perAccount.get(acct).sgToServices
      for (const sg of sgs) {
        if (!m.has(sg)) m.set(sg, new Set())
        m.get(sg).add(keyOf(s))
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

// Pass load balancer: per ogni ALB risale ai target group e collega i servizi dietro (ECS via
// il campo loadBalancers del servizio; EC2 via i target di tipo instance). ecsData porta già i
// target group letti nel pass ECS, così non ri-descriviamo i servizi. Best effort.
async function deduceLoadBalancers(services, accounts, ecsData, push) {
  const albs = services.filter((s) => s.aws?.type === 'alb' && (s.aws.arn || s.aws.name))
  if (!albs.length) return

  const ecsByTg = new Map() // `${account}|${targetGroupArn}` -> chiave servizio ECS
  for (const s of services) {
    if (s.aws?.type !== 'ecs') continue
    for (const tg of ecsData.get(keyOf(s))?.tgArns ?? [])
      ecsByTg.set(`${s.account ?? '__none__'}|${tg}`, keyOf(s))
  }
  const ec2ByInstance = new Map() // `${account}|${instanceId}` -> chiave servizio EC2
  for (const s of services)
    if (s.aws?.type === 'ec2' && s.aws.instanceId)
      ec2ByInstance.set(`${s.account ?? '__none__'}|${s.aws.instanceId}`, keyOf(s))

  await Promise.all(
    albs.map(async (alb) => {
      const aws = awsFor(alb, accounts)
      const acct = alb.account ?? '__none__'
      try {
        const client = new ElasticLoadBalancingV2Client(clientOpts(aws))
        let lbArn = alb.aws.arn
        if (!lbArn) {
          const lo = await client.send(new DescribeLoadBalancersCommand({ Names: [alb.aws.name] }))
          lbArn = lo.LoadBalancers?.[0]?.LoadBalancerArn
        }
        if (!lbArn) return
        const tgo = await client.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lbArn }))
        const albKey = keyOf(alb)
        for (const tg of tgo.TargetGroups ?? []) {
          const ecsKey = ecsByTg.get(`${acct}|${tg.TargetGroupArn}`)
          if (ecsKey && ecsKey !== albKey) {
            push(albKey, ecsKey, 'lb')
            continue
          }
          if (tg.TargetType !== 'instance') continue
          try {
            const th = await client.send(
              new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }),
            )
            for (const d of th.TargetHealthDescriptions ?? []) {
              const ec2Key = ec2ByInstance.get(`${acct}|${d.Target?.Id}`)
              if (ec2Key && ec2Key !== albKey) push(albKey, ec2Key, 'lb')
            }
          } catch {
            /* DescribeTargetHealth non concesso → niente archi lb via istanza */
          }
        }
      } catch {
        /* ALB non leggibile / permesso assente → niente archi lb per questo LB */
      }
    }),
  )
}

// Deduzione completa. Ritorna { edges, extraNodes, nodes }:
//   edges      [{ source, target, vias[] }] — source/target sono CHIAVI (`account::nome`), non nomi
//   extraNodes [{ id, type, label }]        — sorgenti evento non tracciate (code/stream), id già unico
//   nodes      [{ id, name, account, type }] — chiave → servizio, per etichettare senza indovinare
export async function deduceTopology(services, accounts) {
  const idList = await Promise.all(
    services.map(async (s) => ({
      name: s.name,
      account: s.account ?? '__none__', // serve a disambiguare i match tra account diversi
      key: keyOf(s),
      ids: await identifiers(s, awsFor(s, accounts)),
    })),
  )
  // Un `dependsOn` dichiarato cita un NOME, non una chiave: si risolve preferendo lo stesso account,
  // e resta ambiguo solo se quel nome esiste in più account e nessuno è il proprio.
  const resolveDeclared = (name, self) =>
    idList.find((t) => t.name === name && t.account === self.account)?.key ??
    idList.find((t) => t.name === name)?.key ??
    null

  const edges = []
  const extra = new Map()
  const roleByService = new Map() // nome servizio → ARN del ruolo (per la sorgente 'iam')
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
    for (const d of s.dependsOn ?? []) {
      const target = resolveDeclared(d, { account: s.account ?? '__none__' })
      if (target) push(keyOf(s), target, 'declared')
    }

  // ECS: leggo env + target group una volta sola per servizio (riusati dai pass env e lb).
  const ecsData = new Map()
  await Promise.all(
    services
      .filter((s) => s.aws?.type === 'ecs' && s.aws.cluster && s.aws.service)
      .map(async (s) => ecsData.set(keyOf(s), await ecsInfo(s, awsFor(s, accounts)))),
  )

  // env (Lambda + ECS) + event source (Lambda).
  await Promise.all(
    services.map(async (s) => {
      const type = s.aws?.type
      const self = { name: s.name, account: s.account ?? '__none__' }

      if (type === 'lambda' && s.aws.function) {
        const { env, sources, role } = await lambdaReferences(s, awsFor(s, accounts))
        if (role) roleByService.set(keyOf(s), role)
        // Match a TOKEN ESATTO (non substring): le env sono già stringhe separate; tokenizzo su
        // spazi e separatori comuni di URL/connection-string. Evita i falsi positivi del substring
        // (es. "prod" dentro "production"). Endpoint RDS e nomi funzione restano token interi.
        for (const t of matchEnvTargets(env, self, idList)) push(keyOf(s), t.key, 'env')

        for (const arn of sources) {
          const matched = matchByArn(arn, idList, self)
          if (matched) {
            push(keyOf(s), matched.key, 'event')
            continue
          }
          // sorgente non tracciata → nodo esterno (arn:aws:<kind>:region:acct:<name>)
          const parts = arn.split(':')
          const kind = parts[2] || 'evento'
          const resName = parts.slice(5).join(':') || arn
          const id = `ext:${kind}:${resName}`
          if (!extra.has(id)) extra.set(id, { id, type: kind, label: resName })
          push(keyOf(s), id, 'event')
        }
      } else if (type === 'ecs') {
        for (const t of matchEnvTargets(ecsData.get(keyOf(s))?.env ?? '', self, idList))
          push(keyOf(s), t.key, 'env')
      }
    }),
  )

  // Step Functions → risorse citate nella definizione (i task orchestrati).
  await Promise.all(
    services
      .filter((s) => s.aws?.type === 'sfn' && s.aws.arn)
      .map(async (s) => {
        const self = { name: s.name, account: s.account ?? '__none__' }
        try {
          const sfn = new SFNClient(clientOpts(awsFor(s, accounts)))
          const o = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: s.aws.arn }))
          for (const arn of extractArns(o.definition)) {
            const matched = matchByArn(arn, idList, self)
            if (matched) push(keyOf(s), matched.key, 'flow')
          }
        } catch {
          /* states:DescribeStateMachine assente → niente archi 'flow' */
        }
      }),
  )

  // ALB → servizi dietro i target group.
  await deduceLoadBalancers(services, accounts, ecsData, push).catch(() => {})

  // IAM → risorse a cui il ruolo del servizio può accedere (dipendenza dedotta dai permessi).
  const roleCache = new Map()
  await Promise.all(
    services.map(async (s) => {
      const type = s.aws?.type
      const roleArn =
        type === 'lambda' ? roleByService.get(keyOf(s)) : type === 'ecs' ? ecsData.get(keyOf(s))?.roleArn : null
      if (!roleArn) return
      const self = { name: s.name, account: s.account ?? '__none__' }
      const arns = await iamResourceArns(roleArn, awsFor(s, accounts), roleCache)
      for (const arn of arns) {
        const matched = matchByArn(arn, idList, self)
        if (matched) push(keyOf(s), matched.key, 'iam')
      }
    }),
  ).catch(() => {})

  // rete (security group) — best effort, non blocca se manca il permesso.
  await deduceBySecurityGroups(services, accounts, push).catch(() => {})

  // `nodes` porta la corrispondenza chiave → servizio: la UI non deve ricostruirsi la convenzione
  // della chiave, che è l'errore da cui nasceva la fusione di due servizi omonimi in un nodo solo.
  const nodes = services.map((s) => ({
    id: keyOf(s),
    name: s.name,
    account: s.account ?? null,
    type: s.aws?.type ?? s.type ?? null,
  }))
  return { edges, extraNodes: [...extra.values()], nodes }
}
