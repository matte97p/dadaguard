// Barra di riempimento (budget, quote, ripartizioni). `valore` in percento; sopra il 100 la barra si
// ferma piena, il numero vero lo dice il testo accanto.
export default function Meter({ valore = 0, livello = 'brand', title }) {
  const w = Math.max(0, Math.min(100, Number(valore) || 0))
  return (
    <div className="ui-meter" title={title} role="meter" aria-valuenow={Math.round(Number(valore) || 0)} aria-valuemin={0} aria-valuemax={100}>
      <i className={`ui-bg-${livello}`} style={{ width: `${w}%` }} />
    </div>
  )
}
