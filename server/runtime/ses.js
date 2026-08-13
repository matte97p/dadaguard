import { metricValues } from './cw.js'
import { identityT } from '../i18n.js'
import { fmtCount } from '../util/format.js'

// RuntimeProvider SES (invio email). Metriche CloudWatch AWS/SES a livello account: volume inviato,
// bounce e complaint. Il segnale chiave è la DELIVERABILITY: AWS sospende l'invio se il bounce rate
// supera ~5% o il complaint rate ~0.1%. Finestra ampia di default (le email hanno volumi lenti).
// `aws: { type: ses }` (account-level, nessun identificatore). Permesso: cloudwatch:GetMetricData.
const DEFAULT_WINDOW_MIN = 1440 // 24h

export async function sesRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? identityT
  const win = cfg.windowMinutes ?? DEFAULT_WINDOW_MIN
  const m = await metricValues(
    aws,
    'AWS/SES',
    [],
    [
      ['send', 'Send', 'Sum'],
      ['bounce', 'Bounce', 'Sum'],
      ['complaint', 'Complaint', 'Sum'],
    ],
    win,
  )
  const hours = Math.round(win / 60)
  if (!m.send) return { status: 'idle', summary: t('ses.idle', { hours }) }
  const bounceRate = (m.bounce / m.send) * 100
  const complaintRate = (m.complaint / m.send) * 100
  // Soglie di reputazione AWS: oltre queste l'account rischia la sospensione.
  const BOUNCE_MAX = 5
  const COMPLAINT_MAX = 0.1
  const status = bounceRate > BOUNCE_MAX || complaintRate > COMPLAINT_MAX ? 'degraded' : 'up'
  const parts = [
    t('ses.sent', { n: fmtCount(Math.round(m.send)) }),
    t('ses.bounce', { p: bounceRate.toFixed(1) }),
    t('ses.complaint', { p: complaintRate.toFixed(2) }),
  ]
  const metrics = [
    { label: t('m.sends'), value: fmtCount(Math.round(m.send)) },
    { label: t('m.bounce'), value: `${bounceRate < 0.05 ? '0' : bounceRate.toFixed(1)}%`, tone: bounceRate > BOUNCE_MAX ? 'critical' : undefined },
    { label: t('m.complaint'), value: `${complaintRate < 0.01 ? '0' : complaintRate.toFixed(2)}%`, tone: complaintRate > COMPLAINT_MAX ? 'critical' : undefined },
  ]
  // Le percentuali senza le soglie non dicono se siamo sopra: e qui "sopra" significa che AWS può
  // sospendere l'invio, non che una metrica è brutta.
  const alert =
    status === 'degraded'
      ? t('ses.alert', {
          b: bounceRate.toFixed(1),
          c: complaintRate.toFixed(2),
          n: fmtCount(Math.round(m.send)),
          hours,
        }) + t('rule.fires', { regola: t('ses.regola', { bmax: BOUNCE_MAX, cmax: COMPLAINT_MAX }) })
      : undefined
  return { status, summary: `${parts.join(' · ')} (${hours}h)`, ...(alert ? { alert } : {}), metrics, window: `${hours}h` }
}
