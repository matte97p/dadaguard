// IAM policy explorer (read-only): quali policy customer-managed esistono, chi le usa (ruoli/utenti/
// gruppi) e a cosa danno accesso (azioni + risorse). Nessun valore di secret viene mai letto.
import {
  IAMClient,
  ListPoliciesCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  ListEntitiesForPolicyCommand,
} from '@aws-sdk/client-iam'
import { clientOpts, cleanAwsReason } from './runtime/awsClient.js'

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

// Un pattern Resource IAM "copre" la risorsa cercata (needle)? Ritorna { hit, broad }:
//  - '*' → copre tutto → hit AMPIO (broad): es. AdministratorAccess. Va mostrato a parte, altrimenti
//    (com'era prima) chi ha `Resource:"*"` non compariva MAI nella ricerca per risorsa.
//  - il needle compare nel pattern (ARN che nomina la risorsa) → hit puntuale.
// Euristica dichiarata ("menziona/copre"), NON una valutazione IAM completa. Pura/testabile.
export function resourceCovers(resource, needle) {
  const r = String(resource ?? '').toLowerCase()
  const q = String(needle ?? '').toLowerCase()
  if (!q) return { hit: false, broad: false }
  if (r === '*') return { hit: true, broad: true }
  if (r.includes(q)) return { hit: true, broad: false }
  return { hit: false, broad: false }
}

// Dato un elenco di statement Allow e il needle: statement che toccano la risorsa, azioni aggregate e
// se il match è SOLO via '*' (accesso ampio). broad=true → tutti i match passano da un wildcard pieno,
// nessuno nomina la risorsa. Puro/testabile.
export function matchStatements(statements, needle) {
  const matched = (statements ?? [])
    .map((s) => {
      let hit = false
      let broadOnly = true
      for (const r of s.resources ?? []) {
        const c = resourceCovers(r, needle)
        if (c.hit) {
          hit = true
          if (!c.broad) broadOnly = false
        }
      }
      return { s, hit, broad: hit && broadOnly }
    })
    .filter((x) => x.hit)
  return {
    hit: matched.length > 0,
    actions: [...new Set(matched.flatMap((x) => x.s.actions))],
    broad: matched.length > 0 && matched.every((x) => x.broad),
  }
}

// Statement Allow della versione di default di una policy gestita (per ARN). Best-effort: usato per
// leggere le policy AWS-managed agganciate ai permission set SSO (es. AdministratorAccess/ReadOnlyAccess),
// che altrimenti non avremmo modo di ispezionare. Richiede iam:GetPolicy + iam:GetPolicyVersion.
export async function policyStatements(iam, policyArn) {
  const pol = await iam.send(new GetPolicyCommand({ PolicyArn: policyArn }))
  const ver = pol.Policy?.DefaultVersionId
  if (!ver) return []
  const pv = await iam.send(new GetPolicyVersionCommand({ PolicyArn: policyArn, VersionId: ver }))
  try {
    return parseStatements(JSON.parse(decodeURIComponent(pv.PolicyVersion?.Document ?? '{}')))
  } catch {
    return []
  }
}

// Policy customer-managed per account (Scope=Local), ordinate per numero di attach. Best effort:
// un account che non risponde finisce con { error } invece di far fallire tutto.
export async function listPolicies(accounts, t = (k) => k) {
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
        out.push({ account: key, label: acc.label ?? key, color: acc.color, error: cleanAwsReason(err, t) })
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

function entitiesOf(ent) {
  return {
    roles: (ent.PolicyRoles ?? []).map((r) => r.RoleName),
    users: (ent.PolicyUsers ?? []).map((u) => u.UserName),
    groups: (ent.PolicyGroups ?? []).map((g) => g.GroupName),
  }
}

// Vista "per risorsa": quali policy customer-managed toccano una risorsa (match per sottostringa
// dell'ARN sul termine cercato, es. il nome del servizio) e — per ognuna — chi la usa e con quali
// azioni. On-demand: scansiona le policy dell'account, ma solo alla richiesta esplicita.
export async function accessToResource(accounts, accountKey, needle) {
  const acc = accounts?.[accountKey]
  if (!acc) throw new Error('account non trovato')
  const q = String(needle || '').toLowerCase()
  if (!q) return { needle, matches: [] }
  const iam = new IAMClient(clientOpts(awsForAccount(acc)))

  const policies = []
  let marker
  do {
    const o = await iam.send(new ListPoliciesCommand({ Scope: 'Local', MaxItems: 200, Marker: marker }))
    for (const p of o.Policies ?? []) policies.push({ arn: p.Arn, name: p.PolicyName, ver: p.DefaultVersionId })
    marker = o.IsTruncated ? o.Marker : undefined
  } while (marker)

  const matches = []
  await Promise.all(
    policies.map(async (p) => {
      if (!p.ver) return
      let statements = []
      try {
        const pv = await iam.send(new GetPolicyVersionCommand({ PolicyArn: p.arn, VersionId: p.ver }))
        statements = parseStatements(JSON.parse(decodeURIComponent(pv.PolicyVersion?.Document ?? '{}')))
      } catch {
        return
      }
      const m = matchStatements(statements, q)
      if (!m.hit) return
      let entities = { roles: [], users: [], groups: [] }
      try {
        entities = entitiesOf(await iam.send(new ListEntitiesForPolicyCommand({ PolicyArn: p.arn })))
      } catch {
        /* non elencabile */
      }
      matches.push({ policy: p.name, arn: p.arn, actions: m.actions, entities, broad: m.broad })
    }),
  )
  // Puntuali prima, poi ampi (via '*'), poi per nome: chi è scopato su questa risorsa in cima.
  matches.sort((a, b) => (a.broad === b.broad ? a.policy.localeCompare(b.policy) : a.broad ? 1 : -1))
  return { needle, matches }
}
