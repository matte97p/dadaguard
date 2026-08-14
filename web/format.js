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

// "Quanto fa", con le unità che cambiano scala: minuti → ore → giorni → settimane, così non si legge
// mai "419h fa". Sta qui e non dentro una pagina perché la usano la vista Deploy e la vista Adesso, e
// due implementazioni della stessa frase divergono al primo ritocco. Puro/testabile.
export function fmtAgo(from, t = (k) => k, now = Date.now()) {
  if (!from) return ''
  const min = Math.max(0, Math.round((now - new Date(from).getTime()) / 60000))
  if (min < 1) return t('ago.now')
  if (min < 60) return t('ago.min', { m: min })
  const h = Math.floor(min / 60)
  if (h < 24) return t('ago.h', { h, m: min % 60 })
  const d = Math.floor(h / 24)
  if (d < 7) return t('ago.d', { d, h: h % 24 })
  return t('ago.w', { w: Math.floor(d / 7), d: d % 7 })
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

// Vale la pena disegnare questa serie? Un mini-grafico in una card è CONTESTO di un numero che è
// già scritto lì accanto: se non aggiunge una forma leggibile è solo un filetto che confonde
// («grafici incomprensibili»). Si disegna solo quando c'è un andamento vero da vedere:
//   · almeno 3 punti validi (con 2 è un segmento, non un andamento);
//   · scala con lo ZERO in basso — così una variazione piccola SEMBRA piccola invece di riempire
//     tutta l'altezza (la scala min-max trasforma il rumore in una montagna);
//   · e con lo zero in basso, sotto il 10% di escursione non c'è niente da vedere → niente grafico.
// Ritorna anche min/max/ultimo, che finiscono nel tooltip: il grafico non è mai l'UNICO modo di
// leggere il dato. Puro/testabile.
export function sparkStats(data) {
  const vals = (data ?? []).filter((v) => Number.isFinite(v))
  if (vals.length < 3) return { show: false, vals: [] }
  const max = Math.max(...vals)
  const min = Math.min(...vals)
  const show = max > 0 && (max - min) / max >= 0.1
  return { show, vals, min, max, last: vals[vals.length - 1] }
}

// Conteggio compatto: 1234 → "1.2k", 9999 → "10k", 15000 → "15k", sotto 1000 invariato.
export function fmtCount(n) {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k'
  return String(n)
}

// La metrica di latenza dichiarata dal server (`kind: 'latency'`): dedurla dall'unità sarebbe
// fragile, una latenza senza serie non ha `sparkUnit`.
export function latencyMetric(runtime) {
  return (runtime?.metrics ?? []).find((m) => m.kind === 'latency') ?? null
}

// Che latenza mostrare in colonna, e da DOVE viene. Due fonti che NON vanno confuse:
//   - `metric`: quella che il servizio misura di suo (CloudWatch: p95 del target ALB, durata lambda);
//   - `probe`:  il giro completo della sonda HTTP di Dadaguard (rete + Cloudflare + servizio),
//               misurato da fuori — più grande della prima per costruzione.
// La seconda esiste solo dove c'è un `healthUrl`, e va SEMPRE etichettata: una colonna che mescola
// le due tacendolo fa confrontare mele con arance ("il backend è 10 volte più lento di ieri").
// Prima la metrica: se il servizio sa dire la sua latenza, la sua parola vale più della nostra.
export function latencyOf(service) {
  const m = latencyMetric(service?.checks?.runtime)
  if (m && Number.isFinite(m.ms)) return { ms: m.ms, source: 'metric', metric: m }
  const ms = service?.checks?.liveness?.latencyMs
  return Number.isFinite(ms) ? { ms, source: 'probe' } : null
}

// Quanti servizi per stato, dal peggio al meglio: la domanda "devo preoccuparmi?" deve avere
// risposta SENZA ordinare o filtrare niente. Ordine fisso (giù → degradato → sconosciuto →
// inattivo → disattivato → su), stati assenti omessi: una striscia di zeri non informa.
const STATUS_ORDER = ['down', 'degraded', 'unknown', 'idle', 'disabled', 'up']
export function countByStatus(services) {
  const n = new Map()
  for (const s of services ?? []) {
    const k = s?.overall ?? 'unknown'
    n.set(k, (n.get(k) ?? 0) + 1)
  }
  const known = STATUS_ORDER.filter((k) => n.has(k)).map((k) => ({ status: k, count: n.get(k) }))
  // Uno stato che il server introducesse domani non deve sparire dalla striscia solo perché questo
  // elenco non lo conosce: finisce in coda, in ordine alfabetico.
  const extra = [...n.keys()].filter((k) => !STATUS_ORDER.includes(k)).sort()
  return [...known, ...extra.map((k) => ({ status: k, count: n.get(k) }))]
}

// Un clic sulla RIGA apre il servizio. Ma una riga cliccabile non deve rubare i gesti che già
// esistono al suo interno, altrimenti diventa una trappola:
//   - link e bottoni (apri endpoint, log, eventi, rimuovi, freccia di espansione) hanno già il loro;
//   - la colonna azioni è tutta gesti: nessun clic lì deve navigare;
//   - se stai SELEZIONANDO del testo (trascini per copiare un nome) il rilascio del mouse è un clic:
//     aprire un pannello mentre copi è il modo più rapido di far perdere la selezione.
// Puro/testabile: prende il bersaglio (qualunque cosa sappia fare `closest`) e il testo selezionato.
const ROW_CLICK_EXEMPT = 'a, button, input, .dg-actions, .ant-table-row-expand-icon, [data-no-row-click]'
export function rowClickOpens(target, selection = '') {
  if (String(selection ?? '').trim()) return false
  if (!target || typeof target.closest !== 'function') return true
  return !target.closest(ROW_CLICK_EXEMPT)
}

// Quali schede ha senso mostrare nel pannello di un servizio. Una scheda che apre un pannello vuoto
// ("questo tipo non ha log") è una promessa non mantenuta: meglio non offrirla.
//   - log    → solo dove esiste un log group da leggere (lambda, ECS, ECS schedulato);
//   - eventi → dove AWS racconta eventi/modifiche (tutto tranne i worker Cloudflare, che non stanno
//              in CloudTrail);
//   - deploy → dove c'è davvero una build da mostrare (il segnale versione), altrimenti la pagina
//              Deploy non ha nulla su questo servizio.
const LOG_TYPES = ['lambda', 'ecs', 'ecs-scheduled']
// Task id dal nome dello stream: su ECS lo stream è `<prefisso>/<container>/<taskId>`.
export const taskOfStream = (stream) => String(stream ?? '').split('/').pop() || null

// Voci del selettore di istanza nel pannello log. `allLabel` è la prima ("Tutte"), con valore vuoto.
// Due invarianti che sembrano dettagli e non lo sono:
//  · l'istanza ATTIVA è sempre presente, anche se non è ancora comparsa in una risposta — un Select col
//    valore fuori dalle opzioni mostra la casella vuota, cioè "nessun filtro" mentre il filtro c'è;
//  · «Tutte» c'è sempre, altrimenti chi arriva dalla scheda Istanze non ha modo di tornare indietro.
export function instanceOptions(knownTasks = [], task = null, allLabel = 'Tutte', shorten = (s) => s) {
  const ids = [...new Set([...knownTasks, task].filter(Boolean))].sort()
  return [{ value: '', label: allLabel }, ...ids.map((id) => ({ value: id, label: shorten(id) }))]
}

export function detailTabs(service) {
  return {
    logs: LOG_TYPES.includes(service?.type),
    events: Boolean(service?.type) && service.type !== 'cloudflare-worker',
    deploy: Boolean(service?.checks?.version),
    // Istanze = un servizio ECS long-running, che ha replica da confrontare. Un cron su RunTask no: i
    // suoi task nascono e muoiono a ogni esecuzione, e una foto delle risorse "adesso" non dice niente.
    instances: service?.type === 'ecs',
  }
}

// Somma i trend di più account in una serie sola: la domanda "la spesa sta crescendo?" riguarda il
// conto totale, non un account per volta (tre grafici da confrontare a occhio non rispondono).
// Un mese resta PARZIALE se lo è per qualcuno: mescolare un mese chiuso con uno in corso e chiamarlo
// chiuso farebbe leggere un crollo dove c'è solo un mese incompleto. Puro/testabile.
export function mergeTrend(accounts = []) {
  const byMonth = new Map()
  for (const acc of accounts) {
    for (const r of acc?.months ?? []) {
      if (!r?.month) continue
      const cur = byMonth.get(r.month) ?? { month: r.month, usage: 0, invoiced: 0, aiUsage: 0, infraUsage: 0, partial: false }
      cur.usage += r.usage ?? 0
      cur.invoiced += r.invoiced ?? 0
      cur.aiUsage += r.aiUsage ?? 0
      cur.infraUsage += r.infraUsage ?? (r.usage ?? 0) - (r.aiUsage ?? 0)
      cur.partial = cur.partial || Boolean(r.partial)
      byMonth.set(r.month, cur)
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
}

// Chi ha deployato, in forma leggibile — gemello di `shortActor` in server/util/principal.js.
// Il valore grezzo è l'email dell'autore del commit, e le noreply di GitHub portano davanti l'id
// numerico dell'utente: `12345678+dev@users.noreply.github.com` mostrato come
// "12345678+dev" è un numero di serie, non una persona. L'email intera resta nel dettaglio.
export function shortActor(who) {
  const s = String(who ?? '').trim()
  if (!s) return null
  const at = s.indexOf('@')
  if (at <= 0) return s
  return s.slice(0, at).replace(/^\d+\+/, '') || s
}

// MOTIVO di una build fallita, in una riga leggibile.
//
// CodeBuild, quando una fase muore, restituisce come "messaggio" il COMANDO INTERO che stava eseguendo:
// su un buildspec con un `if` di venti righe (attesa del rollout ECS, describe-services, echo dei
// messaggi) esce un muro di shell in cui la parte utile — l'esito, e il nome della fase — sta in fondo.
// Nella pagina «Adesso» quel muro occupa mezzo schermo per una riga di elenco.
//
// Qui si tiene ciò che risponde alla domanda: com'è morto, e quale comando era. Lo script si butta; il
// testo integrale resta nel dettaglio della build (pagina Deploy) e nel `title` della riga, quindi non
// si perde niente. Pura/testabile.
export function compactBuildReason(reason, { max = 150, cmd = 56 } = {}) {
  const raw = String(reason ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  // Forma tipica: `[CODICE:] Error while executing command: <script>. Reason: exit status 1`
  const m = /Error while executing command:\s*([\s\S]*?)\.?\s*Reason:\s*(.+)$/i.exec(raw)
  if (m) {
    const script = m[1].trim()
    const primo = script.split(/;|&&|\|\|/)[0].trim()
    // I puntini si mettono solo se si è tagliato per davvero: metterli sempre fa sembrare troncato un
    // comando che era intero (`npm test…`), e allora non significano più niente.
    const testa = primo.length > cmd ? `${primo.slice(0, cmd)}…` : primo !== script ? `${primo}…` : primo
    return [m[2].trim(), testa].filter(Boolean).join(' · ')
  }
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw
}
