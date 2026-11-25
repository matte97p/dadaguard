import { useEffect, useRef } from 'react'

// Il pannello aperto adesso. Ne sta aperto UNO: aprirne un altro (un clic su un'altra riga, ora che
// sullo schermo largo la pagina resta cliccabile) chiude quello di prima, invece di impilarli.
let corrente = null
let contatore = 0

// Pannello di dettaglio a destra. Esc e il clic sul fondo lo chiudono: sono i due gesti che la gente
// prova prima di cercare la crocetta.
export default function Drawer({ aperto, onChiudi, titolo, sopra, sotto, children, etichettaChiudi = 'Chiudi' }) {
  const chiudiRef = useRef(onChiudi)
  chiudiRef.current = onChiudi
  useEffect(() => {
    if (!aperto) return undefined
    const mio = { id: ++contatore, chiudi: () => chiudiRef.current?.() }
    if (corrente) corrente.chiudi()
    corrente = mio
    // Sullo schermo largo il pannello si aggancia accanto alla pagina (ui.css): la classe sulla radice
    // dice alla pagina di lasciargli il posto. La toglie solo chi e' ancora quello corrente: il
    // pannello chiuso da un altro si pulisce DOPO che l'altro ha gia' messo la sua.
    document.documentElement.classList.add('ui-drawer-aperto')
    return () => {
      if (corrente !== mio) return
      corrente = null
      document.documentElement.classList.remove('ui-drawer-aperto')
    }
  }, [aperto])
  useEffect(() => {
    if (!aperto) return undefined
    const onKey = (e) => e.key === 'Escape' && onChiudi?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [aperto, onChiudi])
  if (!aperto) return null
  return (
    <>
      <div className="ui-scrim" onClick={onChiudi} />
      <aside className="ui-drawer" role="dialog" aria-modal="true" aria-label={typeof titolo === 'string' ? titolo : undefined}>
        <header>
          <div>
            {sopra}
            <h3>{titolo}</h3>
            {sotto && <span className="ui-mute">{sotto}</span>}
          </div>
          <button type="button" className="ui-x" onClick={onChiudi} aria-label={etichettaChiudi}>
            ✕
          </button>
        </header>
        {children}
      </aside>
    </>
  )
}
