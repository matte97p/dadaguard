import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront'
import { clientOpts } from './awsClient.js'
import { awsState } from '../i18n.js'

// RuntimeProvider per CloudFront: stato della distribuzione + abilitata. Deployed+enabled = up.
// CloudFront è GLOBALE → endpoint us-east-1. Permesso: cloudfront:GetDistribution.
// Config: aws: { type: cloudfront, id: <distribution-id>, disabled?: true }
//   `disabled: true` = «lo so, l'ho spenta io»: solo così una distribuzione spenta non è un allarme.
export async function cloudfrontRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  const d = (await new CloudFrontClient(clientOpts({ ...aws, region: 'us-east-1' })).send(new GetDistributionCommand({ Id: cfg.id }))).Distribution
  if (!d) return { status: 'unknown', reason: t('cf.notfound') }
  const enabled = d.DistributionConfig?.Enabled !== false
  // Spenta di proposito ≠ spenta e basta, e la differenza non si legge da AWS: `Enabled: false` ha la
  // stessa faccia se l'ha deciso qualcuno o se l'ha spenta per sbaglio un apply. Quindi l'intento va
  // DICHIARATO — `aws: { type: cloudfront, disabled: true }`, come lo schedule DISABLED che le Lambda
  // leggono dallo state Terraform. Senza dichiarazione resta un allarme: un CDN di produzione che si
  // spegne è esattamente la cosa per cui esiste un watchdog. Cambia solo il testo, che prima diceva
  // «Deployed · disabilitata» e si contraddiceva da sé.
  const spentaDiProposito = !enabled && cfg.disabled === true
  const status = spentaDiProposito ? 'disabled' : !enabled ? 'degraded' : d.Status === 'Deployed' ? 'up' : 'degraded'
  // Endpoint pubblico (per la card): l'alias/CNAME reale se dichiarato (es. cdn.example.com), altrimenti
  // il dominio CloudFront di default (dxxxx.cloudfront.net). Dalla stessa GetDistribution → zero chiamate extra.
  const alias = d.DistributionConfig?.Aliases?.Items?.[0]
  const host = alias || d.DomainName
  const url = host ? `https://${host}` : null
  return {
    status,
    summary: enabled ? awsState(d.Status, t) : spentaDiProposito ? t('cf.disabled') : t('cf.off'),
    url,
  }
}
