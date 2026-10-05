// Pillola di stato: il colore dice il livello, il testo lo ripete a parole. Mai solo colore: chi non
// distingue il rosso dal verde deve poter leggere lo stesso.
export default function Pill({ livello = 'off', children, title }) {
  return (
    <span className={`ui-pill ui-${livello}`} title={title}>
      {children}
    </span>
  )
}

// Pallino di stato, per i posti dove una parola non ci sta (selettore d'ambiente, card).
export function Dot({ livello = 'off', title }) {
  return <span className={`ui-dot ui-${livello}`} title={title} aria-hidden={title ? undefined : true} />
}
