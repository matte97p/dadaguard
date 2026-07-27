import { Badge, Tag, Tooltip, Typography } from 'antd'
import { fmtMs, fmtCount } from '../format.js'
import Sparkline from './Sparkline.jsx'

// Pezzi condivisi tra le due viste della flotta (card e tabella): stato, testo di un segnale,
// valore di una metrica. Stanno qui per non farle divergere — se il colore di "degraded" o il modo
// di accorciare un summary cambia, cambia in un posto solo.

const { Text } = Typography

export const STATUS = {
  up: { status: 'success', tag: 'success' },
  degraded: { status: 'warning', tag: 'warning' },
  down: { status: 'error', tag: 'error' },
  idle: { status: 'default', tag: 'default' },
  disabled: { status: 'default', tag: 'default' },
  unknown: { status: 'default', tag: 'default' },
}

// Colore di STATO (riservato): errori/throttle spiccano; il resto resta in ink normale. Il colore
// non è mai l'unico segnale — ogni valore ha la sua label. Palette allineata ad antd.
export const STAT_TONE = { critical: '#ff4d4f', warning: '#faad14', serious: '#fa8c16', good: '#52c41a' }

// Logo Terraform colorato per stato del drift: solo il logo, il testo (sì/no · diffs) nel tooltip.
const TF_COLOR = { up: '#52c41a', degraded: '#ff4d4f', down: '#ff4d4f', unknown: '#faad14' }
export function TerraformIcon({ status, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={TF_COLOR[status] ?? '#8c8c8c'} aria-hidden="true">
      <path d="M1.44 0v7.575l6.561 3.79V3.787zm21.12 4.227l-6.561 3.789v7.577l6.561-3.789zM8.72 4.23v7.575l6.562 3.79V8.019zm0 8.405v7.574L15.282 24v-7.578z" />
    </svg>
  )
}

// Il badge parlante: in stato "problema" dice IL PERCHÉ (il check colpevole: "ESECUZIONE",
// "ALLARME") invece del generico "ATTENZIONE"/"GIÙ"; altrove l'etichetta di stato. Il dettaglio
// esatto (+ quanti altri check sono coinvolti) va nel tooltip.
export function statusText(service, t) {
  const isBad = service.overall === 'degraded' || service.overall === 'down'
  const causeKey = isBad ? service.cause : null
  const causeCheck = causeKey ? service.checks?.[causeKey] : null
  const more = (service.causes?.length ?? 0) - 1
  return {
    text: isBad && causeKey ? t(`cause.${causeKey}`) : t(`card.status.${service.overall ?? 'unknown'}`),
    tip: isBad
      ? [t(`card.status.${service.overall}`), causeCheck?.summary ?? causeCheck?.reason].filter(Boolean).join(' — ') +
        (more > 0 ? ` (+${more})` : '')
      : null,
  }
}

// Tag di stato, mostrato solo quando c'è qualcosa da dire: un "OK" verde su ogni riga sana è rumore,
// il pallino verde lo dice già.
export function StatusTag({ service, t, style }) {
  if (service.overall === 'up') return null
  const { text, tip } = statusText(service, t)
  return (
    <Tooltip title={tip}>
      <Tag
        color={(STATUS[service.overall] ?? STATUS.unknown).tag}
        style={{ marginInlineEnd: 0, fontWeight: 600, fontSize: 11, lineHeight: '18px', ...style }}
      >
        {text}
      </Tag>
    </Tooltip>
  )
}

export function StatusDot({ status }) {
  return <Badge status={(STATUS[status] ?? STATUS.unknown).status} />
}

// Un summary del server ("sha 9f2a1c · 3g fa · da GitHubActions") è UNA frase: il primo pezzo è il
// fatto, il resto è contesto → primo pezzo in ink normale, il resto muto (e un filo più piccolo)
// sulla stessa riga. dropParen: la cadenza tra parentesi è già scritta altrove → via.
export function Summary({ text, dropParen = false, extra = null }) {
  const s = dropParen ? String(text).replace(/\s*\([^()]*\)/, '') : String(text)
  const [head, ...rest] = s.split(' · ').map((p) => p.trim()).filter(Boolean)
  const tail = [...rest, extra].filter(Boolean).join(' · ')
  return (
    <>
      <span>{head}</span>
      {tail && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {' '}
          · {tail}
        </Text>
      )}
    </>
  )
}

// Il tooltip del grafico riporta min/max/ultimo NELL'UNITÀ della metrica: la tile dice "~6.3s", il
// tooltip non può dire "6300" (la serie CloudWatch è in ms). L'unità la dichiara il server.
export const SPARK_FMT = { ms: (v) => fmtMs(Math.round(v)), count: (v) => fmtCount(Math.round(v)) }

// Valore di una metrica + il suo andamento. L'andamento sta SEMPRE attaccato alla metrica che
// descrive (mai sciolto accanto ad altri numeri): è l'etichetta della metrica a dire cosa disegna.
export function MetricValue({ metric, window, showLabel = false, color, inline = false }) {
  if (!metric) return <span>—</span>
  // `inline`: valore e andamento AFFIANCATI (per la tabella, dove una riga più alta delle altre
  // rompe il ritmo verticale) invece che impilati (per la card, dove c'è l'altezza).
  if (inline) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
        <span className="dg-num" style={{ color: color ?? (metric.tone ? STAT_TONE[metric.tone] : undefined) }}>
          {metric.value}
        </span>
        {metric.spark?.length > 2 && (
          <Sparkline
            data={metric.spark}
            width={44}
            height={11}
            label={[metric.label, window].filter(Boolean).join(' · ')}
            fmt={SPARK_FMT[metric.sparkUnit] ?? SPARK_FMT.count}
          />
        )}
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.15 }}>
      {showLabel && (
        <Text type="secondary" style={{ fontSize: 10, letterSpacing: 0.2, whiteSpace: 'nowrap' }}>
          {metric.label || ' '}
        </Text>
      )}
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          color: color ?? (metric.tone ? STAT_TONE[metric.tone] : undefined),
        }}
      >
        {metric.value}
      </span>
      {metric.spark?.length > 2 && (
        <Sparkline
          data={metric.spark}
          label={[metric.label, window].filter(Boolean).join(' · ')}
          fmt={SPARK_FMT[metric.sparkUnit] ?? SPARK_FMT.count}
        />
      )}
    </span>
  )
}

// La metrica di latenza, se c'è: la dichiara il server (`kind: 'latency'`) — dedurla dall'unità
// sarebbe fragile, una latenza senza serie non ha `sparkUnit`. In tabella ha una colonna sua, così
// il grafico eredita l'etichetta dall'intestazione.
export function latencyMetric(runtime) {
  return (runtime?.metrics ?? []).find((m) => m.kind === 'latency') ?? null
}
