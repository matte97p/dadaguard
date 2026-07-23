// Estrae un nome umano-leggibile da un ARN di principal IAM/STS (chi ha fatto una modifica).
// Puro/testabile. Esempi:
//   arn:aws:iam::123:user/matteo                                  → matteo
//   arn:aws:sts::123:assumed-role/AdminAccess/matteo@get-cato.com → matteo@get-cato.com (sessione SSO = persona)
//   arn:aws:sts::123:assumed-role/cato-prod-deploy/GitHubActions  → GitHubActions
//   arn:aws:sts::123:assumed-role/SomeRole/i-0abc… (o id numerico) → SomeRole (la sessione non è una persona)
export function principalName(arn) {
  if (!arn) return null
  const s = String(arn)
  const parts = s.split('/')
  if (s.includes(':assumed-role/')) {
    const role = parts[parts.length - 2]
    const session = parts[parts.length - 1]
    // La sessione è utile (persona/SSO) se non è un id macchina/numerico; altrimenti mostra il ruolo.
    if (session && !/^i-[0-9a-f]+$/i.test(session) && !/^[0-9]+$/.test(session)) return session
    return role || session || null
  }
  // user/<name>, role/<name>, federated-user/<name>, ...
  return parts[parts.length - 1] || s
}
