// Mini-grafico inline (SVG) del trend di una metrica sulla finestra. Nessuna dipendenza.
// De-emphasis di proposito (linea sottile, colore muto) — è contesto, non il dato principale.
export default function Sparkline({ data, width = 76, height = 18, color = '#8c8c8c' }) {
  const vals = (data ?? []).filter((v) => Number.isFinite(v))
  if (vals.length < 2) return null
  const max = Math.max(...vals)
  const min = Math.min(...vals)
  const range = max - min || 1
  const step = width / (vals.length - 1)
  const pts = vals
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * (height - 2) - 1).toFixed(1)}`)
    .join(' ')
  const lastX = width
  const lastY = height - ((vals[vals.length - 1] - min) / range) * (height - 2) - 1
  return (
    <svg width={width} height={height} style={{ display: 'block' }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(lastX - step).toFixed(1)} cy={lastY.toFixed(1)} r="1.6" fill={color} />
    </svg>
  )
}
