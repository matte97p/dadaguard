import { useEffect } from 'react'

// Pannello di dettaglio a destra. Esc e il clic sul fondo lo chiudono: sono i due gesti che la gente
// prova prima di cercare la crocetta.
export default function Drawer({ aperto, onChiudi, titolo, sopra, sotto, children, etichettaChiudi = 'Chiudi' }) {
  useEffect(() => {
    if (!aperto) return undefined
    const onKey = (e) => e.key === 'Escape' && onChiudi?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [aperto, onChiudi])
  // Sullo schermo largo il pannello si aggancia accanto alla pagina (ui.css): la classe sulla radice
  // dice alla pagina di lasciargli il posto.
  useEffect(() => {
    if (!aperto) return undefined
    document.documentElement.classList.add('ui-drawer-aperto')
    return () => document.documentElement.classList.remove('ui-drawer-aperto')
  }, [aperto])
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
