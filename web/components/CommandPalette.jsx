import { useEffect, useMemo, useRef, useState } from 'react'
import { Dot } from '../ui/index.js'
import { displayName, omonimiVisibili, chiaveVisibile, distintivo } from '../serviceName.js'
import { livelloServizio } from '../adattatori.js'

// Palette comandi (⌘K / Ctrl+K): un campo solo per saltare a un servizio o a una pagina.
// ↑/↓ per muoversi, Invio per scegliere, Esc o clic fuori per chiudere.
//
// Servizi e pagine nella stessa lista perche' chi preme ⌘K sa cosa cerca, non in quale delle due
// categorie sta: «deploy» e' una pagina, «deploy-worker» un servizio, e farglielo scegliere prima
// sarebbe un passo in piu' per niente.
export default function CommandPalette({ open, onClose, services = [], pagine = [], onPick, onPagina, t = (k) => k }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    setQ('')
    setIdx(0)
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    const onKey = (e) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(id)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const risultati = useMemo(() => {
    const s = q.trim().toLowerCase()
    const servizi = (s
      ? services.filter(
          (x) =>
            x.name.toLowerCase().includes(s) ||
            displayName(x).toLowerCase().includes(s) ||
            String(x.account?.label ?? '').toLowerCase().includes(s) ||
            String(x.type ?? '').toLowerCase().includes(s),
        )
      : services
    ).map((x) => ({ tipo: 'servizio', servizio: x }))
    const pag = pagine
      .filter((p) => !s || t(`nav.${p.key}`).toLowerCase().includes(s) || p.key.includes(s))
      .map((p) => ({ tipo: 'pagina', pagina: p }))
    // Con la casella vuota prima le pagine (sono poche e sono il salto piu' comune), quando si scrive
    // prima i servizi: chi scrive un nome cerca quasi sempre una risorsa.
    return (s ? [...servizi, ...pag] : [...pag, ...servizi]).slice(0, 40)
  }, [q, services, pagine, t])

  // Righe indistinguibili fra loro (stesso nome, stesso account): a quelle si aggiunge tipo e region,
  // che e' cio' che le separa davvero. Solo a quelle, o diventa rumore su ogni riga.
  const ambigue = useMemo(() => omonimiVisibili(risultati.filter((r) => r.servizio).map((r) => r.servizio)), [risultati])

  if (!open) return null

  // Il nome del tipo nella lingua di chi legge; per un tipo che il dizionario non conosce, il tipo
  // com'e', invece della chiave grezza.
  const tipo = (ty) => {
    const k = `type.${ty}`
    const l = t(k)
    return l === k ? ty : l
  }

  const scegli = (r) => {
    if (!r) return
    if (r.tipo === 'servizio') onPick?.(r.servizio)
    else onPagina?.(r.pagina.to)
    onClose?.()
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, risultati.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      scegli(risultati[idx])
    }
  }

  return (
    <>
      <div className="ui-scrim" onClick={onClose} />
      <div className="ui-pal" role="dialog" aria-label={t('palette.cerca')}>
        <input
          ref={inputRef}
          placeholder={t('palette.placeholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setIdx(0)
          }}
          onKeyDown={onKeyDown}
          aria-label={t('palette.cerca')}
        />
        <div className="ui-pal-lista" role="listbox">
          {risultati.length === 0 && <div className="ui-vuoto">{t('palette.empty')}</div>}
          {risultati.map((r, i) =>
            r.tipo === 'servizio' ? (
              <button
                key={`s:${r.servizio.account?.key ?? ''}:${r.servizio.resourceId ?? r.servizio.name}:${i}`}
                type="button"
                role="option"
                aria-selected={i === idx}
                onMouseEnter={() => setIdx(i)}
                onClick={() => scegli(r)}
              >
                <span>
                  <Dot livello={livelloServizio(r.servizio)} />
                  {displayName(r.servizio)}
                  {ambigue.has(chiaveVisibile(r.servizio)) && distintivo(r.servizio) && <small>{distintivo(r.servizio)}</small>}
                </span>
                <small>{[r.servizio.account?.label, r.servizio.type ? tipo(r.servizio.type) : null].filter(Boolean).join(' · ')}</small>
              </button>
            ) : (
              <button key={`p:${r.pagina.to}`} type="button" role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onClick={() => scegli(r)}>
                <span>{t(`nav.${r.pagina.key}`)}</span>
                <small>{t('palette.pagina')}</small>
              </button>
            ),
          )}
        </div>
      </div>
    </>
  )
}
