// IAM policy explorer (read-only): quali policy customer-managed esistono, chi le usa (ruoli/utenti/
// gruppi) e a cosa danno accesso (azioni + risorse). Nessun valore di secret viene mai letto.
import {
  IAMClient,
  ListPoliciesCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  ListEntitiesForPolicyCommand,
} from '@aws-sdk/client-iam'
import { clientOpts } from './runtime/awsClient.js'

// IAM è globale: la region non conta, ma il client ne vuole una. Credenziali dall'account.
function awsForAccount(acc) {
  return {
    profile: acc?.profile,
    roleArn: acc?.roleArn,
    externalId: acc?.externalId,
    region: acc?.region || 'us-east-1',
  }
}

// Statement Allow → { actions[], resources[] } (puro, testabile). Normalizza stringa|array.
export function parseStatements(doc) {
  const stmts = Array.isArray(doc?.Statement) ? doc.Statement : [doc?.Statement].filter(Boolean)
  return stmts
    .filter((s) => (s.Effect ?? 'Allow') === 'Allow')
    .map((s) => ({
      actions: [].concat(s.Action ?? []).filter((a) => typeof a === 'string'),
      resources: [].concat(s.Resource ?? []).filter((r) => typeof r === 'string'),
    }))
}

// Policy customer-managed per account (Scope=Local), ordinate per numero di attach. Best effort:
// un account che non risponde finisce con { error } invece di far fallire tutto.
export async function listPolicies(accounts) {
  const out = []
  await Promise.all(
    Object.entries(accounts ?? {}).map(async ([key, acc]) => {
      try {
        const iam = new IAMClient(clientOpts(awsForAccount(acc)))
        const policies = []
        let marker
        do {
          const o = await iam.send(new ListPoliciesCommand({ Scope: 'Local', MaxItems: 200, Marker: marker }))
          for (const p of o.Policies ?? [])
            policies.push({ arn: p.Arn, name: p.PolicyName, attachments: p.AttachmentCount ?? 0 })
          marker = o.IsTruncated ? o.Marker : undefined
        } while (marker)
        policies.sort((a, b) => b.attachments - a.attachments || a.name.localeCompare(b.name))
        out.push({ account: key, label: acc.label ?? key, color: acc.color, policies })
      } catch (err) {
        out.push({ account: key, label: acc.label ?? key, color: acc.color, error: err.message })
      }
    }),
  )
  return { accounts: out }
}

// Dettaglio di una policy: cosa concede (statement della versione di default) + chi la usa.
export async function policyDetail(accounts, accountKey, policyArn) {
  const acc = accounts?.[accountKey]
  if (!acc) throw new Error('account non trovato')
  const iam = new IAMClient(clientOpts(awsForAccount(acc)))

  const pol = await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }))
  let statements = []
  const ver = pol.Policy?.DefaultVersionId
  if (ver) {
    const pv = await iam.send(new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: ver }))
    try {
      statements = parseStatements(JSON.parse(decodeURIComponent(pv.PolicyVersion?.Document ?? '{}')))
    } catch {
      /* documento non parsabile */
    }
  }

  const ent = await iam.send(new ListEntitiesForPolicyCommand({ PolicyArn: policyArn }))
  return {
    name: pol.Policy?.PolicyName,
    description: pol.Policy?.Description ?? null,
    attachments: pol.Policy?.AttachmentCount ?? 0,
    statements,
    entities: {
      roles: (ent.PolicyRoles ?? []).map((r) => r.RoleName),
      users: (ent.PolicyUsers ?? []).map((u) => u.UserName),
      groups: (ent.PolicyGroups ?? []).map((g) => g.GroupName),
    },
  }
}
