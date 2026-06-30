import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm'
import { clientOpts } from '../runtime/awsClient.js'

// #4 secret via SSM Parameter Store (runtime-truth, cloud-ready via AWS role).
// Legge SOLO i NOMI sotto un path (WithDecryption=false → niente valori, niente kms:Decrypt).
// Convenzione Cato: /cato/<env>/<componente>[/<job>]/<KEY>.
export async function ssmSecrets({ profile, roleArn, externalId, region, path }) {
  // Validazione leggera: un path malformato darebbe errori AWS oscuri a valle.
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error("path SSM non valido: deve iniziare con '/' (es. /myapp/staging/...)")
  }
  const ssm = new SSMClient(clientOpts({ profile, roleArn, externalId, region }))
  const prefix = path.replace(/\/$/, '') + '/'
  const names = []
  let token
  do {
    const out = await ssm.send(
      new GetParametersByPathCommand({
        Path: path,
        Recursive: true,
        WithDecryption: false,
        NextToken: token,
        MaxResults: 10, // 10 è il massimo consentito da GetParametersByPath: il loop sotto pagina tutto
      }),
    )
    for (const p of out.Parameters ?? []) names.push((p.Name ?? '').replace(prefix, ''))
    token = out.NextToken
  } while (token)

  return { count: names.length, names }
}
