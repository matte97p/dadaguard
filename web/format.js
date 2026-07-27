// Formattatori lato client — gemelli di server/util/format.js (client e server sono bundle separati,
// non condividono codice). Tienili allineati.

// Latenza leggibile: ms sotto il secondo, s fino al minuto, poi "Xm Ys" (245759ms → "4m 6s").
export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}

// Cadenza di un cron in parole: "1440m" (come arriva da EventBridge) non dice niente a chi legge →
// "ogni 1g". Stesse unità di server/runtime/*.js (fmtDur) così la cadenza nell'header e quella dentro
// il testo del check coincidono. Input non riconosciuto → invariato (mai inventare).
export function fmtSchedule(schedule, t = (k) => k) {
  const min = Number(String(schedule ?? '').match(/^(\d+)m$/)?.[1])
  if (!Number.isFinite(min) || min <= 0) return schedule ?? null
  const every =
    min % 1440 === 0 ? `${min / 1440}${t('time.unit.d')}` : min >= 60 ? `${Math.round(min / 60)}${t('time.unit.h')}` : `${min}${t('time.unit.m')}`
  return t('card.cron.every', { every })
}

// Conteggio compatto: 1234 → "1.2k", 9999 → "10k", 15000 → "15k", sotto 1000 invariato.
export function fmtCount(n) {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k'
  return String(n)
}
