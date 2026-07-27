import { Fragment } from 'react'
import { Table, Typography, Space, Badge, Tooltip, Popconfirm } from 'antd'
import { DeleteOutlined, FileTextOutlined, HistoryOutlined, GlobalOutlined, ClockCircleOutlined } from '@ant-design/icons'
import { fmtMs, fmtSchedule } from '../format.js'
import { prettyBedrock, splitFamily, familyPrefixes } from '../serviceName.js'
import { StatusDot, StatusTag, Summary, MetricValue, TerraformIcon, latencyMetric } from './signals.jsx'

const { Text, Link } = Typography

// Vista TABELLA della flotta: una riga per servizio. È la forma giusta oltre la ventina di servizi —
// le card, a 48, diventano un muro (è il pattern delle service list di Datadog/Sentry/ArgoCD).
// Colonne fisse e ordinabili, i segnali secondari nella riga espansa, il dettaglio nel drawer.
//
// Nomi DUPLICATI tra account (`backend` esiste in staging e in produzione, e i modelli Bedrock in
// entrambi): la chiave di riga è account+nome, mai il nome.
const rowKey = (s) => `${s.account?.key ?? '—'}/${s.name}`

// Severità: problemi in cima, poi i sani, in fondo ciò che non è un problema (inattivi e spenti di
// proposito). Stesso ordine della vista a card.
const SEV = { down: 0, degraded: 1, unknown: 2, up: 3, idle: 4, disabled: 5 }
const sev = (s) => SEV[s.overall] ?? 2

export default function ServicesTable({ services, caps, onRemove, onLogs, onEvents, onOpen, t }) {
  // Famiglie calcolate PER ACCOUNT: mescolando gli account il prefisso condiviso si riduce al minimo
  // comune ("cato-") e la testa non compatta più niente. Con l'account come contesto tornano le teste
  // utili — `cato-staging-cron-` per i cron di staging, `cato-production-cron-` per quelli di prod.
  const famByAccount = new Map()
  for (const s of services) {
    const k = s.account?.key ?? '—'
    if (!famByAccount.has(k)) famByAccount.set(k, [])
    if (s.type !== 'bedrock') famByAccount.get(k).push(s.name)
  }
  for (const [k, names] of famByAccount) famByAccount.set(k, familyPrefixes(names))
  const rows = [...services].sort((a, b) => sev(a) - sev(b) || String(a.name).localeCompare(String(b.name)))

  const typeLabel = (ty) => (ty ? (t(`type.${ty}`) === `type.${ty}` ? ty : t(`type.${ty}`)) : '—')
  const uniq = (vals) => [...new Set(vals.filter(Boolean))]

  const columns = [
    {
      title: t('col.status'),
      key: 'stato',
      width: 116,
      sorter: (a, b) => sev(a) - sev(b) || String(a.name).localeCompare(String(b.name)),
      defaultSortOrder: 'ascend',
      filters: uniq(rows.map((s) => s.overall)).map((v) => ({ text: t(`card.status.${v}`), value: v })),
      onFilter: (v, s) => s.overall === v,
      render: (_, s) => (
        <Space size={6}>
          <StatusDot status={s.overall} />
          <StatusTag service={s} t={t} />
        </Space>
      ),
    },
    {
      title: t('col.service'),
      key: 'servizio',
      sorter: (a, b) => String(a.name).localeCompare(String(b.name)),
      render: (_, s) => {
        // Nome: testa comune del gruppo piccola e muta, coda in evidenza (niente troncature: il nome
        // intero è testa + coda). I Bedrock hanno il loro nome parlante.
        const bedrock = s.type === 'bedrock' ? prettyBedrock(s.name) : null
        const { family, tail } = bedrock
          ? { family: null, tail: bedrock.name ?? s.name }
          : splitFamily(s.name, famByAccount.get(s.account?.key ?? '—'))
        const cadence = s.checks?.runtime?.schedule ? fmtSchedule(s.checks.runtime.schedule, t) : null
        return (
          <Tooltip title={s.name}>
            <span
              onClick={onOpen ? () => onOpen(s.name) : undefined}
              style={{ cursor: onOpen ? 'pointer' : undefined, display: 'inline-flex', alignItems: 'baseline', gap: 6 }}
            >
              {family && <span className="dg-fam" style={{ maxWidth: 150 }}>{family}</span>}
              <span style={{ fontWeight: 600, fontSize: 13 }}>{tail}</span>
              {cadence && (
                <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                  <ClockCircleOutlined style={{ marginInlineEnd: 3 }} />
                  {cadence}
                </Text>
              )}
            </span>
          </Tooltip>
        )
      },
    },
    {
      title: t('col.account'),
      key: 'ambiente',
      width: 130,
      sorter: (a, b) => String(a.account?.label ?? '').localeCompare(String(b.account?.label ?? '')),
      filters: uniq(rows.map((s) => s.account?.label)).map((v) => ({ text: v, value: v })),
      onFilter: (v, s) => s.account?.label === v,
      render: (_, s) => (
        <Space size={6}>
          {s.account?.color && <Badge color={s.account.color} />}
          <Text style={{ fontSize: 12 }}>{s.account?.label ?? '—'}</Text>
        </Space>
      ),
    },
    {
      title: t('col.type'),
      key: 'tipo',
      width: 120,
      filters: uniq(rows.map((s) => s.type)).map((v) => ({ text: typeLabel(v), value: v })),
      onFilter: (v, s) => s.type === v,
      render: (_, s) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {typeLabel(s.type)}
        </Text>
      ),
    },
    {
      title: <ColHead label={t('card.label.build')} tip={t('card.tip.build')} />,
      key: 'build',
      width: 230,
      render: (_, s) =>
        s.checks?.version ? (
          <span className="dg-cell" title={s.checks.version.summary || undefined}>
            <StatusDot status={s.checks.version.status} />{' '}
            {s.checks.version.summary ? <Summary text={s.checks.version.summary} /> : (s.checks.version.reason ?? '—')}
          </span>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: <ColHead label={t('card.label.runtime')} tip={t('card.tip.runtime')} />,
      key: 'esecuzione',
      width: 300,
      render: (_, s) => {
        const r = s.checks?.runtime
        if (!r) return <Text type="secondary">—</Text>
        const cadence = r.schedule ? fmtSchedule(r.schedule, t) : null
        // Le metriche hanno colonne proprie (latenza) o stanno nella riga espansa: qui la frase.
        const text = r.summary ?? r.reason ?? '—'
        return (
          <span className="dg-cell" title={r.summary || undefined}>
            <StatusDot status={r.status} /> <Summary text={text} dropParen={Boolean(cadence)} extra={r.nextRunLabel} />
          </span>
        )
      },
    },
    {
      title: <ColHead label={t('col.latency')} tip={t('col.tip.latency')} />,
      key: 'latenza',
      width: 110,
      align: 'right',
      render: (_, s) => {
        const m = latencyMetric(s.checks?.runtime)
        return m ? <MetricValue metric={m} window={s.checks?.runtime?.window} /> : <Text type="secondary">—</Text>
      },
    },
    {
      title: '',
      key: 'azioni',
      width: 104,
      align: 'right',
      render: (_, s) => {
        const hasLogs = ['lambda', 'ecs', 'ecs-scheduled'].includes(s.type)
        const hasEvents = Boolean(s.type) && s.type !== 'cloudflare-worker'
        return (
          <span className="dg-actions">
            {s.checks?.drift && (
              <Tooltip title={`${t('card.label.drift')}: ${s.checks.drift.summary ?? s.checks.drift.reason ?? '—'}`}>
                <span style={{ display: 'inline-flex', alignItems: 'center', cursor: 'help' }}>
                  <TerraformIcon status={s.checks.drift.status} />
                </span>
              </Tooltip>
            )}
            {s.url && (
              <Link href={s.url} target="_blank" rel="noreferrer" type="secondary" title={s.url} onClick={(e) => e.stopPropagation()}>
                <GlobalOutlined />
              </Link>
            )}
            {onLogs && hasLogs && (
              <Link type="secondary" onClick={() => onLogs(s.name)} title={t('logs.button')}>
                <FileTextOutlined />
              </Link>
            )}
            {onEvents && hasEvents && (
              <Link type="secondary" onClick={() => onEvents(s.name)} title={t('events.button')}>
                <HistoryOutlined />
              </Link>
            )}
            {caps?.watchlist && onRemove && (
              <Popconfirm
                title={t('card.removeTitle')}
                description={t('card.removeDesc')}
                okText={t('card.removeOk')}
                cancelText={t('card.removeCancel')}
                onConfirm={() => onRemove(s.name)}
              >
                <Link type="secondary">
                  <DeleteOutlined />
                </Link>
              </Popconfirm>
            )}
          </span>
        )
      },
    },
  ]

  // Segnali senza colonna propria (raggiungibilità, secret, sicurezza, allarmi, backup, Terraform):
  // stanno nella riga espansa, uno per riga. Nessuna informazione persa, zero colonne in più.
  const EXTRA = [
    ['liveness', 'card.label.reachable'],
    ['secrets', 'card.label.secret'],
    ['security', 'card.label.security'],
    ['alarms', 'card.label.alarms'],
    ['backups', 'card.label.backups'],
    ['drift', 'card.label.drift'],
  ]
  const extrasOf = (s) => EXTRA.filter(([k]) => s.checks?.[k])

  return (
    <Table
      className="dg-table"
      size="small"
      rowKey={rowKey}
      dataSource={rows}
      columns={columns}
      pagination={false}
      sticky
      scroll={{ x: 'max-content' }}
      onRow={(s) => ({ 'data-service': s.name })}
      expandable={{
        rowExpandable: (s) => extrasOf(s).length > 0,
        expandedRowRender: (s) => (
          <div className="dg-rows" style={{ marginInlineStart: 8 }}>
            {extrasOf(s).map(([k, labelKey]) => {
              const c = s.checks[k]
              return (
                <Fragment key={k}>
                  <div className="dg-label">
                    <span>{t(labelKey)}</span>
                  </div>
                  <div className="dg-val" title={c.summary || undefined}>
                    <StatusDot status={c.status} />{' '}
                    {k === 'liveness' && c.httpStatus ? (
                      <>
                        <span>{t('card.responds', { code: c.httpStatus })}</span>
                        {typeof c.latencyMs === 'number' && (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {' '}
                            · {fmtMs(c.latencyMs)}
                          </Text>
                        )}
                      </>
                    ) : (
                      <Summary text={c.summary ?? c.reason ?? '—'} />
                    )}
                  </div>
                </Fragment>
              )
            })}
          </div>
        ),
      }}
    />
  )
}

// Intestazione con tooltip che spiega il segnale (tratteggiata, come le etichette nelle card).
function ColHead({ label, tip }) {
  return (
    <Tooltip title={tip}>
      <span style={{ borderBottom: '1px dotted currentColor', cursor: 'help' }}>{label}</span>
    </Tooltip>
  )
}
