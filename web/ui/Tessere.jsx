import { riduci } from '../grafici.js'

// La FILA DI NUMERI in cima a un cruscotto: quattro o cinque tessere piatte, un numero grande per
// tessera e il suo andamento in piccolo. Nessun bordo colorato e nessun riquadro dentro al riquadro:
// il colore sta solo sul NUMERO, e solo quando il numero e' cattivo, cosi' in una fila di cinque si
// vede subito quale guardare.
//
// Le regole vengono dalla guida dataviz: l'andamento e' nel tono di contesto (`--chart-neutro`), con
// l'ultimo punto un passo piu' scuro; un valore che non si sa e' un trattino, mai uno zero.

// La fila: le linee sottili fra le tessere sono lo spazio fra le celle di una griglia col fondo del
// colore della linea, non un bordo per tessera, cosi' restano una sola linea anche quando la fila va
// a capo.
export function Tessere({ children, etichetta }) {
  return (
    <section className="ui-tessere" aria-label={etichetta}>
      {children}
    </section>
  )
}

// Una tessera. `valore` gia' formattato (stringa o numero); `null` e' «non lo so». `livello` colora il
// numero (`crit`, `warn`) e nient'altro. `trend`: { valori, forma: 'linea' | 'barre', dominio,
// descrizione } per l'andamento; `descrizione` e' il testo che il mouse e il lettore di schermo
// trovano al posto del disegno.
export function Tessera({ etichetta, valore, unita, livello, sotto, trend, title }) {
  const ignoto = valore == null || valore === ''
  return (
    <div className="ui-tessera" title={title}>
      <span className="ui-tessera-et">{etichetta}</span>
      <span className="ui-tessera-riga">
        <b className={`ui-tessera-n ${!ignoto && livello ? `ui-t-${livello}` : ''} ${ignoto ? 'ui-tessera-ignoto' : ''}`}>
          {ignoto ? '-' : valore}
          {!ignoto && unita && <small>{unita}</small>}
        </b>
        {trend && <Trend {...trend} />}
      </span>
      {sotto && <span className="ui-tessera-sotto">{sotto}</span>}
    </div>
  )
}

// L'andamento della tessera: una linea da 2px o colonnine, alte al massimo 28px. I punti `null` sono
// buchi (linea) o colonne mancanti (barre), non zeri.
export function Trend({ valori: tutti = [], forma = 'linea', dominio = null, descrizione, larghezza = 92, altezza = 28 }) {
  // Oltre le dodici colonne una tessera diventa un codice a barre: si sommano le fasce a due a due (o
  // a tre), contando dalla fine, cosi' l'ultima colonna resta «adesso».
  const valori = forma === 'barre' && tutti.length > 12 ? riduci(tutti, Math.ceil(tutti.length / 12), 'somma') : tutti
  const noti = valori.filter((v) => v != null && Number.isFinite(v))
  if (noti.length < 2 && forma === 'linea') return null
  if (!noti.length) return null
  const lo = Number.isFinite(dominio?.[0]) ? Math.min(dominio[0], ...noti) : forma === 'barre' ? 0 : Math.min(...noti)
  const hi = Math.max(Number.isFinite(dominio?.[1]) ? dominio[1] : -Infinity, ...noti)
  const span = hi - lo || 1
  const n = valori.length
  const ultimo = valori.reduce((u, v, i) => (v != null ? i : u), -1)
  if (forma === 'barre') {
    const banda = larghezza / n
    const w = Math.max(3, Math.min(10, banda * 0.62))
    return (
      <svg className="ui-trend" width={larghezza} height={altezza} viewBox={`0 0 ${larghezza} ${altezza}`} role="img" aria-label={descrizione}>
        {descrizione && <title>{descrizione}</title>}
        <line x1="0" x2={larghezza} y1={altezza - 0.5} y2={altezza - 0.5} className="ui-trend-base" />
        {valori.map((v, i) => {
          if (v == null || v <= lo) return null
          const h = Math.max(2, ((v - lo) / span) * (altezza - 2))
          const x = i * banda + (banda - w) / 2
          return <rect key={i} x={x} y={altezza - h} width={w} height={h} rx="1.5" className={i === ultimo ? 'ui-trend-ora' : 'ui-trend-mark'} />
        })}
      </svg>
    )
  }
  const x = (i) => 2 + (i * (larghezza - 6)) / Math.max(1, n - 1)
  const y = (v) => altezza - 3 - ((v - lo) / span) * (altezza - 6)
  let d = ''
  let dentro = false
  valori.forEach((v, i) => {
    if (v == null) return void (dentro = false)
    d += `${dentro ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    dentro = true
  })
  return (
    <svg className="ui-trend" width={larghezza} height={altezza} viewBox={`0 0 ${larghezza} ${altezza}`} role="img" aria-label={descrizione}>
      {descrizione && <title>{descrizione}</title>}
      <path d={d} className="ui-trend-linea" />
      {ultimo >= 0 && <circle cx={x(ultimo)} cy={y(valori[ultimo])} r="3" className="ui-trend-punto" />}
    </svg>
  )
}
