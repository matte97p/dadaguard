// «Apri altrove»: i link alle console che ne sanno di piu', gia' filtrati. `link`: [{ label, href,
// nota }]. Le voci senza href si saltano: un link che non porta da nessuna parte e' peggio di nessuno.
export default function ListaLink({ link = [] }) {
  const voci = link.filter((l) => l?.href)
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
