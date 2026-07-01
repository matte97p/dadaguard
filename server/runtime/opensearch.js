import { metricValues } from './cw.js'
import { identityT } from '../i18n.js'

// RuntimeProvider OpenSearch/Elasticsearch. Lo stato del cluster è pubblicato su CloudWatch AWS/ES
// come ClusterStatus.green/yellow/red (0/1): red = shard primari persi (down), yellow = repliche non
// allocate (degraded). Le metriche AWS/ES hanno dimension ClientId (account) + DomainName: la
// discovery le salva in `aws.dimensions`; a mano basta `aws: { type: opensearch, domain, clientId }`.
// Permesso: cloudwatch:GetMetricData.
const DEFAULT_WINDOW_MIN = 15

export async function opensearchRuntime(cfg, aws, opts = {}) {
  const t = opts.t ?? identityT
  const win = cfg.windowMinutes ?? DEFAULT_WINDOW_MIN
  const dims =
    cfg.dimensions ??
    (cfg.domain
      ? [
          { Name: 'DomainName', Value: cfg.domain },
          ...(cfg.clientId ? [{ Name: 'ClientId', Value: cfg.clientId }] : []),
        ]
      : [])
  const m = await metricValues(
    aws,
    'AWS/ES',
    dims,
    [
      ['red', 'ClusterStatus.red', 'Maximum'],
      ['yellow', 'ClusterStatus.yellow', 'Maximum'],
      ['nodes', 'Nodes', 'Minimum'],
    ],
    win,
  )
  const status = m.red >= 1 ? 'down' : m.yellow >= 1 ? 'degraded' : 'up'
  const state = m.red >= 1 ? t('opensearch.red') : m.yellow >= 1 ? t('opensearch.yellow') : t('opensearch.green')
  return { status, summary: t('opensearch.summary', { state, nodes: Math.round(m.nodes) }) }
}
