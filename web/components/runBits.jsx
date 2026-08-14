import { useEffect, useState } from 'react'
import { Tag } from 'antd'
import { LEVEL } from '../theme.js'

// Vocabolario visivo delle esecuzioni, in un posto solo: la pagina, il pannello dei log e (domani)
// qualunque altra vista devono colorare 'failed' allo stesso modo, o il colore smette di essere un
// segnale — è la ragione per cui esiste web/theme.js.
export const OUTCOME_LEVEL = {
  running: 'info',
  ok: 'ok',
  failed: 'bad',
  cancelled: 'muted',
  unknown: 'warn',
  scheduled: 'muted',
}

export const outcomeColor = (outcome) => LEVEL[OUTCOME_LEVEL[outcome] ?? 'muted'].color

export function OUTCOME_TAG(outcome, t = (k) => k) {
  if (!outcome) return null
  return (
    <Tag bordered={false} color={LEVEL[OUTCOME_LEVEL[outcome] ?? 'muted'].tag} style={{ marginInlineEnd: 0 }}>
      {t(`runs.outcome.${outcome}`)}
    </Tag>
  )
}

// Durata di una run: quella vera se è finita, quella maturata FINORA se sta girando. Gemella di
// `runDuration` in server/runs.js (client e server sono bundle separati). Pura/testabile.
export function runElapsed(run, now = Date.now()) {
  if (!run?.startedAt) return null
  const end = run.running ? now : run.endedAt
  if (!end) return null
  return Math.max(0, end - run.startedAt)
}

// Un orologio che batte SOLO se c'è qualcosa che sta girando. Su una pagina di run tutte finite non
// serve ridisegnare nulla ogni secondo: i numeri sono fermi, e un re-render al secondo su una tabella
// lunga si sente.
export function useTick(active, ms = 1000) {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(timer)
  }, [active, ms])
}
