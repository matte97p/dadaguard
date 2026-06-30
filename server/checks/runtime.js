// Segnale #3 — runtime: lo stato reale del compute combacia col desiderato?
// Dispatch su service.aws.type → un RuntimeProvider per tipo.
// Aggiungere un provider = importarlo e aggiungere una entry in PROVIDERS.
import { ecsRuntime } from '../runtime/ecs.js'
import { asgRuntime } from '../runtime/asg.js'
import { lambdaRuntime } from '../runtime/lambda.js'
import { rdsRuntime } from '../runtime/rds.js'
import { albRuntime } from '../runtime/alb.js'
import { ec2Runtime } from '../runtime/ec2.js'
import { sqsRuntime } from '../runtime/sqs.js'
import { dynamodbRuntime } from '../runtime/dynamodb.js'
import { elasticacheRuntime } from '../runtime/elasticache.js'
import { acmRuntime } from '../runtime/acm.js'
import { apigatewayRuntime } from '../runtime/apigateway.js'
import { sfnRuntime } from '../runtime/sfn.js'
import { eksRuntime } from '../runtime/eks.js'
import { cloudfrontRuntime } from '../runtime/cloudfront.js'
import { snsRuntime } from '../runtime/sns.js'
import { s3Runtime } from '../runtime/s3.js'
import { kinesisRuntime } from '../runtime/kinesis.js'

export const key = 'runtime'

const PROVIDERS = {
  ecs: ecsRuntime,
  asg: asgRuntime,
  lambda: lambdaRuntime,
  rds: rdsRuntime,
  alb: albRuntime,
  ec2: ec2Runtime,
  sqs: sqsRuntime,
  dynamodb: dynamodbRuntime,
  elasticache: elasticacheRuntime,
  acm: acmRuntime,
  apigateway: apigatewayRuntime,
  sfn: sfnRuntime,
  eks: eksRuntime,
  cloudfront: cloudfrontRuntime,
  sns: snsRuntime,
  s3: s3Runtime,
  kinesis: kinesisRuntime,
}

export async function run(service, ctx) {
  const cfg = service.aws
  if (!cfg?.type) return null // segnale non applicabile a questo servizio
  const t = ctx?.t ?? ((k) => k)

  const provider = PROVIDERS[cfg.type]
  if (!provider) {
    return { key, status: 'unknown', reason: t('runtime.unsupported', { type: cfg.type }) }
  }

  // profilo dall'account; region: override per-servizio (cfg.region) o dell'account.
  const aws = {
    profile: ctx?.profile,
    roleArn: ctx?.roleArn,
    externalId: ctx?.externalId,
    region: cfg.region ?? ctx?.region,
  }
  // stato dello schedule EventBridge (dallo state TF) → per distinguere cron disabilitate.
  // `t` viaggia con extra così ogni provider parla nella lingua scelta.
  const extra = { scheduleState: ctx?.tf?.schedules?.[cfg.function], t }

  try {
    return { key, ...(await provider(cfg, aws, extra)) }
  } catch (err) {
    // creds mancanti, region assente, accesso negato, risorsa non trovata:
    // degrada con grazia, non rompere la card.
    return { key, status: 'unknown', reason: err.message }
  }
}
