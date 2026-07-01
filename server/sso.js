// Accesso "umano" reale: AWS Identity Center (SSO). Le persone non sono IAM user/group ma membri
// della directory, a cui vengono assegnati dei permission set su certi account; ogni assegnazione
// si materializza come ruolo AWSReservedSSO_* nell'account. Qui leggiamo permission set →
// utenti/gruppi assegnati → account. Sola lettura. L'istanza Identity Center vive in un solo account
// (il management): la troviamo provando gli account configurati.
import {
  SSOAdminClient,
  ListInstancesCommand,
  ListPermissionSetsCommand,
  DescribePermissionSetCommand,
  ListAccountsForProvisionedPermissionSetCommand,
  ListAccountAssignmentsCommand,
  GetInlinePolicyForPermissionSetCommand,
} from '@aws-sdk/client-sso-admin'
import { IdentitystoreClient, DescribeUserCommand, DescribeGroupCommand, ListGroupMembershipsCommand } from '@aws-sdk/client-identitystore'
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations'
import { clientOpts } from './runtime/awsClient.js'
import { parseStatements } from './iam.js'

const SSO_REGION = process.env.DADAGUARD_SSO_REGION || 'eu-central-1' // dove vive Identity Center

function credsFor(acc) {
  return { profile: acc?.profile, roleArn: acc?.roleArn, externalId: acc?.externalId, region: SSO_REGION }
}

// Prova gli account finché uno espone un'istanza Identity Center (di norma il management).
async function findInstance(accounts) {
  // Account configurati + credenziali "locali" del task (nessun profile/roleArn → default chain).
  // Un account MEMBRO vede l'istanza (ListInstances) ma non può gestirla: validiamo con una
  // ListPermissionSets, così scegliamo l'account con i permessi SSO admin (management/delegated) e
  // NON falliamo con 403 scegliendo un account che vede solo l'istanza. Zero-config in prod via task role.
  const candidates = [...Object.entries(accounts ?? {}), ['__task__', {}]]
  for (const [key, acc] of candidates) {
    try {
      const sso = new SSOAdminClient(clientOpts(credsFor(acc)))
      const inst = (await sso.send(new ListInstancesCommand({}))).Instances?.[0]
      if (!inst?.InstanceArn) continue
      await sso.send(new ListPermissionSetsCommand({ InstanceArn: inst.InstanceArn, MaxResults: 1 }))
      return { acc, key, instanceArn: inst.InstanceArn, identityStoreId: inst.IdentityStoreId }
    } catch {
      /* niente istanza o permessi SSO insufficienti su questo account → prova il prossimo */
    }
  }
  return null
}

// account id (12 cifre dal roleArn) → label leggibile (fallback quando Organizations non è leggibile).
function accountLabels(accounts) {
  const m = {}
  for (const [key, acc] of Object.entries(accounts ?? {})) {
    const id = acc.roleArn?.match(/:(\d{12}):/)?.[1]
    if (id) m[id] = acc.label ?? key
  }
  return m
}

// Nomi account dall'organizzazione (id → nome) così i tag non mostrano numeri criptici. Best effort:
// serve organizations:ListAccounts (l'account che ospita SSO è di norma anche l'org management).
async function orgAccountNames(acc) {
  const m = {}
  try {
    const org = new OrganizationsClient(clientOpts({ ...credsFor(acc), region: 'us-east-1' }))
    let t
    do {
      const o = await org.send(new ListAccountsCommand({ NextToken: t, MaxResults: 20 }))
      for (const a of o.Accounts ?? []) if (a.Id) m[a.Id] = a.Name || a.Id
      t = o.NextToken
    } while (t)
  } catch {
    /* organizations:ListAccounts non concesso → si ripiega su label/id */
  }
  return m
}

// Risolutore di principal con cache: per un USER ritorna { name }, per un GROUP ritorna anche i
// { members } (chi c'è dentro), così un'assegnazione a gruppo non resta opaca. Best effort sui membri.
function makeResolver(idstore, identityStoreId) {
  const cache = new Map()
  return async (type, id) => {
    const k = `${type}:${id}`
    if (cache.has(k)) return cache.get(k)
    let out = { name: id }
    try {
      if (type === 'USER') {
        const u = await idstore.send(new DescribeUserCommand({ IdentityStoreId: identityStoreId, UserId: id }))
        out = { name: u.UserName || u.DisplayName || id }
      } else {
        const g = await idstore.send(new DescribeGroupCommand({ IdentityStoreId: identityStoreId, GroupId: id }))
        // members: undefined = non abbiamo potuto leggerli (manca ListGroupMemberships); [] = gruppo
        // davvero vuoto; [...] = i membri. Distinguere i due casi vuoti evita di dire "non leggibili"
        // quando il gruppo semplicemente non ha nessuno dentro.
        let members
        try {
          const list = []
          let mt
          do {
            const o = await idstore.send(new ListGroupMembershipsCommand({ IdentityStoreId: identityStoreId, GroupId: id, NextToken: mt, MaxResults: 100 }))
            for (const m of o.GroupMemberships ?? []) {
              const uid = m.MemberId?.UserId
              if (!uid) continue
              try {
                list.push((await idstore.send(new DescribeUserCommand({ IdentityStoreId: identityStoreId, UserId: uid }))).UserName || uid)
              } catch {
                /* membro non leggibile */
              }
            }
            mt = o.NextToken
          } while (mt)
          members = list.sort() // riuscito: [] se vuoto, altrimenti l'elenco
        } catch {
          members = undefined // identitystore:ListGroupMemberships non concesso → non sappiamo chi c'è
        }
        out = { name: g.DisplayName || id, members }
      }
    } catch {
      /* directory non leggibile → resta l'id */
    }
    cache.set(k, out)
    return out
  }
}

export async function ssoAccess(accounts) {
  const inst = await findInstance(accounts)
  if (!inst) return { available: false, permissionSets: [] }

  const sso = new SSOAdminClient(clientOpts(credsFor(inst.acc)))
  const idstore = new IdentitystoreClient(clientOpts(credsFor(inst.acc)))
  const labels = accountLabels(accounts)
  const orgNames = await orgAccountNames(inst.acc)
  const nameOf = (id) => orgNames[id] || labels[id] || id

  const resolve = makeResolver(idstore, inst.identityStoreId)

  // tutti i permission set dell'istanza
  const psArns = []
  let t
  do {
    const o = await sso.send(new ListPermissionSetsCommand({ InstanceArn: inst.instanceArn, NextToken: t, MaxResults: 100 }))
    psArns.push(...(o.PermissionSets ?? []))
    t = o.NextToken
  } while (t)

  const permissionSets = []
  await Promise.all(
    psArns.map(async (psArn) => {
      let name = psArn
      try {
        name = (await sso.send(new DescribePermissionSetCommand({ InstanceArn: inst.instanceArn, PermissionSetArn: psArn }))).PermissionSet?.Name || psArn
      } catch {
        /* nome non leggibile */
      }
      const acctIds = []
      let at
      do {
        const o = await sso.send(
          new ListAccountsForProvisionedPermissionSetCommand({ InstanceArn: inst.instanceArn, PermissionSetArn: psArn, NextToken: at, MaxResults: 100 }),
        )
        acctIds.push(...(o.AccountIds ?? []))
        at = o.NextToken
      } while (at)

      const assignments = []
      await Promise.all(
        acctIds.map(async (acctId) => {
          try {
            let aat
            do {
              const o = await sso.send(
                new ListAccountAssignmentsCommand({ InstanceArn: inst.instanceArn, AccountId: acctId, PermissionSetArn: psArn, NextToken: aat, MaxResults: 100 }),
              )
              for (const a of o.AccountAssignments ?? []) {
                const p = await resolve(a.PrincipalType, a.PrincipalId)
                assignments.push({ account: nameOf(acctId), type: (a.PrincipalType || '').toLowerCase(), name: p.name, members: p.members })
              }
              aat = o.NextToken
            } while (aat)
          } catch {
            /* nessuna assegnazione leggibile su questo account */
          }
        }),
      )
      if (assignments.length) permissionSets.push({ name, assignments })
    }),
  )
  permissionSets.sort((a, b) => a.name.localeCompare(b.name))
  return { available: true, permissionSets }
}

// Lato SSO della vista "per risorsa": quali permission set concedono accesso al `needle` (match negli
// ARN Resource della loro INLINE policy — dove finiscono gli accessi specifici tipo rds-db:connect) e
// chi li detiene. Completa la lente unendo l'accesso umano (SSO) a quello dei ruoli/servizi (policy IAM).
export async function ssoAccessToResource(accounts, needle) {
  const q = String(needle || '').toLowerCase()
  if (!q) return []
  const inst = await findInstance(accounts)
  if (!inst) return []

  const sso = new SSOAdminClient(clientOpts(credsFor(inst.acc)))
  const idstore = new IdentitystoreClient(clientOpts(credsFor(inst.acc)))
  const labels = accountLabels(accounts)
  const orgNames = await orgAccountNames(inst.acc)
  const nameOf = (id) => orgNames[id] || labels[id] || id
  const resolve = makeResolver(idstore, inst.identityStoreId)

  const psArns = []
  let t
  do {
    const o = await sso.send(new ListPermissionSetsCommand({ InstanceArn: inst.instanceArn, NextToken: t, MaxResults: 100 }))
    psArns.push(...(o.PermissionSets ?? []))
    t = o.NextToken
  } while (t)

  const matches = []
  await Promise.all(
    psArns.map(async (psArn) => {
      let stmts = []
      try {
        const inl = await sso.send(new GetInlinePolicyForPermissionSetCommand({ InstanceArn: inst.instanceArn, PermissionSetArn: psArn }))
        if (!inl.InlinePolicy) return
        stmts = parseStatements(JSON.parse(inl.InlinePolicy))
      } catch {
        return
      }
      const hit = stmts.filter((s) => s.resources.some((r) => r.toLowerCase().includes(q)))
      if (!hit.length) return
      const actions = [...new Set(hit.flatMap((s) => s.actions))]
      let name = psArn
      try {
        name = (await sso.send(new DescribePermissionSetCommand({ InstanceArn: inst.instanceArn, PermissionSetArn: psArn }))).PermissionSet?.Name || psArn
      } catch {
        /* nome non leggibile */
      }
      const assignments = []
      const acctIds = []
      let at
      do {
        const o = await sso.send(new ListAccountsForProvisionedPermissionSetCommand({ InstanceArn: inst.instanceArn, PermissionSetArn: psArn, NextToken: at, MaxResults: 100 }))
        acctIds.push(...(o.AccountIds ?? []))
        at = o.NextToken
      } while (at)
      await Promise.all(
        acctIds.map(async (acctId) => {
          try {
            let aat
            do {
              const o = await sso.send(new ListAccountAssignmentsCommand({ InstanceArn: inst.instanceArn, AccountId: acctId, PermissionSetArn: psArn, NextToken: aat, MaxResults: 100 }))
              for (const a of o.AccountAssignments ?? []) {
                const p = await resolve(a.PrincipalType, a.PrincipalId)
                assignments.push({ account: nameOf(acctId), type: (a.PrincipalType || '').toLowerCase(), name: p.name, members: p.members })
              }
              aat = o.NextToken
            } while (aat)
          } catch {
            /* nessuna assegnazione leggibile */
          }
        }),
      )
      matches.push({ permissionSet: name, actions, assignments })
    }),
  )
  matches.sort((a, b) => a.permissionSet.localeCompare(b.permissionSet))
  return matches
}
