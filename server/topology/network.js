// Topologia di RETE (seconda vista): dove vive ogni servizio a livello di rete — VPC → subnet,
// security group, ed egress della VPC (NAT/IGW). Read-only, best-effort: un servizio senza VPC
// (tipico delle Lambda non-VPC) NON sparisce, finisce nel gruppo "senza VPC".
//
// Permessi: oltre a quelli runtime già concessi, servono ec2:DescribeSubnets, ec2:DescribeVpcs,
// ec2:DescribeInternetGateways (DescribeSecurityGroups e DescribeNatGateways già concessi).
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda'
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds'
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs'
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  DescribeNatGatewaysCommand,
  DescribeInternetGatewaysCommand,
} from '@aws-sdk/client-ec2'
import { clientOpts } from '../runtime/awsClient.js'

function awsFor(service, accounts) {
  const a = service.account ? accounts[service.account] : null
  return { profile: a?.profile, roleArn: a?.roleArn, externalId: a?.externalId, region: service.aws?.region ?? a?.region }
}

const nameTag = (tags) => (tags ?? []).find((t) => t.Key === 'Name')?.Value || null

// Collocazione di rete di un servizio: { subnetIds, sgIds }. vpcId si deriva dalle subnet.
async function placement(service, aws) {
  const cfg = service.aws ?? {}
  try {
    if (cfg.type === 'lambda') {
      const c = await new LambdaClient(clientOpts(aws)).send(
        new GetFunctionConfigurationCommand({ FunctionName: cfg.function }),
      )
      const v = c.VpcConfig
      return { subnetIds: v?.SubnetIds ?? [], sgIds: v?.SecurityGroupIds ?? [] }
    }
    if (cfg.type === 'rds') {
      const rds = new RDSClient(clientOpts(aws))
      const o = cfg.cluster
        ? await rds.send(new DescribeDBInstancesCommand({ Filters: [{ Name: 'db-cluster-id', Values: [cfg.cluster] }] }))
        : await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: cfg.instance }))
      const i = o.DBInstances?.[0]
      const subs = (i?.DBSubnetGroup?.Subnets ?? []).map((s) => s.SubnetIdentifier).filter(Boolean)
      return { subnetIds: subs, sgIds: (i?.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId) }
    }
    if (cfg.type === 'ecs') {
      const o = await new ECSClient(clientOpts(aws)).send(
        new DescribeServicesCommand({ cluster: cfg.cluster, services: [cfg.service] }),
      )
      const net = o.services?.[0]?.networkConfiguration?.awsvpcConfiguration
      return { subnetIds: net?.subnets ?? [], sgIds: net?.securityGroups ?? [] }
    }
    if (cfg.type === 'ec2') {
      const o = await new EC2Client(clientOpts(aws)).send(new DescribeInstancesCommand({ InstanceIds: [cfg.instanceId] }))
      const inst = o.Reservations?.[0]?.Instances?.[0]
      return { subnetIds: inst?.SubnetId ? [inst.SubnetId] : [], sgIds: (inst?.SecurityGroups ?? []).map((g) => g.GroupId) }
    }
  } catch {
    /* permessi/risorsa: degrada → nessuna collocazione (finirà in "senza VPC") */
  }
  return { subnetIds: [], sgIds: [] }
}

// Egress della VPC: ha un NAT gateway? un internet gateway? (best-effort, non blocca se manca il permesso)
async function vpcEgress(ec2, vpcId) {
  const out = { nat: 0, igw: false }
  try {
    const n = await ec2.send(new DescribeNatGatewaysCommand({ Filter: [{ Name: 'vpc-id', Values: [vpcId] }] }))
    out.nat = (n.NatGateways ?? []).filter((g) => g.State === 'available').length
  } catch {
    /* niente conteggio NAT */
  }
  try {
    const g = await ec2.send(new DescribeInternetGatewaysCommand({ Filters: [{ Name: 'attachment.vpc-id', Values: [vpcId] }] }))
    out.igw = (g.InternetGateways ?? []).length > 0
  } catch {
    /* niente IGW */
  }
  return out
}

// Costruisce la mappa per UN account: { vpcs: [{id,name,cidr,nat,igw,subnets:[{id,name,az,public,services[]}]}], noVpc: [name] }.
async function accountNetwork(accountKey, services, accounts) {
  const acct = accounts[accountKey]
  const aws = { profile: acct?.profile, roleArn: acct?.roleArn, externalId: acct?.externalId, region: acct?.region }
  const ec2 = new EC2Client(clientOpts(aws))

  // 1) collocazione per servizio
  const placed = await Promise.all(
    services.map(async (s) => ({ name: s.name, type: s.aws?.type ?? null, ...(await placement(s, awsFor(s, accounts))) })),
  )

  // 2) risolvi le subnet (→ VPC, AZ, pubblica?) in un colpo
  const allSubnets = [...new Set(placed.flatMap((p) => p.subnetIds))]
  const subnetInfo = new Map() // subnetId → {vpcId, az, name, public}
  if (allSubnets.length) {
    try {
      const o = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: allSubnets }))
      for (const s of o.Subnets ?? [])
        subnetInfo.set(s.SubnetId, { vpcId: s.VpcId, az: s.AvailabilityZone, name: nameTag(s.Tags), public: !!s.MapPublicIpOnLaunch })
    } catch {
      /* senza DescribeSubnets non possiamo raggruppare per VPC → tutto finirà "senza VPC" */
    }
  }

  // 3) raggruppa i servizi per VPC → subnet
  const vpcs = new Map() // vpcId → { subnets: Map<subnetId, {services:Set}> }
  const noVpc = []
  for (const p of placed) {
    const sub = p.subnetIds.map((id) => subnetInfo.get(id)).find((x) => x?.vpcId)
    if (!sub) {
      noVpc.push(p.name)
      continue
    }
    if (!vpcs.has(sub.vpcId)) vpcs.set(sub.vpcId, new Map())
    const subMap = vpcs.get(sub.vpcId)
    // metti il servizio nella sua prima subnet nota (per chiarezza visiva)
    const sid = p.subnetIds.find((id) => subnetInfo.get(id)?.vpcId === sub.vpcId)
    if (!subMap.has(sid)) subMap.set(sid, new Set())
    subMap.get(sid).add(p.name)
  }

  // 4) nomi/CIDR VPC + egress
  const vpcMeta = new Map()
  if (vpcs.size) {
    try {
      const o = await ec2.send(new DescribeVpcsCommand({ VpcIds: [...vpcs.keys()] }))
      for (const v of o.Vpcs ?? []) vpcMeta.set(v.VpcId, { name: nameTag(v.Tags), cidr: v.CidrBlock })
    } catch {
      /* nomi VPC non disponibili: useremo l'id */
    }
  }

  const vpcOut = []
  for (const [vpcId, subMap] of vpcs) {
    const egress = await vpcEgress(ec2, vpcId)
    vpcOut.push({
      id: vpcId,
      name: vpcMeta.get(vpcId)?.name ?? null,
      cidr: vpcMeta.get(vpcId)?.cidr ?? null,
      nat: egress.nat,
      igw: egress.igw,
      subnets: [...subMap].map(([id, set]) => ({
        id,
        name: subnetInfo.get(id)?.name ?? null,
        az: subnetInfo.get(id)?.az ?? null,
        public: subnetInfo.get(id)?.public ?? false,
        services: [...set],
      })),
    })
  }
  return { account: accountKey, label: acct?.label ?? accountKey, color: acct?.color ?? null, vpcs: vpcOut, noVpc }
}

// Mappa di rete completa, per account. Servizi senza account o senza VPC raggruppati a parte.
export async function networkTopology(services, accounts) {
  const byAccount = new Map()
  for (const s of services) {
    const k = s.account ?? '__none__'
    if (!byAccount.has(k)) byAccount.set(k, [])
    byAccount.get(k).push(s)
  }
  const out = await Promise.all(
    [...byAccount].map(([k, svcs]) => (accounts[k] ? accountNetwork(k, svcs, accounts) : { account: k, label: k, vpcs: [], noVpc: svcs.map((s) => s.name) })),
  )
  return { accounts: out }
}
