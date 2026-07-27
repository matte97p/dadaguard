import { sparkStats } from '../format.js'

// Mini-grafico inline (SVG) dell'andamento di UNA metrica, sotto il numero che quella metrica ha già
// scritto in chiaro. Nessuna dipendenza.
//
// Due regole imparate a spese di chi lo leggeva:
//  1. Mai un grafico senza etichetta: qui non c'è titolo perché sta DENTRO la stat tile della sua
//     metrica (la label della tile dice cosa disegna). Non usarlo sciolto in mezzo ad altri numeri:
//     il lettore lo attribuisce al numero più vicino e legge la cosa sbagliata.
//  2. Scala con lo ZERO in basso (non min-max): un p95 che oscilla del 3% deve SEMBRARE piatto.
//     Con la scala min-max qualunque rumore riempiva l'altezza e sembrava un problema.
// De-emphasis di proposito (linea sottile, colore muto): è contesto, non il dato principale.
// `title`: min/max/ultimo per chi passa sopra — il grafico non è mai l'unico modo di leggere il dato.
export default function Sparkline({ data, width = 66, height = 14, color = '#8c8c8c', label, fmt = (v) => String(v) }) {
  const { show, vals, min, max, last } = sparkStats(data)
  if (!show) return null
  const step = width / (vals.length - 1)
  const y = (v) => height - 1 - (v / max) * (height - 2) // 0 in basso, max in alto
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const tip = [label, `min ${fmt(min)}`, `max ${fmt(max)}`, `ultimo ${fmt(last)}`].filter(Boolean).join(' · ')
  return (
    <svg width={width} height={height} style={{ display: 'block', marginTop: 1 }} role="img" aria-label={tip}>
      <title>{tip}</title>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(width - 1).toFixed(1)} cy={y(last).toFixed(1)} r="1.7" fill={color} />
    </svg>
  )
}
