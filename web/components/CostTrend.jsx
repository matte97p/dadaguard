import { useEffect, useRef, useState } from 'react'
import { Typography } from 'antd'

const { Text } = Typography

// Grafico del trend costi: 13 mesi, due serie sullo STESSO asse (sono entrambe dollari, quindi
// confrontabili — mai due scale y in un grafico, è il modo più rapido di far leggere una relazione
// che non esiste).
//
// Perché una linea e non barre: la domanda è "sta crescendo?", che è una forma nel tempo, non un
// confronto tra mesi presi a sé.
//
// Colori validati con lo script del design system (chiaro E scuro, incluse le tre simulazioni di
// daltonismo): viola = consumo a listino, arancio scuro = fatturato. Non sono l'unico segnale — c'è
// la legenda, ci sono i valori scritti sull'ultimo punto e c'è la tabella qui sotto.
const USAGE = '#7c3aed'
const INVOICED = '#d46b08'

const H = 210
const MIN_W = 420
const PAD = { top: 14, right: 58, bottom: 24, left: 46 }

const money = (v, currency = 'USD') => {
  const n = Number(v ?? 0)
  const sym = currency === 'EUR' ? '€' : '$'
  const abs = Math.abs(n)
  const s = abs >= 10000 ? `${(abs / 1000).toFixed(1)}k` : abs >= 100 ? abs.toFixed(0) : abs.toFixed(2)
  return `${n < 0 ? '−' : ''}${sym}${s}`
}

// '2026-07' → 'lug 26' nella lingua dell'utente. Senza `Date` locale: il primo del mese in UTC,
// altrimenti a fusi negativi il mese slitta indietro di uno.
function monthLabel(m, lang = 'it') {
  const [y, mm] = String(m ?? '').split('-')
  if (!y || !mm) return String(m ?? '')
  const d = new Date(Date.UTC(Number(y), Number(mm) - 1, 1))
  return new Intl.DateTimeFormat(lang === 'en' ? 'en' : 'it', { month: 'short', timeZone: 'UTC' }).format(d) + ' ' + y.slice(2)
}

// Etichette dell'asse: formato COMPATTO e uniforme. Mischiare "$1312" e "$0.00" sulla stessa scala fa
// leggere due precisioni diverse dove la precisione è la stessa.
function tickLabel(v, currency) {
  const sym = currency === 'EUR' ? '€' : '$'
  const a = Math.abs(Number(v ?? 0))
  if (a === 0) return `${sym}0`
  if (a >= 1000) return `${sym}${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`
  return `${sym}${a.toFixed(0)}`
}

export default function CostTrend({ months = [], currency = 'USD', metric = 'usage', t = (k) => k, lang = 'it' }) {
  const [hover, setHover] = useState(null)
  // Larghezza VERA del contenitore invece di far scalare l'SVG: con `width:100%` e un viewBox fisso il
  // disegno si adatta al lato corto e resta un francobollo in mezzo alla card (oppure, forzando la
  // scalatura, i testi si stirano). Misurare costa dieci righe e il grafico riempie lo spazio.
  const box = useRef(null)
  const [W, setW] = useState(720)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(Math.max(MIN_W, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const rows = months.filter((m) => m && m.month)
  if (rows.length < 2) return null // un punto non è un andamento

  const valueOf = (r) => (metric === 'infra' ? (r.infraUsage ?? r.usage) : r.usage)
  // Scala che parte SEMPRE da zero: un asse tagliato trasforma +8% in un raddoppio visivo.
  const max = Math.max(1, ...rows.flatMap((r) => [valueOf(r), r.invoiced]))
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const x = (i) => PAD.left + (rows.length === 1 ? innerW / 2 : (i * innerW) / (rows.length - 1))
  const y = (v) => PAD.top + innerH - (Math.max(0, v) / max) * innerH

  // L'ultimo mese è in corso: il suo segmento va TRATTEGGIATO, altrimenti un mese incompleto si legge
  // come un crollo della spesa.
  const lastPartial = rows[rows.length - 1]?.partial
  const solidEnd = lastPartial ? rows.length - 1 : rows.length // indice esclusivo dei punti "chiusi"
  const path = (get, from, to) =>
    rows
      .slice(from, to)
      .map((r, k) => `${k === 0 ? 'M' : 'L'} ${x(from + k).toFixed(1)} ${y(get(r)).toFixed(1)}`)
      .join(' ')

  const series = [
    { key: 'usage', color: USAGE, get: valueOf, label: metric === 'infra' ? t('costs.trend.infra') : t('costs.trend.usage') },
    { key: 'invoiced', color: INVOICED, get: (r) => r.invoiced, label: t('costs.trend.invoiced') },
  ]

  const ticks = [0, max / 2, max]
  const last = rows[rows.length - 1]
  const h = hover != null ? rows[hover] : null

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`${t('costs.trend.title')}: ${rows.length} ${t('costs.trend.months')}`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* griglia: recessiva, tre livelli — deve dare la misura, non disegnare una gabbia */}
        {ticks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              stroke="currentColor"
              strokeOpacity={i === 0 ? 0.28 : 0.1}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.5}>
              {tickLabel(v, currency)}
            </text>
          </g>
        ))}

        {/* mesi sull'asse x: uno ogni due (a 13 punti, tutti si accavallano) + sempre l'ultimo */}
        {rows.map((r, i) =>
          i % 2 === 0 || i === rows.length - 1 ? (
            <text key={r.month} x={x(i)} y={H - 8} textAnchor="middle" fontSize={9} fill="currentColor" opacity={0.5}>
              {monthLabel(r.month, lang)}
            </text>
          ) : null,
        )}

        {series.map((s) => (
          <g key={s.key}>
            <path
              d={path(s.get, 0, solidEnd)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {lastPartial && (
              <path
                d={path(s.get, Math.max(0, solidEnd - 1), rows.length)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray="4 3"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {/* valore scritto sull'ultimo punto: l'identità della serie non sta solo nel colore */}
            <circle cx={x(rows.length - 1)} cy={y(s.get(last))} r={3.5} fill={s.color} />
            <text x={x(rows.length - 1) + 7} y={y(s.get(last)) + 3.5} fontSize={10} fill={s.color} fontWeight={600}>
              {money(s.get(last), currency)}
            </text>
          </g>
        ))}

        {/* mirino + pallini del mese sotto il puntatore */}
        {h && (
          <g pointerEvents="none">
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + innerH}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {series.map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(s.get(h))} r={4.5} fill={s.color} stroke="white" strokeWidth={1.5} />
            ))}
          </g>
        )}

        {/* bersagli invisibili: una fascia per mese, larga metà intervallo per lato → il puntatore non
            deve azzeccare la linea (2px) ma solo la colonna del mese */}
        {rows.map((r, i) => (
          <rect
            key={`hit-${r.month}`}
            x={x(i) - innerW / (rows.length - 1) / 2}
            y={PAD.top}
            width={innerW / (rows.length - 1)}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>

      {h && (
        <div
          style={{
            position: 'absolute',
            left: `${(x(hover) / W) * 100}%`,
            top: 0,
            transform: `translateX(${hover > rows.length / 2 ? '-105%' : '8px'})`,
            pointerEvents: 'none',
            background: 'rgba(0,0,0,0.82)',
            color: '#fff',
            borderRadius: 6,
            padding: '6px 8px',
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 2 }}>
            {monthLabel(h.month, lang)}
            {h.partial ? ` · ${t('costs.trend.partial')}` : ''}
          </div>
          {series.map((s) => (
            <div key={s.key}>
              <span style={{ color: s.color }}>●</span> {s.label}: {money(s.get(h), currency)}
            </div>
          ))}
          {h.aiUsage > 0 && (
            <div style={{ opacity: 0.75 }}>
              {t('costs.trend.ai')}: {money(h.aiUsage, currency)}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 2 }}>
        {series.map((s) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
            <span style={{ width: 14, height: 2, background: s.color, display: 'inline-block' }} />
            <Text type="secondary" style={{ fontSize: 11 }}>
              {s.label}
            </Text>
          </span>
        ))}
        {lastPartial && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('costs.trend.dashed')}
          </Text>
        )}
      </div>

      {/* Vista tabellare: i numeri esatti restano raggiungibili anche senza puntatore (tastiera,
          screen reader, stampa) — il tooltip non deve essere l'unica strada verso un valore. */}
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, opacity: 0.65 }}>{t('costs.trend.table')}</summary>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11, marginTop: 6 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '2px 10px 2px 0', opacity: 0.6, fontWeight: 600 }}>
                  {t('costs.trend.month')}
                </th>
                {series.map((s) => (
                  <th key={s.key} style={{ textAlign: 'right', padding: '2px 10px 2px 0', opacity: 0.6, fontWeight: 600 }}>
                    {s.label}
                  </th>
                ))}
                <th style={{ textAlign: 'right', padding: '2px 0', opacity: 0.6, fontWeight: 600 }}>{t('costs.trend.ai')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month}>
                  <td style={{ padding: '2px 10px 2px 0', whiteSpace: 'nowrap' }}>
                    {monthLabel(r.month, lang)}
                    {r.partial ? ' *' : ''}
                  </td>
                  {series.map((s) => (
                    <td key={s.key} className="dg-num" style={{ textAlign: 'right', padding: '2px 10px 2px 0' }}>
                      {money(s.get(r), currency)}
                    </td>
                  ))}
                  <td className="dg-num" style={{ textAlign: 'right', padding: '2px 0' }}>
                    {money(r.aiUsage ?? 0, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
