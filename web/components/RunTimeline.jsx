import { fmtMs } from '../format.js'
import { livelloCorsa, durataCorsa } from '../rilasci.js'

// La striscia delle ultime corse di un cron: un blocco per corsa, dalla piu' vecchia (sinistra) alla
// piu' recente (destra).
//
// Perche' una forma e non un elenco: la risposta a «questo job sta bene?» si vede senza leggere. Un
// blocco che pulsa a destra e' «sta girando adesso», uno molto piu' largo degli altri e' «stanotte ci
// ha messo il triplo», uno rosso in mezzo ai verdi e' la corsa da aprire.
//
// La larghezza e' la durata in RADICE QUADRATA: su un cron che di solito fa 4 secondi e una volta ne
// ha fatti 300, la scala lineare renderebbe le corse normali un filo invisibile. Non e' precisione, e'
// confronto a occhio; il numero esatto sta nel titolo del blocco e nel pannello.
const W_MIN = 4
const W_MAX = 40

export function blockWidth(durationMs, maxMs) {
  const d = Number(durationMs)
  if (!Number.isFinite(d) || d <= 0) return W_MIN
  const max = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : d
  return Math.round(W_MIN + (W_MAX - W_MIN) * Math.sqrt(Math.min(1, d / max)))
}

// Le corse da disegnare con la loro larghezza, sulla scala della RIGA: due cron con durate di ordini
// di grandezza diversi non si confrontano fra loro, e fingere che si possa fare mente.
export function stripBlocks(runs = [], now = Date.now(), max = 12) {
  const ultime = [...runs].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).slice(-max)
  const durate = ultime.map((r) => durataCorsa(r, now) ?? 0)
  const maxMs = Math.max(...durate, 1)
  return ultime.map((r, i) => ({ run: r, width: blockWidth(durate[i], maxMs), durationMs: durate[i] }))
}

// Dentro una riga che e' gia' un bottone i blocchi non possono esserlo a loro volta: la riga apre il
// pannello, e li' ogni corsa si sceglie una per una.
export default function RunTimeline({ runs = [], t = (k) => k, now = Date.now(), max = 12 }) {
  const blocchi = stripBlocks(runs, now, max)
  if (!blocchi.length) return <span className="rl-runs ui-faint">{t('rilasci.cron.nessunaCorsa')}</span>
  return (
    <span className="rl-runs" aria-hidden="true">
      {blocchi.map(({ run, width, durationMs }) => (
        <i
          key={run.id ?? run.startedAt}
          className={`ui-${livelloCorsa(run)}${run.running ? ' rl-viva' : ''}`}
          style={{ width }}
          title={`${run.startedAt ? new Date(run.startedAt).toLocaleString() : '?'} · ${t(`runs.outcome.${run.outcome}`)}${durationMs ? ` · ${fmtMs(durationMs)}` : ''}`}
        />
      ))}
    </span>
  )
}
