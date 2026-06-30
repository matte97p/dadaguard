// #8 AWS Organizations: invece di elencare gli account a mano, punta all'org e Dadaguard
// enumera i membri (ListAccounts) e sintetizza un account per ciascuno, col ruolo read-only
// assunto cross-account. Read-only. Il chiamante (creds dell'account management, o un ruolo
// che può organizations:ListAccounts) elenca; poi ogni membro si raggiunge via AssumeRole.
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations'
import { clientOpts } from './runtime/awsClient.js'

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// Pura/testabile: membri org + config → mappa { accountKey: {roleArn, externalId, region, regions, label} }.
// Solo account ATTIVI; salta quelli in `exclude` (per Id o Nome). roleName = ruolo RO in ogni membro.
export function buildOrgAccounts(members, org = {}) {
  const exclude = new Set((org.exclude ?? []).map(String))
  const roleName = org.roleName || 'dadaguard-readonly'
  const out = {}
  for (const m of members ?? []) {
    if (m.Status && m.Status !== 'ACTIVE') continue
    if (exclude.has(String(m.Id)) || exclude.has(String(m.Name))) continue
    const key = slug(m.Name || m.Id)
    out[key] = {
      label: m.Name || m.Id,
      accountId: m.Id,
      roleArn: `arn:aws:iam::${m.Id}:role/${roleName}`,
      externalId: org.externalId,
      region: org.region ?? (org.regions?.[0] ?? undefined),
      regions: org.regions, // sweep multi-region (#8)
    }
  }
  return out
}

export async function resolveOrgAccounts(org = {}) {
  const orgs = new OrganizationsClient(
    clientOpts({ profile: org.profile, roleArn: org.callerRoleArn, externalId: org.externalId, region: org.region }),
  )
  const members = []
  let NextToken
  do {
    const out = await orgs.send(new ListAccountsCommand({ NextToken }))
    members.push(...(out.Accounts ?? []))
    NextToken = out.NextToken
  } while (NextToken)
  return buildOrgAccounts(members, org)
}
