import { useState } from 'react'

// Un comando da copiare. Dadaguard non esegue niente: dice cosa lanciare e lo mette negli appunti.
// Se gli appunti non sono disponibili (pagina non sicura, permesso negato) il bottone lo dice e il
// testo resta selezionabile, invece di fingere di aver copiato.
export default function BloccoComando({ comando, t = (k) => k }) {
  const [stato, setStato] = useState('')
  if (!comando) return null
  const copia = () => {
    const p = navigator.clipboard?.writeText(comando)
    if (!p) return setStato('ko')
    p.then(() => setStato('ok')).catch(() => setStato('ko'))
  }
  return (
    <div className="ui-cmd">
      <code>{comando}</code>
      <button type="button" onClick={copia}>
        {stato === 'ok' ? t('ui.copiato') : stato === 'ko' ? t('ui.seleziona') : t('ui.copia')}
      </button>
    </div>
  )
}

// Lo stesso comando, ma IN RIGA: un gettone di codice col suo «Copia», da mettere in una frase o in
// fondo a una riga. E' quello del cruscotto (07/10/2026): il riquadro sopra, dentro una card dentro
// una sezione, faceva tre scatole una dentro l'altra per una riga di testo.
export function ComandoInline({ comando, t = (k) => k }) {
  const [stato, setStato] = useState('')
  if (!comando) return null
  const copia = (e) => {
    e.stopPropagation()
    const p = navigator.clipboard?.writeText(comando)
    if (!p) return setStato('ko')
    p.then(() => setStato('ok')).catch(() => setStato('ko'))
  }
  return (
    <span className="ui-cmd-in">
      <code>{comando}</code>
      <button type="button" onClick={copia} aria-label={`${t('ui.copia')}: ${comando}`}>
        {stato === 'ok' ? t('ui.copiato') : stato === 'ko' ? t('ui.seleziona') : t('ui.copia')}
      </button>
    </span>
  )
}

// Il riquadro «cosa fare»: titolo, spiegazione e il comando. Prende il colore del livello, cosi' il
// rimedio di un guasto rosso si vede rosso anche dentro al pannello.
export function Rimedio({ livello, titolo, testo, comando, t }) {
  return (
    <div className={`ui-fix ${livello ? `ui-fix-${livello}` : ''}`}>
      {titolo && <b>{titolo}</b>}
      {testo && <span>{testo}</span>}
      <BloccoComando comando={comando} t={t} />
    </div>
  )
}
