import { useEffect, useId, useRef, useState } from 'react'

// Finestra di dettaglio CENTRATA, per lo schermo largo (dal 07/10/2026). Il pannello laterale
// (`Drawer`) su un monitor largo si legge male: una colonna stretta incollata al bordo destro, con i
// grafici schiacciati e meta' schermo vuoto. Qui il dettaglio sta al centro, largo fino a ~960px e
// alto fino all'85% dello schermo, con lo scorrimento DENTRO.
//
// Le stesse promesse di una finestra modale vera:
//   · Esc, il clic sul fondo e la crocetta la chiudono;
//   · il fuoco entra (sul titolo, cosi' lo screen reader legge il nome) e resta dentro: Tab e
//     Maiusc+Tab girano fra i comandi della finestra; alla chiusura torna dove era;
//   · `role="dialog"`, `aria-modal` e il titolo come nome (`aria-labelledby`);
//   · la pagina sotto non scorre finche' e' aperta.
// La stessa firma di `Drawer` (titolo, sopra, sotto, etichettaChiudi), cosi' una pagina sceglie l'uno
// o l'altro secondo lo schermo senza cambiare il contenuto (vedi `useSchermoLargo`).
const FOCUSABILI = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

export default function Modale({ aperto, onChiudi, titolo, sopra, sotto, children, etichettaChiudi = 'Chiudi', className = '' }) {
  const finestra = useRef(null)
  const titoloRef = useRef(null)
  const idTitolo = useId()
  // `onChiudi` cambia a ogni render della pagina: letto da un ref, l'effetto del fuoco gira una volta
  // per apertura e non ruba il fuoco a ogni aggiornamento dei dati (la pagina interroga ogni minuto).
  const chiudi = useRef(onChiudi)
  chiudi.current = onChiudi

  useEffect(() => {
    if (!aperto) return undefined
    const prima = document.activeElement
    const html = document.documentElement
    const overflow = html.style.overflow
    html.style.overflow = 'hidden'
    titoloRef.current?.focus({ preventScroll: true })
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        chiudi.current?.()
        return
      }
      if (e.key !== 'Tab' || !finestra.current) return
      const voci = [...finestra.current.querySelectorAll(FOCUSABILI)].filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (!voci.length) {
        e.preventDefault()
        return
      }
      const primo = voci[0]
      const ultimo = voci[voci.length - 1]
      const dentro = finestra.current.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === primo || !dentro || document.activeElement === titoloRef.current)) {
        e.preventDefault()
        ultimo.focus()
      } else if (!e.shiftKey && (document.activeElement === ultimo || !dentro)) {
        e.preventDefault()
        primo.focus()
      }
    }
    // Il fuoco che scappa (un clic sul fondo, lo screen reader) torna dentro.
    const onFocus = (e) => {
      if (finestra.current && !finestra.current.contains(e.target)) titoloRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus)
      html.style.overflow = overflow
      if (prima && typeof prima.focus === 'function' && document.contains(prima)) prima.focus({ preventScroll: true })
    }
  }, [aperto])

  if (!aperto) return null
  return (
    <div
      className="ui-modale-fondo"
      // `mousedown` e non `click`: chi seleziona del testo dentro e rilascia fuori non chiude per sbaglio.
      onMouseDown={(e) => e.target === e.currentTarget && onChiudi?.()}
    >
      <div ref={finestra} className={`ui-modale ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={idTitolo}>
        <header className="ui-modale-testa">
          <div>
            {sopra}
            <h3 id={idTitolo} ref={titoloRef} tabIndex={-1}>
              {titolo}
            </h3>
            {sotto && <div className="ui-mute ui-modale-sotto">{sotto}</div>}
          </div>
          <button type="button" className="ui-x" onClick={onChiudi} aria-label={etichettaChiudi}>
            ✕
          </button>
        </header>
        <div className="ui-modale-corpo">{children}</div>
      </div>
    </div>
  )
}

// Vero quando lo schermo e' largo abbastanza per la finestra centrata. Il punto di rottura e' quello
// dell'app (`ui.css`: sotto gli 860px il menu va sopra al contenuto), cosi' la finestra e il resto
// della pagina cambiano forma insieme.
export const SCHERMO_LARGO = '(min-width: 861px)'

export function useSchermoLargo(query = SCHERMO_LARGO) {
  const leggi = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches)
  const [largo, setLargo] = useState(leggi)
  useEffect(() => {
    const mq = typeof window !== 'undefined' ? window.matchMedia?.(query) : null
    if (!mq) return undefined
    const cambia = () => setLargo(mq.matches)
    cambia()
    mq.addEventListener?.('change', cambia)
    return () => mq.removeEventListener?.('change', cambia)
  }, [query, setLargo])
  return largo
}
