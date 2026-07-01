// Findings di sicurezza/governance aggregati (read-only). Ogni collector ritorna un array di finding:
//   { category, severity: 'high'|'medium'|'low'|'info', account, accountLabel, resource, detail }
// collectFindings() li unisce. Ogni collector è best effort: un permesso mancante non rompe gli altri.
import { EC2Client, DescribeSecurityGroupsCommand } from '@aws-sdk/client-ec2'
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds'
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { S3Client, GetBucketPolicyStatusCommand, GetPublicAccessBlockCommand } from '@aws-sdk/client-s3'
import { ACMClient, ListCertificatesCommand, DescribeCertificateCommand } from '@aws-sdk/client-acm'
import {
  IAMClient,
  ListPoliciesCommand,
  GetPolicyVersionCommand,
  ListUsersCommand,
  ListAccessKeysCommand,
  ListMFADevicesCommand,
} from '@aws-sdk/client-iam'
import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager'
import { clientOpts } from './runtime/awsClient.js'
import { parseStatements } from './iam.js'

const DAY = 86400000

// Porte che, esposte a 0.0.0.0/0, sono un rischio (80/443 sono normali → non le segnaliamo).
const SENSITIVE_PORTS = { 22: 'SSH', 3389: 'RDP', 3306: 'MySQL', 5432: 'Postgres', 6379: 'Redis', 27017: 'MongoDB', 9200: 'Elasticsearch' }

function awsFor(service, accounts) {
  const a = service.account ? accounts[service.account.key ?? service.account] : null
  return { profile: a?.profile, roleArn: a?.roleArn, externalId: a?.externalId, region: service.aws?.region ?? a?.region }
}
function awsForAccount(acc) {
  return { profile: acc?.profile, roleArn: acc?.roleArn, externalId: acc?.externalId, region: acc?.region || 'us-east-1' }
}

// Una porta/range include una porta sensibile? (from null = tutte le porte)
function hitsSensitivePort(from, to) {
  if (from == null) return true
  return Object.keys(SENSITIVE_PORTS).some((p) => from <= Number(p) && Number(p) <= to)
}

// Superficie pubblica: cosa è raggiungibile da internet.
export async function publicSurface(accounts, services) {
  const findings = []

  // 1) Security group con ingress da 0.0.0.0/0 su porte sensibili (o "tutte") — un pass per account.
  await Promise.all(
    Object.entries(accounts ?? {}).map(async ([key, acc]) => {
      try {
        const ec2 = new EC2Client(clientOpts(awsForAccount(acc)))
        let token
        do {
          const o = await ec2.send(new DescribeSecurityGroupsCommand({ NextToken: token, MaxResults: 1000 }))
          for (const g of o.SecurityGroups ?? []) {
            for (const perm of g.IpPermissions ?? []) {
              const open = (perm.IpRanges ?? []).some((r) => r.CidrIp === '0.0.0.0/0')
              if (!open) continue
              const all = perm.IpProtocol === '-1'
              if (!all && !hitsSensitivePort(perm.FromPort, perm.ToPort)) continue // 80/443 ecc. → normale
              const proto = all ? 'all' : perm.IpProtocol
              const ports = perm.FromPort == null ? 'all' : perm.FromPort === perm.ToPort ? `${perm.FromPort}` : `${perm.FromPort}-${perm.ToPort}`
              findings.push({
                category: 'public',
                severity: 'high',
                account: key,
                accountLabel: acc.label ?? key,
                resource: `${g.GroupId}${g.GroupName ? ` (${g.GroupName})` : ''}`,
                detail: `security group aperto a 0.0.0.0/0 · ${proto} ${ports}`,
              })
            }
          }
          token = o.NextToken
        } while (token)
      } catch {
        /* ec2:DescribeSecurityGroups assente → niente questo controllo */
      }
    }),
  )

  // 2) RDS publicly accessible.
  await Promise.all(
    services
      .filter((s) => s.aws?.type === 'rds' && s.aws.instance)
      .map(async (s) => {
        try {
          const rds = new RDSClient(clientOpts(awsFor(s, accounts)))
          const o = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: s.aws.instance }))
          if (o.DBInstances?.[0]?.PubliclyAccessible)
            findings.push({ category: 'public', severity: 'high', account: s.account?.key, accountLabel: s.account?.label, resource: s.name, detail: 'RDS publicly accessible', link: { view: 'resource', account: s.account?.key, needle: s.name } })
        } catch {
          /* best effort */
        }
      }),
  )

  // 3) ALB internet-facing (informativo: spesso legittimo, ma va saputo).
  await Promise.all(
    services
      .filter((s) => s.aws?.type === 'alb' && (s.aws.arn || s.aws.name))
      .map(async (s) => {
        try {
          const elb = new ElasticLoadBalancingV2Client(clientOpts(awsFor(s, accounts)))
          const o = await elb.send(
            new DescribeLoadBalancersCommand(s.aws.arn ? { LoadBalancerArns: [s.aws.arn] } : { Names: [s.aws.name] }),
          )
          if (o.LoadBalancers?.[0]?.Scheme === 'internet-facing')
            findings.push({ category: 'public', severity: 'info', account: s.account?.key, accountLabel: s.account?.label, resource: s.name, detail: 'ALB internet-facing', link: { view: 'resource', account: s.account?.key, needle: s.name } })
        } catch {
          /* best effort */
        }
      }),
  )

  // 4) Bucket S3 potenzialmente pubblici (policy pubblica o Public Access Block non completo).
  await Promise.all(
    services
      .filter((s) => s.aws?.type === 's3' && (s.aws.bucket || s.aws.name))
      .map(async (s) => {
        const Bucket = s.aws.bucket || s.aws.name
        try {
          const s3 = new S3Client(clientOpts(awsFor(s, accounts)))
          let pub = false
          try {
            const o = await s3.send(new GetBucketPolicyStatusCommand({ Bucket }))
            pub = Boolean(o.PolicyStatus?.IsPublic)
          } catch {
            /* nessuna policy o non leggibile */
          }
          if (!pub) {
            try {
              const o = await s3.send(new GetPublicAccessBlockCommand({ Bucket }))
              const c = o.PublicAccessBlockConfiguration
              pub = c ? !(c.BlockPublicAcls && c.BlockPublicPolicy && c.IgnorePublicAcls && c.RestrictPublicBuckets) : true
            } catch {
              pub = true // nessun Public Access Block configurato
            }
          }
          if (pub)
            findings.push({ category: 'public', severity: 'high', account: s.account?.key, accountLabel: s.account?.label, resource: s.name, detail: 'bucket S3 senza Public Access Block completo', link: { view: 'resource', account: s.account?.key, needle: s.name } })
        } catch {
          /* best effort */
        }
      }),
  )

  return findings
}

// Scadenze: certificati ACM entro 30 giorni (o già scaduti). Un pass per account.
export async function expiring(accounts) {
  const findings = []
  const now = Date.now()
  await Promise.all(
    Object.entries(accounts ?? {}).map(async ([key, acc]) => {
      try {
        const acm = new ACMClient(clientOpts(awsForAccount(acc)))
        let token
        do {
          const o = await acm.send(new ListCertificatesCommand({ NextToken: token, MaxItems: 100 }))
          for (const c of o.CertificateSummaryList ?? []) {
            let notAfter = c.NotAfter
            if (!notAfter) {
              try {
                notAfter = (await acm.send(new DescribeCertificateCommand({ CertificateArn: c.CertificateArn }))).Certificate?.NotAfter
              } catch {
                /* non leggibile */
              }
            }
            if (!notAfter) continue
            const days = Math.round((new Date(notAfter).getTime() - now) / DAY)
            if (days > 30) continue
            findings.push({
              category: 'expiring',
              severity: days <= 7 ? 'high' : 'medium',
              account: key,
              accountLabel: acc.label ?? key,
              resource: c.DomainName || c.CertificateArn,
              detail: days < 0 ? `certificato ACM scaduto da ${-days}g` : `certificato ACM scade tra ${days}g`,
            })
          }
          token = o.NextToken
        } while (token)
      } catch {
        /* acm:ListCertificates assente → niente questo controllo */
      }
    }),
  )
  return findings
}

// Igiene IAM: policy troppo larghe (wildcard), utenti senza MFA, access key non ruotate.
export async function iamHygiene(accounts) {
  const findings = []
  const now = Date.now()
  await Promise.all(
    Object.entries(accounts ?? {}).map(async ([key, acc]) => {
      const label = acc.label ?? key
      const iam = new IAMClient(clientOpts(awsForAccount(acc)))

      try {
        let marker
        do {
          const o = await iam.send(new ListPoliciesCommand({ Scope: 'Local', OnlyAttached: true, MaxItems: 200, Marker: marker }))
          for (const p of o.Policies ?? []) {
            if (!p.DefaultVersionId) continue
            try {
              const pv = await iam.send(new GetPolicyVersionCommand({ PolicyArn: p.Arn, VersionId: p.DefaultVersionId }))
              const stmts = parseStatements(JSON.parse(decodeURIComponent(pv.PolicyVersion?.Document ?? '{}')))
              const wildAction = stmts.some((s) => s.actions.includes('*'))
              const wildBoth = stmts.some((s) => s.actions.includes('*') && s.resources.includes('*'))
              if (wildBoth)
                findings.push({ category: 'iam', severity: 'high', account: key, accountLabel: label, resource: p.PolicyName, detail: 'policy con Action:"*" e Resource:"*" (admin)', link: { view: 'policy', account: key, arn: p.Arn } })
              else if (wildAction)
                findings.push({ category: 'iam', severity: 'medium', account: key, accountLabel: label, resource: p.PolicyName, detail: 'policy con Action:"*"', link: { view: 'policy', account: key, arn: p.Arn } })
            } catch {
              /* documento non parsabile */
            }
          }
          marker = o.IsTruncated ? o.Marker : undefined
        } while (marker)
      } catch {
        /* niente policy leggibili */
      }

      try {
        let marker
        do {
          const o = await iam.send(new ListUsersCommand({ Marker: marker, MaxItems: 200 }))
          await Promise.all(
            (o.Users ?? []).map(async (u) => {
              try {
                const mfa = await iam.send(new ListMFADevicesCommand({ UserName: u.UserName }))
                if ((mfa.MFADevices ?? []).length === 0)
                  findings.push({ category: 'iam', severity: 'medium', account: key, accountLabel: label, resource: u.UserName, detail: 'utente IAM senza MFA' })
              } catch {
                /* non leggibile */
              }
              try {
                const ak = await iam.send(new ListAccessKeysCommand({ UserName: u.UserName }))
                for (const k of ak.AccessKeyMetadata ?? []) {
                  if (k.Status !== 'Active' || !k.CreateDate) continue
                  const days = Math.round((now - new Date(k.CreateDate).getTime()) / DAY)
                  if (days >= 90)
                    findings.push({ category: 'iam', severity: days >= 180 ? 'high' : 'medium', account: key, accountLabel: label, resource: u.UserName, detail: `access key attiva da ${days}g (non ruotata)` })
                }
              } catch {
                /* non leggibile */
              }
            }),
          )
          marker = o.IsTruncated ? o.Marker : undefined
        } while (marker)
      } catch {
        /* iam:ListUsers assente → niente controlli su utenti */
      }
    }),
  )
  return findings
}

// Secret stantii: Secrets Manager non ruotati da ≥90 giorni. Solo metadati (data), mai il valore.
export async function staleSecrets(accounts) {
  const findings = []
  const now = Date.now()
  await Promise.all(
    Object.entries(accounts ?? {}).map(async ([key, acc]) => {
      try {
        const sm = new SecretsManagerClient(clientOpts(awsForAccount(acc)))
        let token
        do {
          const o = await sm.send(new ListSecretsCommand({ NextToken: token, MaxResults: 100 }))
          for (const s of o.SecretList ?? []) {
            const last = s.LastRotatedDate || s.LastChangedDate
            if (!last) continue
            const days = Math.round((now - new Date(last).getTime()) / DAY)
            if (days < 90) continue
            findings.push({
              category: 'secret',
              severity: days >= 180 ? 'medium' : 'low',
              account: key,
              accountLabel: acc.label ?? key,
              resource: s.Name,
              detail: s.RotationEnabled ? `secret non ruotato da ${days}g` : `secret non ruotato da ${days}g (rotazione off)`,
              link: { view: 'resource', account: key, needle: s.Name },
            })
          }
          token = o.NextToken
        } while (token)
      } catch {
        /* secretsmanager:ListSecrets assente → niente questo controllo */
      }
    }),
  )
  return findings
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2, info: 3 }

// Aggrega tutti i collector di findings, ordinati per severità.
export async function collectFindings(accounts, services) {
  const groups = await Promise.all([
    publicSurface(accounts, services).catch(() => []),
    expiring(accounts).catch(() => []),
    iamHygiene(accounts).catch(() => []),
    staleSecrets(accounts).catch(() => []),
  ])
  const findings = groups
    .flat()
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
  return { findings }
}
