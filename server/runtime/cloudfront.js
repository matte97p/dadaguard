import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront'
import { clientOpts } from './awsClient.js'
import { awsState } from '../i18n.js'

// RuntimeProvider per CloudFront: stato della distribuzione + abilitata. Deployed+enabled = up.
// CloudFront è GLOBALE → endpoint us-east-1. Permesso: cloudfront:GetDistribution.
// Config: aws: { type: cloudfront, id: <distribution-id> }
export async function cloudfrontRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const d = (await new CloudFrontClient(clientOpts({ ...aws, region: 'us-east-1' })).send(new GetDistributionCommand({ Id: cfg.id }))).Distribution
  if (!d) return { status: 'unknown', reason: t('cf.notfound') }
  const enabled = d.DistributionConfig?.Enabled !== false
  // Una distribuzione SPENTA è una scelta, non un guasto: prima usciva `degraded` per sempre, col testo
  // «Deployed · disabilitata» — che si contraddice da sé (consegnata e spenta) e tiene un giallo fisso in
  // dashboard, cioè il modo migliore per insegnare a ignorarli. Stesso stato delle cron spente
  // (`disabled`), che il notificatore tratta come non-problema e non annuncia.
  const status = !enabled ? 'disabled' : d.Status === 'Deployed' ? 'up' : 'degraded'
  // Endpoint pubblico (per la card): l'alias/CNAME reale se dichiarato (es. cdn.example.com), altrimenti
  // il dominio CloudFront di default (dxxxx.cloudfront.net). Dalla stessa GetDistribution → zero chiamate extra.
  const alias = d.DistributionConfig?.Aliases?.Items?.[0]
  const host = alias || d.DomainName
  const url = host ? `https://${host}` : null
  return { status, summary: enabled ? awsState(d.Status, t) : t('cf.disabled'), url }
}
