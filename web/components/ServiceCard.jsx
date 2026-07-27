import { Card, Badge, Space, Typography, Tag, Popconfirm, Tooltip } from 'antd'
import {
  DeleteOutlined,
  FileTextOutlined,
  HistoryOutlined,
  ClockCircleOutlined,
  GlobalOutlined,
} from '@ant-design/icons'
import { fmtMs, fmtSchedule } from '../format.js'
import { prettyBedrock, splitFamily } from '../serviceName.js'
import Sparkline from './Sparkline.jsx'

// Logo Terraform (SVG inline) colorato per stato del drift: la card mostra solo il logo, il testo
// (sì/no · diffs) va nel tooltip. Verde=conforme, rosso=drift, giallo=stato ignoto.
const TF_COLOR = { up: '#52c41a', degraded: '#ff4d4f', down: '#ff4d4f', unknown: '#faad14' }
function TerraformIcon({ color, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <path d="M1.44 0v7.575l6.561 3.79V3.787zm21.12 4.227l-6.561 3.789v7.577l6.561-3.789zM8.72 4.23v7.575l6.562 3.79V8.019zm0 8.405v7.574L15.282 24v-7.578z" />
    </svg>
  )
}

const STATUS = {
  up: { status: 'success', tag: 'success' },
  degraded: { status: 'warning', tag: 'warning' },
  down: { status: 'error', tag: 'error' },
  idle: { status: 'default', tag: 'default' },
  disabled: { status: 'default', tag: 'default' },
  unknown: { status: 'default', tag: 'default' },
}

const { Link, Text } = Typography

// Riga di un check: etichetta a sinistra (colonna a larghezza fissa, vedi .dg-rows in app.css) e
// valore a destra col pallino di stato attaccato al testo. UN segnale = UNA riga: è ciò che rende
// la card leggibile a colpo d'occhio quando ne hai 25 sullo schermo.
// Il tooltip che spiega il segnale sta sull'etichetta (tratteggiata), non su un "?" a fianco.
function Row({ label, tip, status, raw, children }) {
  return (
    <>
      <div className="dg-label">
        <Tooltip title={tip}>
          <span>{label}</span>
        </Tooltip>
      </div>
      {/* `title`: il valore per intero, non accorciato (sha completo, email di chi ha deployato) —
          in card sta la forma breve, sotto il puntatore quella integrale. */}
      <div className="dg-val" title={raw || undefined}>
        <Badge status={STATUS[status]?.status ?? 'default'} style={{ marginInlineEnd: 5 }} />
        {children}
      </div>
    </>
  )
}

// Un summary del server ("sha 9f2a1c · 3g fa · modificato da GitHubActions") è UNA frase: il primo
// pezzo è il fatto, il resto è contesto → primo pezzo in ink normale, il resto muto sulla stessa
// riga (prima erano pillole tutte uguali che andavano a capo una per riga).
// dropParen: la cadenza tra parentesi ("(attesa ogni 1g)") è già nell'header della card → via.
function Summary({ text, dropParen = false, extra = null }) {
  const s = dropParen ? String(text).replace(/\s*\([^()]*\)/, '') : String(text)
  const [head, ...rest] = s.split(' · ').map((p) => p.trim()).filter(Boolean)
  const tail = [...rest, extra].filter(Boolean).join(' · ')
  return (
    <>
      <span>{head}</span>
      {/* contesto un filo più piccolo del fatto: gerarchia leggibile e una riga sola invece di due */}
      {tail && <Text type="secondary" style={{ fontSize: 11 }}> · {tail}</Text>}
    </>
  )
}

// Colore di STATO (riservato): errori/throttle spiccano; il resto resta in ink normale. Il colore
// non è mai l'unico segnale — ogni tile ha la sua label (mai "colore da solo"). Palette allineata ad antd.
const STAT_TONE = { critical: '#ff4d4f', warning: '#faad14', serious: '#fa8c16', good: '#52c41a' }

// KPI row di stat tile: label muta piccola sopra, valore semibold sotto. La forma giusta per "un
// pugno di numeri di testa" (dataviz: KPI row), invece della stringa/pillole indistinte.
function StatRow({ metrics, window }) {
  const Tile = ({ label, value, color }) => (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.15 }}>
      <Text type="secondary" style={{ fontSize: 10, letterSpacing: 0.2, whiteSpace: 'nowrap' }}>{label || ' '}</Text>
      <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', color }}>{value}</span>
    </span>
  )
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '2px 14px', alignItems: 'flex-end', verticalAlign: 'top' }}>
      {metrics.map((m, i) => (
        <Tile key={i} label={m.label} value={m.value} color={m.tone ? STAT_TONE[m.tone] : undefined} />
      ))}
      {window && <Text type="secondary" style={{ fontSize: 11, alignSelf: 'flex-end' }}>{window}</Text>}
    </span>
  )
}

export default function ServiceCard({
  service,
  onRemove,
  onLogs,
  onEvents,
  onOpen,
  familyPrefixes,
  reserveFamily = false,
  t = (k) => k,
}) {
  const overall = STATUS[service.overall] ?? STATUS.unknown
  const hasLogs = ['lambda', 'ecs', 'ecs-scheduled'].includes(service.type) // tipi con log applicativi su CloudWatch
  // eventi operativi (ECS/RDS/ASG) e/o modifiche CloudTrail — solo AWS: un Worker Cloudflare non li ha
  const hasEvents = Boolean(service.type) && service.type !== 'cloudflare-worker'
  // Badge parlante: se il servizio è in stato "problema" (giallo/rosso), il testo dice IL PERCHÉ
  // (il check colpevole, es. "ALLARME" / "ESECUZIONE") invece del generico "ATTENZIONE"/"GIÙ";
  // negli altri stati resta l'etichetta di stato. Il dettaglio esatto va nel tooltip.
  const isBad = service.overall === 'degraded' || service.overall === 'down'
  const causeKey = isBad ? service.cause : null
  const causeCheck = causeKey ? service.checks?.[causeKey] : null
  const overallText = isBad && causeKey ? t(`cause.${causeKey}`) : t(`card.status.${service.overall ?? 'unknown'}`)
  const moreCauses = (service.causes?.length ?? 0) - 1
  const overallTip = isBad
    ? [t(`card.status.${service.overall}`), causeCheck?.summary ?? causeCheck?.reason]
        .filter(Boolean)
        .join(' — ') + (moreCauses > 0 ? ` (+${moreCauses})` : '')
    : null
  const liveness = service.checks?.liveness
  const version = service.checks?.version
  const runtime = service.checks?.runtime
  const drift = service.checks?.drift
  const secrets = service.checks?.secrets
  const security = service.checks?.security
  const alarms = service.checks?.alarms
  const backups = service.checks?.backups
  const links = service.links ?? {}
  const account = service.account

  // Nome: i modelli Bedrock hanno il loro nome parlante; per tutto il resto testa muta (la famiglia
  // condivisa nel gruppo, es. `cato-staging-cron-`) + coda in evidenza — su 25 card leggi subito la
  // parte che le distingue, senza perdere il nome completo (testa + coda, in fila).
  const bedrock = service.type === 'bedrock' ? prettyBedrock(service.name) : null
  const { family, tail } = bedrock
    ? { family: null, tail: bedrock.name ?? service.name }
    : splitFamily(service.name, familyPrefixes)
  // Sottotitolo: per i Bedrock solo la meta (regione · data del modello). L'ID grezzo
  // (eu.anthropic.claude-haiku-4-5-20251001-v1:0) mangiava due righe per card ed è già nel tooltip
  // del nome, dove serve: qui conta riconoscere il modello, non copiarne l'identificativo.
  const sub = bedrock ? (bedrock.name !== service.name ? bedrock.meta || null : null) : service.description

  // Cadenza del cron in parole ("ogni 1g", non "1440m" che non dice niente a chi legge); per gli
  // altri il tipo di risorsa, che altrimenti la card non nomina mai ("Database", "Cron lungo", …).
  const cadence = runtime?.schedule ? fmtSchedule(runtime.schedule, t) : null
  const typeKey = service.type ? `type.${service.type}` : null
  const typeLabel = typeKey ? (t(typeKey) === typeKey ? service.type : t(typeKey)) : null

  return (
    <Card
      size="small"
      className="dg-card"
      data-service={service.name}
      // accento colore dell'ambiente: riconosci prod da staging a colpo d'occhio. height:100% →
      // le card di una riga sono alte uguali (griglia ordinata invece di bordi a zig-zag).
      style={{
        width: '100%', // la Col è flex (card alte uguali): senza questo la card si stringe sul contenuto
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        ...(account?.color ? { borderTop: `3px solid ${account.color}` } : null),
      }}
      styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column' } }}
      // Tutto l'header sta nel `title` (niente `extra`): con `extra` il titolo viene strozzato a
      // metà card ed è per quello che i nomi lunghi andavano a capo su 4 righe.
      title={
        <>
          {/* Se qualcuno nel gruppo ha una famiglia, la riga la tengono TUTTI (vuota se non serve):
              così i nomi restano incolonnati sulla stessa riga di card invece di ballare di 15px. */}
          {family ? (
            <div className="dg-fam" title={`${t('card.fullName')}: ${service.name}`}>
              {family}
            </div>
          ) : (
            reserveFamily && <div className="dg-fam">&nbsp;</div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
            <Badge status={overall.status} style={{ marginTop: 5 }} />
            <Tooltip title={service.name}>
              <span
                className="dg-name"
                onClick={onOpen ? () => onOpen(service.name) : undefined}
                style={{ flex: 1, ...(onOpen ? { cursor: 'pointer' } : null) }}
              >
                {tail}
              </span>
            </Tooltip>
            {/* Tag di stato solo quando c'è qualcosa da dire: un "OK" verde su ogni card sana è
                rumore — il pallino verde lo dice già. */}
            {service.overall !== 'up' && (
              <Tooltip title={overallTip}>
                <Tag
                  color={overall.tag}
                  style={{ marginInlineEnd: 0, fontWeight: 600, fontSize: 11, lineHeight: '18px', marginTop: 1 }}
                >
                  {overallText}
                </Tag>
              </Tooltip>
            )}
          </div>
          {sub && (
            <div style={{ fontSize: 11, fontWeight: 400, opacity: 0.6, whiteSpace: 'normal', lineHeight: 1.3 }}>{sub}</div>
          )}

          {/* Riga meta: a sinistra cadenza (cron) o tipo di risorsa, a destra le azioni. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 3 }}>
            {cadence ? (
              <Tooltip title={[runtime.scheduleExpr || t('card.cron.tip'), runtime.nextRunLabel].filter(Boolean).join(' · ')}>
                <Text type="secondary" style={{ fontSize: 11, fontWeight: 400, cursor: 'help', whiteSpace: 'nowrap' }}>
                  <ClockCircleOutlined style={{ marginInlineEnd: 4 }} />
                  {cadence}
                </Text>
              </Tooltip>
            ) : (
              <Text
                type="secondary"
                style={{ fontSize: 11, fontWeight: 400, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}
              >
                {typeLabel}
              </Text>
            )}
            <span className="dg-actions">
              {drift && (
                <Tooltip title={`${t('card.label.drift')}: ${drift.summary ?? drift.reason ?? '—'}`}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', cursor: 'help' }}>
                    <TerraformIcon color={TF_COLOR[drift.status] ?? '#8c8c8c'} />
                  </span>
                </Tooltip>
              )}
              {service.url && (
                <Link
                  href={service.url}
                  target="_blank"
                  rel="noreferrer"
                  type="secondary"
                  title={service.url}
                  onClick={(e) => e.stopPropagation()}
                >
                  <GlobalOutlined />
                </Link>
              )}
              {onLogs && hasLogs && (
                <Link type="secondary" onClick={() => onLogs(service.name)} title={t('logs.button')}>
                  <FileTextOutlined />
                </Link>
              )}
              {onEvents && hasEvents && (
                <Link type="secondary" onClick={() => onEvents(service.name)} title={t('events.button')}>
                  <HistoryOutlined />
                </Link>
              )}
              {onRemove && (
                <Popconfirm
                  title={t('card.removeTitle')}
                  description={t('card.removeDesc')}
                  okText={t('card.removeOk')}
                  cancelText={t('card.removeCancel')}
                  onConfirm={() => onRemove(service.name)}
                >
                  <Link type="secondary">
                    <DeleteOutlined />
                  </Link>
                </Popconfirm>
              )}
            </span>
          </div>
        </>
      }
    >
      <div className="dg-rows">
        {liveness && (
          <Row label={t('card.label.reachable')} tip={t('card.tip.reachable')} status={liveness.status}>
            <span>
              {liveness.httpStatus ? t('card.responds', { code: liveness.httpStatus }) : (liveness.reason ?? '—')}
            </span>
            {typeof liveness.latencyMs === 'number' && (
              <Text type="secondary" style={{ fontSize: 11 }}> · {fmtMs(liveness.latencyMs)}</Text>
            )}
          </Row>
        )}

        {version && (
          <Row label={t('card.label.build')} tip={t('card.tip.build')} status={version.status} raw={version.summary}>
            {version.summary ? (
              <Summary
                text={version.summary}
                extra={version.expectedSource === 'url' ? t('card.expectedFrom', { from: version.expectedFrom }) : null}
              />
            ) : (
              <span>{version.reason ?? '—'}</span>
            )}
          </Row>
        )}

        {runtime && (
          <Row label={t('card.label.runtime')} tip={t('card.tip.runtime')} status={runtime.status} raw={runtime.summary}>
            {/* KPI tile solo da DUE numeri in su: per un numero solo ("2/2 task attivi") la coppia
                label-sopra/valore-sotto occupa due righe per dire una cosa → meglio la frase. */}
            {runtime.metrics?.length > 1 ? (
              <StatRow metrics={runtime.metrics} window={runtime.window} />
            ) : runtime.summary ? (
              <Summary text={runtime.summary} dropParen={Boolean(cadence)} extra={runtime.nextRunLabel} />
            ) : (
              <span>{runtime.reason ?? '—'}</span>
            )}
            {runtime.spark?.length > 1 && <Sparkline data={runtime.spark} />}
          </Row>
        )}

        {secrets && (
          <Row label={t('card.label.secret')} tip={t('card.tip.secret')} status={secrets.status} raw={secrets.summary}>
            <Summary text={secrets.summary ?? secrets.reason ?? '—'} />
          </Row>
        )}

        {security && (
          <Row label={t('card.label.security')} tip={t('card.tip.security')} status={security.status} raw={security.summary}>
            <Summary text={security.summary ?? security.reason ?? '—'} />
          </Row>
        )}

        {alarms && (
          <Row label={t('card.label.alarms')} tip={t('card.tip.alarms')} status={alarms.status} raw={alarms.summary}>
            <Summary text={alarms.summary ?? alarms.reason ?? '—'} />
          </Row>
        )}

        {backups && (
          <Row label={t('card.label.backups')} tip={t('card.tip.backups')} status={backups.status} raw={backups.summary}>
            <Summary text={backups.summary ?? backups.reason ?? '—'} />
          </Row>
        )}
      </div>

      {/* I link (Console AWS & co.) restano incollati in basso: con le card della riga alte uguali,
          la riga dei link è sempre allo stesso posto e non balla da una card all'altra. */}
      {Object.keys(links).length > 0 && (
        <Space size="small" wrap style={{ marginTop: 'auto', paddingTop: 8 }}>
          {Object.entries(links).map(([label, url]) => (
            <Link key={label} href={url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
              {label} ↗
            </Link>
          ))}
        </Space>
      )}
    </Card>
  )
}
