import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per CloudFront: stato della distribuzione + abilitata. Deployed+enabled = up.
// CloudFront è GLOBALE → endpoint us-east-1. Permesso: cloudfront:GetDistribution.
// Config: aws: { type: cloudfront, id: <distribution-id> }
export async function cloudfrontRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const d = (await new CloudFrontClient(clientOpts({ ...aws, region: 'us-east-1' })).send(new GetDistributionCommand({ Id: cfg.id }))).Distribution
  if (!d) return { status: 'unknown', reason: t('cf.notfound') }
  const enabled = d.DistributionConfig?.Enabled !== false
  const status = d.Status === 'Deployed' && enabled ? 'up' : 'degraded'
  return { status, summary: enabled ? d.Status : `${d.Status} · ${t('cf.disabled')}` }
}
