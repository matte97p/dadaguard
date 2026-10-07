// Andamento in miniatura. Riceve valori qualsiasi e li normalizza da se': chi chiama non deve sapere
// la scala. Con meno di due punti non disegna niente, perche' una linea da un punto solo non e' un
// andamento.
//
// `dominio` ([min, max], facoltativo) fissa la scala invece di stirarla sui valori: uno swap che va da
// 0,5 a 0,8 GB disegnato da bordo a bordo sembra un'onda di guai, e su 0..16 GB e' la riga piatta
// che e'. I valori fuori dal dominio lo allargano, non vengono tagliati.
const COLORE = { crit: 'var(--crit)', warn: 'var(--warn)', ok: 'var(--ok)', info: 'var(--info)', off: 'var(--off)' }

export default function Sparkline({ valori = [], livello = 'ok', larghezza = 86, altezza = 26, className = '', dominio = null }) {
  const v = valori.filter((x) => Number.isFinite(x))
  if (v.length < 2) return <span className={`ui-spark-vuota ${className}`} aria-hidden="true" />
  const min = Math.min(...v, ...(Number.isFinite(dominio?.[0]) ? [dominio[0]] : []))
  const max = Math.max(...v, ...(Number.isFinite(dominio?.[1]) ? [dominio[1]] : []))
  const span = max - min || 1
  const x = (i) => (i * (larghezza - 4)) / (v.length - 1) + 2
  const y = (n) => altezza - 2 - ((n - min) / span) * (altezza - 6)
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join('')
  const c = COLORE[livello] ?? COLORE.ok
  return (
    <svg className={`ui-spark ${className}`} width={larghezza} height={altezza} viewBox={`0 0 ${larghezza} ${altezza}`} aria-hidden="true">
      <path d={`${d}L${x(v.length - 1)},${altezza}L2,${altezza}Z`} fill={c} opacity=".12" />
      <path d={d} fill="none" stroke={c} strokeWidth="1.5" />
      <circle cx={x(v.length - 1)} cy={y(v.at(-1))} r="2.5" fill={c} />
    </svg>
  )
}
