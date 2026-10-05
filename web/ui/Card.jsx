// Riquadro con titolino a sinistra e una nota a destra (un totale, una media). Le card di una stessa
// fila hanno lo stesso aspetto, e' questo che le fa leggere come un insieme.
export default function Card({ titolo, nota, children, className = '', onClick, ...rest }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag className={`ui-card ${onClick ? 'ui-card-btn' : ''} ${className}`} onClick={onClick} type={onClick ? 'button' : undefined} {...rest}>
      {(titolo || nota) && (
        <h4>
          <span>{titolo}</span>
          {nota != null && <span>{nota}</span>}
        </h4>
      )}
      {children}
    </Tag>
  )
}
