// Estrae un nome umano-leggibile da un ARN di principal IAM/STS (chi ha fatto una modifica).
// Obiettivo: mostrare la PERSONA quando c'è; per le pipeline (CI/CodeBuild) mostrare un'etichetta
// PULITA (il pipeline), mai una sessione-macchina grezza tipo `AWSCodeBuild-<uuid>`. Puro/testabile.
//
//   iam::123:user/matteo                                    → matteo
//   assumed-role/AdminAccess/matteo@get-cato.com            → matteo@get-cato.com   (sessione SSO = persona)
//   assumed-role/cato-prod-backend-deploy/AWSCodeBuild-uuid → backend-deploy         (pipeline CodeBuild)
//   assumed-role/cato-staging-codebuild-iac/codebuild-iac-9 → codebuild-iac          (pipeline IaC)
//   assumed-role/cato-prod-gha-cron-deploy/GitHubActions    → GitHub Actions         (CI, default session)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// La sessione NON è una persona (è una macchina/pipeline)?
function isMachineSession(s) {
  return (
    /^AWSCodeBuild-/i.test(s) || // sessione di default di CodeBuild
    /^codebuild/i.test(s) || // session name custom delle pipeline IaC/deploy
    /^i-[0-9a-f]+$/i.test(s) || // id istanza EC2
    /^[0-9]+$/.test(s) || // id numerico
    UUID.test(s)
  )
}

// Ruolo → nome pipeline leggibile: via il prefisso ambiente (cato-<env>-).
function prettifyRole(role) {
  return (
    String(role || '')
      .replace(/^cato-/i, '')
      .replace(/^(production|prod|staging|stg|prd|management|mgmt)-/i, '') || null
  )
}

// Chi ha deployato, in forma LEGGIBILE. Il valore grezzo è spesso un'email (tag `deployedBy` =
// autore del commit) e in card mangiava tre righe:
//   81815192+matte97p@users.noreply.github.com → matte97p     (noreply GitHub: via l'id numerico)
//   ggiacometti@get-cato.com                   → ggiacometti
//   MatteoPerino                               → MatteoPerino (già un nome: invariato)
// Il valore completo resta nel tooltip della riga Build: qui accorciamo solo la resa.
export function shortActor(who) {
  const s = String(who ?? '').trim()
  if (!s) return null
  const at = s.indexOf('@')
  if (at <= 0) return s
  return s.slice(0, at).replace(/^\d+\+/, '') || s
}

export function principalName(arn) {
  if (!arn) return null
  const s = String(arn)
  const parts = s.split('/')
  if (s.includes(':assumed-role/')) {
    const role = parts[parts.length - 2]
    const session = parts[parts.length - 1]
    if (session === 'GitHubActions') return 'GitHub Actions' // CI, sessione di default (→ persona dopo il fix role-session-name)
    if (isMachineSession(session)) return prettifyRole(role) || 'CodeBuild' // pipeline: mostra il pipeline, non l'uuid
    return session || prettifyRole(role) // sessione persona (SSO)
  }
  // user/<name>, role/<name>, federated-user/<name>, ...
  return parts[parts.length - 1] || s
}
