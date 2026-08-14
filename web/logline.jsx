// Come si LEGGE una riga di log. Stava dentro il pannello dei log di servizio; ora la stessa lettura
// serve anche ai log di UNA esecuzione (pannello delle run), e due copie dello stesso parser
// divergono al primo ritocco: la riga di errore resterebbe rossa in un pannello e grigia nell'altro.
import { MONO, SURFACE } from './theme.js'

export const LEVEL_COLOR = {
  error: '#ff4d4f',
  fatal: '#ff4d4f',
  critical: '#ff4d4f',
  err: '#ff4d4f',
  warn: '#faad14',
  warning: '#faad14',
  info: '#52c41a',
  debug: '#8c8c8c',
  trace: '#8c8c8c',
}

// righe di piattaforma Lambda (rumore: START/END/REPORT/INIT) — nascoste di default
export const NOISE = /^(START|END|REPORT|INIT_START|XRAY) RequestId/

// Prova a interpretare un evento come log JSON strutturato → { level, msg }. Altrimenti riga grezza.
export function parseEvent(message) {
  const s = (message ?? '').trim()
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s)
      const level = String(o.level ?? o.severity ?? o.lvl ?? o.levelname ?? '').toLowerCase()
      const msg = o.message ?? o.msg ?? o.error ?? o.event ?? null
      if (msg != null) return { level, msg: String(msg) }
    } catch {
      /* non è JSON valido */
    }
  }
  return { level: '', msg: message ?? '' }
}

// Classifica una riga di log grezza (non-JSON) per la resa: 'error' = la riga che dice DAVVERO cosa
// è andato storto (`XxxError:`/`Exception:` / `Traceback` / FATAL/CRITICAL); 'frame' = rumore del
// traceback (`File "..."`, frame interni indentati) da smorzare → l'errore vero salta all'occhio.
export function lineKind(msg) {
  const s = (msg ?? '').trim()
  if (!s) return ''
  if (/^Traceback\b/.test(s) || /^[\w.]+(Error|Exception)\b[^:]*:/.test(s) || /\b(FATAL|CRITICAL)\b/.test(s)) return 'error'
  if (/^File ["']/.test(s) || /^(self\.|raise |return |await |async |with |for |if )/.test(s) || /^[A-Za-z_][\w.]*\([^)]*\)\s*$/.test(s)) return 'frame'
  return ''
}

// Il riquadro monospazio con le righe. `prefix` = cosa mettere fra l'orario e il messaggio (l'istanza,
// nel pannello di servizio; niente, quando la lettura è già ristretta a una sola esecuzione).
export function LogLines({ events = [], prefix = null, maxHeight = '58vh' }) {
  const fmtTs = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '')
  return (
    <div
      style={{
        maxHeight,
        overflow: 'auto',
        fontSize: 12,
        fontFamily: MONO,
        background: SURFACE.rowBg,
        padding: 8,
        borderRadius: 6,
      }}
    >
      {events.map((e, i) => {
        const p = parseEvent(e.message)
        // Livello dichiarato dalla sorgente (log JSON, o l'orchestratore che lo manda già come nome):
        // vince sull'euristica sul testo, che serve solo dove nessuno l'ha detto.
        const level = p.level || String(e.level ?? '').toLowerCase()
        const kind = level ? '' : lineKind(p.msg)
        const msgStyle =
          kind === 'error' ? { color: '#ff4d4f', fontWeight: 600 } : kind === 'frame' ? { opacity: 0.45 } : undefined
        return (
          <div
            key={i}
            style={{
              padding: '3px 2px',
              borderBottom: '1px solid rgba(127,127,127,0.08)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            <span style={{ opacity: 0.5 }}>{fmtTs(e.ts)}</span> {prefix ? prefix(e) : null}{' '}
            {level && <span style={{ color: LEVEL_COLOR[level] ?? undefined, fontWeight: 700 }}>{level.toUpperCase()}</span>}{' '}
            <span style={msgStyle}>{p.msg}</span>
          </div>
        )
      })}
    </div>
  )
}
