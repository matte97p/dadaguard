import { useEffect } from 'react'

// Le dashboard (l'andamento di Deploy, e le altre viste «Andamento») prendono tutta la larghezza dello
// schermo, come Grafana: i grafici del tempo guadagnano punti leggibili. Le liste no, perche' una
// tabella larga 2000px non si legge (vedi `.dg-page` in app.css). La larghezza la decide la colonna
// <main> del guscio, che non sa quale vista e' aperta: la vista lo dice da se', finche' e' montata.
export function useSchermoPieno(attivo = true) {
  useEffect(() => {
    if (!attivo || typeof document === 'undefined') return undefined
    const main = document.querySelector('main.ui-main')
    main?.classList.add('ui-main-pieno')
    return () => main?.classList.remove('ui-main-pieno')
  }, [attivo])
}
