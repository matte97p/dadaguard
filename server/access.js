import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam'
import { clientOpts } from './runtime/awsClient.js'

// Accesso per SUPERFICIE: quali voci dell'header ha senso mostrare al ruolo assunto. Invece di
// leggere le policy e interpretarle a mano (wildcard, Deny espliciti, NotAction, boundary… è
// reimplementare il motore IAM), chiediamo ad AWS di valutarle con SimulatePrincipalPolicy —
// read-only e GRATIS (le API IAM non si pagano, a differenza di Cost Explorer). Così l'header è
// pulito da subito, senza probe a pagamento né "apri la pagina e scopri l'errore".

// Azione "chiave" che gate-a ogni superficie. Se il ruolo non è autorizzato a questa in NESSUN
// account, la voce sparisce dall'header. Gate-ate solo le superfici che dipendono da una FAMIGLIA
// di permessi distinta (ce / servicequotas / iam / ec2) che un ruolo di monitoraggio può non avere:
// lì "negato = nascondi" è un segnale netto. Fuori di proposito, sempre visibili: Dashboard (vista
// base liveness/runtime), Sicurezza e Topologia — composite, degradano da sole (topology deriva dai
// servizi già risolti, security mostra i finding parziali), quindi non le nascondiamo a sproposito.
export const SURFACE_ACTIONS = {
  costs: ['ce:GetCostAndUsage'],
  waste: ['ec2:DescribeVolumes'],
  quotas: ['servicequotas:ListServiceQuotas'],
  iam: ['iam:ListPolicies'],
}

// I permessi IAM non sono stato runtime (cambiano di rado) → non li rivalutiamo a ogni refresh come
// la liveness STS. TTL breve così che, se sistemi una policy, la voce ricompaia in fretta.
// Override: DADAGUARD_ACCESS_TTL_MS.
const ACCESS_TTL_MS = Number(process.env.DADAGUARD_ACCESS_TTL_MS) || 120000
const surfaceCache = new Map() // principalArn → { at, allowed: Set<action> | null }

const ALL_ACTIONS = [...new Set(Object.values(SURFACE_ACTIONS).flat())]

// STS GetCallerIdentity torna l'ARN della SESSIONE, ma SimulatePrincipalPolicy vuole l'ARN del
// PRINCIPAL (ruolo/utente). Converte:
//   arn:aws:sts::123:assumed-role/RoleName/session → arn:aws:iam::123:role/RoleName
// Gli ARN di utente/ruolo IAM sono già validi come sorgente → passano invariati. root e
// federated-user non sono simulabili → null (in aggregazione conta come 'unknown': mostriamo tutto).
export function principalArnForSimulation(callerArn) {
  if (!callerArn) return null
  const assumed = callerArn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\/.+$/)
  if (assumed) return `arn:aws:iam::${assumed[1]}:role/${assumed[2]}`
  if (/^arn:aws:iam::\d+:(user|role)\//.test(callerArn)) return callerArn
  return null // root, federated-user, formati inattesi → non simulabile
}

// Simula le azioni chiave contro il principal assunto in un account. Ritorna il Set delle azioni
// consentite, oppure null se non possiamo saperlo (principal non simulabile, o il ruolo read-only
// non ha iam:SimulatePrincipalPolicy). null ≠ negato: mai trattato come deny in aggregazione.
export async function probeSurfaces(aws, callerArn) {
  const principal = principalArnForSimulation(callerArn)
  if (!principal) return null
  const hit = surfaceCache.get(principal)
  if (hit && Date.now() - hit.at < ACCESS_TTL_MS) return hit.allowed
  try {
    const iam = new IAMClient(clientOpts({ ...aws, region: 'us-east-1' })) // IAM è globale → us-east-1
    const allowed = new Set()
    let marker
    do {
      const res = await iam.send(
        new SimulatePrincipalPolicyCommand({ PolicySourceArn: principal, ActionNames: ALL_ACTIONS, Marker: marker }),
      )
      for (const r of res.EvaluationResults ?? []) {
        if (r.EvalDecision === 'allowed') allowed.add(r.EvalActionName)
      }
      marker = res.IsTruncated ? res.Marker : undefined
    } while (marker)
    surfaceCache.set(principal, { at: Date.now(), allowed })
    return allowed
  } catch {
    // Tipico: il ruolo read-only non ha iam:SimulatePrincipalPolicy → non possiamo decidere: unknown.
    // Cachiamo anche il null: è un permesso che non arriverà, inutile ritentarlo a ogni refresh.
    surfaceCache.set(principal, { at: Date.now(), allowed: null })
    return null
  }
}

// Aggrega i permessi di più account in uno stato per superficie:
//   'allowed' — almeno un account consente (ne basta uno: le pagine sono multi-account)
//   'denied'  — simulato ovunque, negato ovunque → l'header nasconde la voce
//   'unknown' — nessun account era simulabile → non sappiamo, mostra (default sicuro)
// `perAccountAllowed` = array di (Set<action> | null), uno per account.
export function aggregateSurfaces(perAccountAllowed, actions = SURFACE_ACTIONS) {
  const out = {}
  for (const [surface, acts] of Object.entries(actions)) {
    let anyKnown = false
    let anyAllowed = false
    for (const allowed of perAccountAllowed) {
      if (!allowed) continue // null → unknown per questo account: non conta come deny
      anyKnown = true
      if (acts.some((a) => allowed.has(a))) anyAllowed = true
    }
    out[surface] = !anyKnown ? 'unknown' : anyAllowed ? 'allowed' : 'denied'
  }
  return out
}
