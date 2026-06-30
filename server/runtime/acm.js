import { ACMClient, DescribeCertificateCommand } from '@aws-sdk/client-acm'
import { clientOpts } from './awsClient.js'

// RuntimeProvider per certificati ACM: giorni alla scadenza. up se lontano, degraded sotto soglia
// (warnDays, default 30), down se scaduto. Previene il classico "il cert è scaduto".
// Permesso: acm:DescribeCertificate. Config: aws: { type: acm, arn: <cert-arn>, warnDays?: 30 }
export async function acmRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? ((k) => k)
  if (!cfg.arn) return { status: 'unknown', reason: t('acm.noarn') }

  const out = await new ACMClient(clientOpts(aws)).send(new DescribeCertificateCommand({ CertificateArn: cfg.arn }))
  const c = out.Certificate
  if (!c) return { status: 'unknown', reason: t('acm.notfound') }
  if (!c.NotAfter) return { status: 'unknown', reason: t('acm.nodate') } // cert non ancora emesso/pending

  const days = Math.floor((new Date(c.NotAfter).getTime() - Date.now()) / 86400000)
  const warn = cfg.warnDays ?? 30
  const domain = c.DomainName ?? ''
  const status = days < 0 ? 'down' : days <= warn ? 'degraded' : 'up'
  const summary = days < 0 ? t('acm.expired', { domain }) : t('acm.expiry', { domain, days })
  return { status, summary, daysToExpiry: days }
}
