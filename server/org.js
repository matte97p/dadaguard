// #8 AWS Organizations: invece di elencare gli account a mano, punta all'org e Dadaguard
// enumera i membri (ListAccounts) e sintetizza un account per ciascuno, col ruolo read-only
// assunto cross-account. Read-only. Il chiamante (creds dell'account management, o un ruolo
// che può organizations:ListAccounts) elenca; poi ogni membro si raggiunge via AssumeRole.
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { clientOpts } from './runtime/awsClient.js'

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// Pura/testabile: membri org + config → mappa { accountKey: {roleArn|inAccount, region, label, …} }.
// Solo account ATTIVI; salta quelli in `exclude` (per Id o Nome). roleName = ruolo RO in ogni membro.
//
// `selfAccountId` = l'account in cui Dadaguard STESSO gira (di norma il payer, che è anche quello che
// elenca l'organizzazione). Per quello non esiste un ruolo da assumere — e provarci fallisce con un
// `AccessDenied` che sembra un problema di permessi mentre è solo la ricetta sbagliata: si usa
// `inAccount: true`, cioè le credenziali dell'ambiente. Senza questo, abilitare la scoperta org
// produceva una card in errore per il payer, che è proprio l'account dove vive la spesa di Bedrock,
// Marketplace e CodeBuild.
export function buildOrgAccounts(members, org = {}, selfAccountId = null) {
  const exclude = new Set((org.exclude ?? []).map(String))
  const roleName = org.roleName || 'dadaguard-readonly'
  const out = {}
  for (const m of members ?? []) {
    if (m.Status && m.Status !== 'ACTIVE') continue
    if (exclude.has(String(m.Id)) || exclude.has(String(m.Name))) continue
    const key = slug(m.Name || m.Id)
    const self = selfAccountId && String(m.Id) === String(selfAccountId)
    out[key] = {
      label: m.Name || m.Id,
      accountId: m.Id,
      ...(self ? { inAccount: true } : { roleArn: `arn:aws:iam::${m.Id}:role/${roleName}`, externalId: org.externalId }),
      region: org.region ?? (org.regions?.[0] ?? undefined),
      regions: org.regions, // sweep multi-region (#8)
    }
  }
  return out
}

export async function resolveOrgAccounts(org = {}) {
  const creds = { profile: org.profile, roleArn: org.callerRoleArn, externalId: org.externalId, region: org.region }
  const orgs = new OrganizationsClient(clientOpts(creds))
  const members = []
  let NextToken
  do {
    const out = await orgs.send(new ListAccountsCommand({ NextToken }))
    members.push(...(out.Accounts ?? []))
    NextToken = out.NextToken
  } while (NextToken)
  // Chi siamo: serve per NON tentare un AssumeRole verso noi stessi. `sts:GetCallerIdentity` è gratis
  // e non richiede permessi. Se non risponde si prosegue senza: al massimo il proprio account resta
  // con un roleArn (comportamento di prima), non si rompe niente.
  let selfAccountId = org.selfAccountId ?? null
  if (!selfAccountId) {
    try {
      const sts = new STSClient(clientOpts(creds))
      selfAccountId = (await sts.send(new GetCallerIdentityCommand({})))?.Account ?? null
    } catch {
      /* niente identità: si prosegue come prima */
    }
  }
  return buildOrgAccounts(members, org, selfAccountId)
}
