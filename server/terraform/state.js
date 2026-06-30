import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { clientOpts } from '../runtime/awsClient.js'
import { log } from '../log.js'

// Legge gli state Terraform da un bucket S3. Estrae:
//  - managed:   Set di identificatori gestiti per kind (lambda/ecs/asg) → #7 risorse non gestite
//  - attrs:     attributi chiave dichiarati per risorsa → #6 drift leggero
//  - schedules: stato degli EventBridge Scheduler per funzione → distinguere cron disabilitate
// Read-only.
const TYPE_TO_KIND = {
  aws_lambda_function: {
    kind: 'lambda',
    id: (a) => a.function_name,
    attrs: (a) => ({
      runtime: a.runtime,
      memory_size: a.memory_size,
      timeout: a.timeout,
      handler: a.handler,
    }),
  },
  aws_ecs_service: { kind: 'ecs', id: (a) => a.name },
  aws_autoscaling_group: { kind: 'asg', id: (a) => a.name },
  // RDS/ALB/EC2 → #7 risorse non gestite per questi tipi. L'id usa l'identificatore
  // "naturale" di ogni risorsa (lo stesso che usa il confronto con i candidati discovery).
  aws_db_instance: { kind: 'rds', id: (a) => a.identifier ?? a.id },
  aws_rds_cluster: { kind: 'rds', id: (a) => a.cluster_identifier ?? a.id },
  aws_lb: { kind: 'alb', id: (a) => a.name },
  aws_alb: { kind: 'alb', id: (a) => a.name },
  aws_instance: { kind: 'ec2', id: (a) => a.id },
}

function lambdaNameFromArn(arn) {
  if (!arn || !arn.includes(':function:')) return null
  return arn.split(':function:')[1].split(':')[0] // togli eventuale suffisso :version
}

export async function managedResources({ profile, roleArn, externalId, region, stateBucket }) {
  const s3 = new S3Client(clientOpts({ profile, roleArn, externalId, region }))

  const keys = []
  let token
  try {
    do {
      const out = await s3.send(
        new ListObjectsV2Command({ Bucket: stateBucket, ContinuationToken: token }),
      )
      for (const o of out.Contents ?? []) if (o.Key.endsWith('.tfstate')) keys.push(o.Key)
      token = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (token)
  } catch (err) {
    // Bucket irraggiungibile/permessi: errore chiaro al chiamante (che lo logga e degrada),
    // invece di un crash opaco a metà loop.
    throw new Error(`state bucket '${stateBucket}' non leggibile: ${err.message}`)
  }

  const managed = { lambda: new Set(), ecs: new Set(), asg: new Set(), rds: new Set(), alb: new Set(), ec2: new Set() }
  const attrs = { lambda: {} }
  const schedules = {} // functionName -> "ENABLED" | "DISABLED"

  await Promise.all(
    keys.map(async (Key) => {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: stateBucket, Key }))
        const st = JSON.parse(await obj.Body.transformToString())
        for (const r of st.resources ?? []) {
          if (r.mode === 'data') continue

          if (r.type === 'aws_scheduler_schedule') {
            for (const i of r.instances ?? []) {
              const a = i.attributes || {}
              const fn = lambdaNameFromArn(a.target?.[0]?.arn)
              if (fn && a.state) schedules[fn] = a.state
            }
            continue
          }

          const map = TYPE_TO_KIND[r.type]
          if (!map) continue
          for (const i of r.instances ?? []) {
            const a = i.attributes || {}
            const id = map.id(a)
            if (!id) continue
            managed[map.kind].add(id)
            if (map.attrs) (attrs[map.kind] ??= {})[id] = map.attrs(a)
          }
        }
      } catch (err) {
        // State illeggibile (JSON malformato, fetch fallito): logga il file e salta,
        // così il drift non si rompe in silenzio ma il problema è diagnosticabile.
        log.error('state TF illeggibile', { key: Key, err: err.message })
      }
    }),
  )

  return { managed, attrs, schedules, stateCount: keys.length }
}
