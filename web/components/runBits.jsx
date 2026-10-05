import { useEffect, useState } from 'react'
import { Pill } from '../ui/index.js'
import { livelloCorsa, durataCorsa } from '../rilasci.js'

// Vocabolario visivo delle esecuzioni, in un posto solo: la pagina, il pannello dei log e la striscia
// delle corse devono colorare 'failed' allo stesso modo, o il colore smette di essere un segnale. Le
// regole (esito → livello) stanno in web/rilasci.js, dove i test le vedono.
export function OUTCOME_TAG(outcome, t = (k) => k) {
  if (!outcome) return null
  return <Pill livello={livelloCorsa({ outcome })}>{t(`runs.outcome.${outcome}`)}</Pill>
}

// Durata di una run: quella vera se e' finita, quella maturata FINORA se sta girando. Gemella di
// `runDuration` in server/runs.js (client e server sono bundle separati).
export const runElapsed = (run, now = Date.now()) => durataCorsa(run, now)

// Un orologio che batte SOLO se c'e' qualcosa che sta girando. Su una pagina di run tutte finite non
// serve ridisegnare nulla ogni secondo: i numeri sono fermi.
export function useTick(active, ms = 1000) {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(timer)
  }, [active, ms])
}
