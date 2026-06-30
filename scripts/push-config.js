// Pubblica la watchlist locale (services.yaml) sull'istanza cloud, in un comando:
//   valida → SSM SecureString → forza il redeploy ECS (il task rilegge SSM all'avvio).
//
// On-principle: nessun pannello, nessun write dall'app. Lo lancia l'OPERATORE con le sue
// credenziali (profilo/SSO), come `terraform apply`. La config (con l'externalId) resta sul
// disco + SSM, mai in git.
//
// Uso:   npm run config:push                 # usa ./services.yaml
//        npm run config:push -- path.yaml    # file esplicito
// Config via env (default generici; i tuoi valori in un .env locale, niente ID nel repo):
//   AWS_PROFILE, AWS_REGION (default eu-central-1)
//   DADAGUARD_SSM_PARAM   (default /dadaguard/services-yaml)
//   DADAGUARD_CLUSTER     (default dadaguard)
//   DADAGUARD_SERVICE     (default dadaguard)
//   DADAGUARD_KMS_KEY     (opz.: KeyId/alias per la SecureString; default = chiave SSM di AWS)
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm'
import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs'
import { clientOpts } from '../server/runtime/awsClient.js'

const file = process.argv[2] || 'services.yaml'
const param = process.env.DADAGUARD_SSM_PARAM || '/dadaguard/services-yaml'
const cluster = process.env.DADAGUARD_CLUSTER || 'dadaguard'
const service = process.env.DADAGUARD_SERVICE || 'dadaguard'
const region = process.env.AWS_REGION || 'eu-central-1'
const kmsKey = process.env.DADAGUARD_KMS_KEY || undefined
const aws = { profile: process.env.AWS_PROFILE, region } // l'operatore usa le SUE creds (no roleArn)

const die = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

// 1) VALIDA prima di toccare il cloud: una config rotta non deve mai raggiungere il task live.
let raw
try {
  raw = readFileSync(file, 'utf8')
} catch {
  die(`file non trovato: ${file} (curalo in locale: npm run dev → "Scopri servizi")`)
}
let doc
try {
  doc = yaml.load(raw) ?? {}
} catch (e) {
  die(`YAML non valido: ${e.message}`)
}
const accounts = doc.accounts ?? {}
const services = doc.services ?? []
if (typeof accounts !== 'object' || Array.isArray(accounts)) die("config non valido: 'accounts' deve essere un oggetto")
if (!Array.isArray(services)) die("config non valido: 'services' deve essere una lista")
services.forEach((s, i) => {
  if (!s || typeof s !== 'object' || !s.name) die(`config non valido: services[${i}] manca del campo 'name'`)
})
console.log(`✓ config valida: ${Object.keys(accounts).length} account, ${services.length} servizi`)

// 2) PUSH su SSM (SecureString, overwrite). Il valore non viene loggato.
try {
  await new SSMClient(clientOpts(aws)).send(
    new PutParameterCommand({
      Name: param,
      Value: raw,
      Type: 'SecureString',
      Overwrite: true,
      ...(kmsKey ? { KeyId: kmsKey } : {}),
    }),
  )
  console.log(`✓ pubblicata su SSM ${param}`)
} catch (e) {
  die(`SSM PutParameter fallito: ${e.message}`)
}

// 3) REDEPLOY ECS: il container legge DADAGUARD_CONFIG da SSM all'avvio → serve un nuovo task.
try {
  await new ECSClient(clientOpts(aws)).send(
    new UpdateServiceCommand({ cluster, service, forceNewDeployment: true }),
  )
  console.log(`✓ redeploy forzato di ${cluster}/${service} — il nuovo task caricherà la config in ~1-2 min`)
} catch (e) {
  die(`ECS UpdateService fallito: ${e.message} (config GIÀ su SSM: rilancia il redeploy a mano o ri-esegui)`)
}

console.log('Fatto. Ricarica la dashboard tra un paio di minuti.')
