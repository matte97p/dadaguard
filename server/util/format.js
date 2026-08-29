// Formattatori condivisi per l'output utente (summary delle card). Estratti da lambda.js per riuso fra
// i runtime provider, così durate e conteggi sono leggibili ovunque invece di ms grezzi / numeri lunghi.

// Durata leggibile: ms sotto il secondo, s fino al minuto, "Xm Ys" fino all'ora, poi "Xh Ym"
// (245759ms → "4m 6s", 14096000ms → "3h 55m").
//
// Il ramo delle ore è arrivato dopo, e il perché vale la pena scriverlo: questa funzione è nata per la
// LATENZA (p95 di lambda e ALB, dove già 4m è un numero enorme), poi la stessa la usa la DURATA di una
// run, che di ore ne fa parecchie. Una run viva da tre ore e mezza si leggeva "234m 56s": un numero che
// chi legge deve dividere a mente per capire da quanto sta girando.
//
// Due dettagli che sembrano pignoleria e non lo sono: (1) sopra l'ora i secondi spariscono, perché a
// quella scala sono rumore; (2) ogni scalino si decide sul valore ARROTONDATO e i resti si arrotondano
// sul TOTALE, se no escono unità che non esistono. Le sbagliava tutte e tre: 59,7s dava "60s", 1m 59,7s
// dava "1m 60s" e 3h 59m 40s avrebbe dato "3h 60m". Stessa ragione per la coda a zero: 9999ms non è
// "10.0s" quando 10000ms è "10s" (la regola l'ha già fmtCount qui sotto).
//
// Una durata negativa è "—", non "-12000ms": esiste per davvero (`endedAt - startedAt` con gli orologi
// di due macchine che non concordano, vedi server/prefect.js) ed è un tempo che non significa niente.
//
// Niente ramo dei giorni: il giorno è "g" in italiano e "d" in inglese, quindi lo possiede il dizionario
// (`time.unit.d`) e servirebbe un `t` VERO in ogni chiamante. Il default identità che usano fmtAgo e
// fmtSchedule qui non basterebbe: stamperebbe la chiave, "12time.unit.d". Chi la scala in giorni ce l'ha
// già ed è `fmtElapsed` in server/i18n.js, che il `t` lo riceve. "30h 5m" si legge lo stesso, e una run
// da trenta ore è già una notizia di suo.
export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totSec = Math.round(ms / 1000)
  if (totSec < 60) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0).replace(/\.0$/, '')}s`
  if (totSec < 3600) {
    const m = Math.floor(totSec / 60)
    const s = totSec % 60
    return s ? `${m}m ${s}s` : `${m}m`
  }
  const totMin = Math.round(totSec / 60)
  const h = Math.floor(totMin / 60)
  const m = totMin % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

// «I primi N, e poi +M»: la stessa regola serve ai target fuori di un load balancer, alle istanze di un
// cluster RDS, ai security group aperti, agli allarmi attivi, ai secret mancanti e alle regole WAF. Era
// scritta sei volte in sei grafie diverse, e tre tagliavano SENZA dirlo — una lista troncata in silenzio
// fa concludere che gli elementi siano quelli, che è il modo peggiore di risparmiare caratteri.
//
// Niente `t`: «+3» non ha lingua. Passarlo dal dizionario aggiungeva una chiave da tenere allineata in
// due bundle e un modo di perdere tutto (con un `t` identità usciva la chiave al posto dei nomi).
export function truncateItems(items, max = 2) {
  return items.length > max ? [...items.slice(0, max), `+${items.length - max}`] : [...items]
}

export const truncateList = (items, max = 2) => truncateItems(items, max).join(', ')

// Conteggio compatto: 1234 → "1.2k", 9999 → "10k", 15000 → "15k", sotto 1000 invariato.
export function fmtCount(n) {
  if (!Number.isFinite(n)) return '—'
  const scale = (v, suffix) => v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, '') + suffix
  if (n >= 1e9) return scale(n / 1e9, 'B')
  if (n >= 1e6) return scale(n / 1e6, 'M') // 1.788M invece di 1788k
  if (n >= 1000) return scale(n / 1000, 'k')
  return String(n)
}
