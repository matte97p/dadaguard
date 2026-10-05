// Contenitore delle righe, con un'intestazione di colonne opzionale e il messaggio da mostrare quando
// e' vuota: una lista vuota senza parole si legge «non funziona», non «niente da fare».
export default function Lista({ colonne, griglia, vuoto, children }) {
  const righe = Array.isArray(children) ? children.filter(Boolean) : children
  const vuota = righe == null || (Array.isArray(righe) && righe.length === 0)
  return (
    <div className="ui-lista">
      {colonne && !vuota && (
        <div className="ui-thead" style={griglia ? { gridTemplateColumns: griglia } : undefined}>
          {colonne.map((c, i) => (
            <span key={i}>{c}</span>
          ))}
        </div>
      )}
      {vuota ? <div className="ui-vuoto">{vuoto}</div> : righe}
    </div>
  )
}

// Sezione con titolino e sottotitolo, come nel mockup: «Da sistemare · dal piu' grave».
export function Sezione({ titolo, sotto, children, extra }) {
  return (
    <section className="ui-sezione">
      <h2>
        {titolo}
        {sotto && <small>{sotto}</small>}
        {extra && <span className="ui-sezione-extra">{extra}</span>}
      </h2>
      {children}
    </section>
  )
}
