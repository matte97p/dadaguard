// Segnale #11 — security quick-win (read-only). Due controlli, entrambi correlati al
// servizio solo quando c'è un aggancio onesto (niente euristiche che inventano legami):
//
//  (a) Security Group aperti: regole ingress con 0.0.0.0/0 o ::/0 su porte sensibili.
//      Si applica ai servizi che dichiarano i loro SG: `aws.securityGroupIds: [sg-…]`
//      (o `securityGroupIds` a livello di servizio). Permesso: ec2:DescribeSecurityGroups
//      (già concesso al ruolo per la topologia).
//
//  (b) IAM wildcard: il ruolo del servizio ha policy con Action:"*" o Resource:"*" ampie.
//      Si applica se il servizio dichiara `aws.roleName` (o `iamRole`). Permessi IAM read:
//      iam:ListAttachedRolePolicies, iam:GetPolicy, iam:GetPolicyVersion, iam:GetRolePolicy,
//      iam:ListRolePolicies.
//
// Degrada con grazia: permessi mancanti / API in errore → unknown (non rompe la card).
// Status: degraded se trova aperture, up se pulito, unknown/null se non correlabile.
import { EC2Client, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2'
import {
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  GetRolePolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
} from '@aws-sdk/client-iam'
import { clientOpts } from '../runtime/awsClient.js'

export const key = 'security'

// Porte “sensibili”: pannelli/DB/SSH che non dovrebbero stare su 0.0.0.0/0.
// 22 SSH · 3389 RDP · 3306 MySQL · 5432 Postgres · 6379 Redis · 27017 Mongo · 9200 ES.
const SENSITIVE = new Set([22, 3389, 3306, 5432, 6379, 27017, 9200, 1433, 5984, 11211])
const OPEN_V4 = '0.0.0.0/0'
const OPEN_V6 = '::/0'

export async function run(service, ctx) {
  const t = ctx?.t ?? ((k) => k)
  const cfg = service.aws ?? {}
  const aws = {
    profile: ctx?.profile,
    roleArn: ctx?.roleArn,
    externalId: ctx?.externalId,
    region: cfg.region ?? ctx?.region,
  }

  const sgIds = cfg.securityGroupIds ?? service.securityGroupIds ?? []
  const roleName = cfg.roleName ?? service.iamRole ?? null

  // Niente da correlare onestamente → segnale non applicabile a questo servizio.
  if (!sgIds.length && !roleName) return null

  const findings = []

  // (a) Security Group aperti.
  if (sgIds.length) {
    try {
      const open = await openSgRules(sgIds, aws, t)
      if (open.length) {
        const list = open.slice(0, 2).join(', ')
        const more = open.length > 2 ? t('security.sgopenmore', { list, n: open.length - 2 }) : list
        findings.push(t('security.sgopen', { n: open.length, list: more }))
      }
    } catch {
      return { key, status: 'unknown', reason: t('security.nosg') }
    }
  }

  // (b) IAM wildcard sul ruolo del servizio.
  if (roleName) {
    try {
      const wild = await roleWildcards(roleName, aws)
      if (wild.length) {
        const list = wild.slice(0, 2).join(', ')
        findings.push(t('security.iamwildcard', { n: wild.length, list }))
      }
    } catch {
      // permessi IAM read mancanti: non rompere — se non c'era nemmeno un SG, marca unknown.
      if (!sgIds.length) return { key, status: 'unknown', reason: t('security.notapplicable') }
    }
  }

  if (findings.length) return { key, status: 'degraded', summary: findings.join(' · ') }
  return { key, status: 'up', summary: t('security.clean') }
}

// Regole ingress aperte a internet su porte sensibili. Ritorna etichette tipo "porta 22".
async function openSgRules(sgIds, aws, t) {
  const ec2 = new EC2Client(clientOpts(aws))
  const out = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: sgIds }))
  const labels = []
  for (const sg of out.SecurityGroups ?? []) {
    for (const perm of sg.IpPermissions ?? []) {
      const open =
        (perm.IpRanges ?? []).some((r) => r.CidrIp === OPEN_V4) ||
        (perm.Ipv6Ranges ?? []).some((r) => r.CidrIpv6 === OPEN_V6)
      if (!open) continue
      // -1 / null = tutte le porte (sempre sensibile); altrimenti solo le porte note.
      const allPorts = perm.IpProtocol === '-1' || perm.FromPort == null
      if (allPorts) {
        labels.push(t('security.allports'))
        continue
      }
      for (let p = perm.FromPort; p <= perm.ToPort; p++) {
        if (SENSITIVE.has(p)) labels.push(t('security.port', { p }))
      }
    }
  }
  return [...new Set(labels)]
}

// Policy (managed attached + inline) del ruolo con Action:"*" o Resource:"*" su Allow.
// Ritorna i nomi delle policy “larghe”.
async function roleWildcards(roleName, aws) {
  const iam = new IAMClient(clientOpts(aws))
  const wide = []

  // Managed attached.
  const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }))
  for (const p of attached.AttachedPolicies ?? []) {
    try {
      const meta = await iam.send(new GetPolicyCommand({ PolicyArn: p.PolicyArn }))
      const ver = meta.Policy?.DefaultVersionId
      if (!ver) continue
      const v = await iam.send(new GetPolicyVersionCommand({ PolicyArn: p.PolicyArn, VersionId: ver }))
      if (docHasWildcard(v.PolicyVersion?.Document)) wide.push(p.PolicyName ?? p.PolicyArn)
    } catch {
      /* policy non leggibile: salta, non rompere */
    }
  }

  // Inline.
  const inline = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName }))
  for (const name of inline.PolicyNames ?? []) {
    try {
      const doc = await iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: name }))
      if (docHasWildcard(doc.PolicyDocument)) wide.push(name)
    } catch {
      /* salta */
    }
  }

  return [...new Set(wide)]
}

// Il documento policy (URL-encoded o JSON) ha uno statement Allow con Action:"*" o Resource:"*".
function docHasWildcard(document) {
  if (!document) return false
  let doc
  try {
    doc = typeof document === 'string' ? JSON.parse(decodeURIComponent(document)) : document
  } catch {
    try {
      doc = JSON.parse(document)
    } catch {
      return false
    }
  }
  const stmts = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement].filter(Boolean)
  const has = (x) => (Array.isArray(x) ? x.includes('*') : x === '*')
  return stmts.some((s) => s && s.Effect === 'Allow' && (has(s.Action) || has(s.Resource)))
}
