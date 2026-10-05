// «Apri altrove»: i link alle console che ne sanno di piu', gia' filtrati. `link`: [{ label, href,
// nota }]. Le voci senza href si saltano: un link che non porta da nessuna parte e' peggio di nessuno.
// Solo http(s): gli href arrivano anche da config e tag AWS, e un `javascript:` cliccato da un link
// «Apri altrove» eseguirebbe codice nella pagina di chi guarda.
export default function ListaLink({ link = [] }) {
  const voci = link.filter((l) => typeof l?.href === 'string' && /^https?:\/\//i.test(l.href))
  if (!voci.length) return null
  return (
    <div className="ui-lnk">
      {voci.map((l) => (
        <a key={l.href + l.label} href={l.href} target="_blank" rel="noopener noreferrer">
          <span>{l.label}</span>
          {l.nota && <small>{l.nota}</small>}
          <b aria-hidden="true">↗</b>
        </a>
      ))}
    </div>
  )
}
