import { S3Client, HeadBucketCommand, GetBucketPolicyStatusCommand } from '@aws-sdk/client-s3'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per bucket S3: esiste + è ESPOSTO pubblicamente? (segnale di sicurezza: un bucket
// pubblico è spesso un errore). Permessi: s3:ListBucket (HeadBucket), s3:GetBucketPolicyStatus.
// Config: aws: { type: s3, bucket: <nome> }
export async function s3Runtime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const s3 = new S3Client(clientOpts(aws))
  try {
    await s3.send(new HeadBucketCommand({ Bucket: cfg.bucket }))
  } catch (err) {
    // 404 = bucket inesistente (notfound); 403/throttle risalgono e li ripulisce cleanAwsReason a monte.
    if (err.name === 'NotFound' || err.name === 'NoSuchBucket' || err.$metadata?.httpStatusCode === 404) return { status: 'unknown', reason: t('s3.notfound') }
    throw err
  }
  let isPublic = false
  try {
    isPublic = Boolean((await s3.send(new GetBucketPolicyStatusCommand({ Bucket: cfg.bucket }))).PolicyStatus?.IsPublic)
  } catch {
    /* nessuna bucket policy → non pubblico via policy */
  }
  return isPublic ? { status: 'degraded', summary: t('s3.public') } : { status: 'up', summary: t('s3.private') }
}
