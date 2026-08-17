// Sorgente OPZIONALE per le esecuzioni: un orchestratore Prefect.
//
// Perché sta qui, in un watchdog che per il resto legge solo AWS: i job più lunghi e più fragili di
// uno stack (gli scraper) spesso NON sono cron di EventBridge. Li lancia un orchestratore, che può
// girare fuori da AWS (una VM, un datacenter di casa) e che quindi non compare in nessuna API AWS: la
// vista delle esecuzioni, senza, mostrerebbe i cron piccoli e non i job che davvero si vanno a
// guardare. È l'unico modo di rispondere «sta girando adesso?» per quei job.
//
// Principi rispettati: read-only (solo `*/filter`, che nell'API di Prefect sono POST di sola lettura),
// nessun LLM, zero storage. E come l'integrazione Cloudflare: senza configurazione la sorgente non
// esiste e la sezione non compare: non è un errore, è spenta.
//
// Configurazione (env, come il token Cloudflare):
//   PREFECT_API_URL          es. https://prefect.example.com/api  (anche senza `/api`: si aggiunge)
//   PREFECT_API_AUTH_STRING  `utente:password` dell'auth applicativa → header Basic
//   PREFECT_API_KEY          alternativa (Prefect Cloud) → header Bearer
// Il valore non viene mai loggato né restituito: esce solo l'esito delle chiamate.

const TIMEOUT_MS = Number(process.env.DADAGUARD_PREFECT_TIMEOUT_MS) || 8000

// Env → { url, headers } oppure null se la sorgente non è configurata. Pura (l'env si passa).
export function prefectConfig(env = process.env) {
  const raw = String(env.PREFECT_API_URL ?? '').trim()
  if (!raw) return null
  const base = raw.replace(/\/+$/, '')
  const url = /\/api$/.test(base) ? base : `${base}/api`
  const headers = { 'content-type': 'application/json' }
  const key = String(env.PREFECT_API_KEY ?? '').trim()
  const auth = String(env.PREFECT_API_AUTH_STRING ?? '').trim()
  if (key) headers.authorization = `Bearer ${key}`
  else if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`
  return { url, headers }
}

// Stato Prefect → lo stesso vocabolario di esiti delle run AWS (server/runs.js), così la UI ha UNA
// tabella e non due. `PAUSED`/`SUSPENDED` contano come in corso: il job non è finito. Pura.
export function stateToOutcome(stateType) {
  switch (String(stateType ?? '').toUpperCase()) {
    case 'COMPLETED':
      return 'ok'
    case 'FAILED':
    case 'CRASHED':
      return 'failed'
    case 'CANCELLED':
    case 'CANCELLING':
      return 'cancelled'
    case 'RUNNING':
    case 'PAUSED':
    case 'SUSPENDED':
    case 'PENDING':
      return 'running'
    case 'SCHEDULED':
      return 'scheduled'
    default:
      return 'unknown'
  }
}

// Un flow run dell'API → una run nella forma delle altre. `names` = flow_id → nome del flow: è quello
// il "cron" per chi guarda (il nome del flow run è un'accozzaglia generata, tipo `bold-hedgehog`).
// Pura/testabile.
export function mapFlowRun(fr, names = {}) {
  const ms = (s) => (s ? new Date(s).getTime() : null)
  const startedAt = ms(fr?.start_time)
  const endedAt = ms(fr?.end_time)
  const outcome = stateToOutcome(fr?.state_type)
  const running = outcome === 'running'
  // `total_run_time` è in secondi e su una run in corso vale 0: lì la durata è quella maturata, che la
  // calcola la UI dal `startedAt`. Non si finge un numero fermo.
  const total = Number(fr?.total_run_time)
  return {
    id: fr?.id ?? null,
    cron: names[fr?.flow_id] ?? fr?.name ?? '—',
    runName: fr?.name ?? null,
    startedAt,
    endedAt,
    durationMs: !running && Number.isFinite(total) && total > 0 ? Math.round(total * 1000) : endedAt && startedAt ? endedAt - startedAt : null,
    running,
    outcome,
    state: fr?.state_name ?? fr?.state_type ?? null,
    failedScanned: true, // l'esito lo dichiara l'orchestratore: non è dedotto dai log
    source: 'prefect',
  }
}

async function post(cfg, path, body) {
  const res = await fetch(`${cfg.url}${path}`, {
    method: 'POST',
    headers: cfg.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    // 401/403 quasi sempre = auth applicativa mancante o sbagliata: dirlo per nome risparmia mezz'ora
    // di caccia alla rete.
    if (res.status === 401 || res.status === 403) throw new Error(`Prefect: ${res.status} (autenticazione API)`)
    throw new Error(`Prefect: HTTP ${res.status}`)
  }
  return res.json()
}

// Le esecuzioni dell'orchestratore: quelle partite nella finestra PIÙ quelle in corso da prima.
// La seconda query non è un doppione: un job lungo partito ieri sera è esattamente quello che si va a
// cercare, e una finestra di 6h non lo conterrebbe.
// Ritorna null se non configurato, { error } se non raggiungibile, { runs } altrimenti.
export async function prefectRuns({ minutes = 1440, limit = 40, env = process.env } = {}) {
  const cfg = prefectConfig(env)
  if (!cfg) return null
  try {
    const after = new Date(Date.now() - minutes * 60 * 1000).toISOString()
    const [recenti, inCorso] = await Promise.all([
      post(cfg, '/flow_runs/filter', { limit, sort: 'START_TIME_DESC', flow_runs: { start_time: { after_: after } } }),
      post(cfg, '/flow_runs/filter', {
        limit: 50,
        sort: 'START_TIME_DESC',
        flow_runs: { state: { type: { any_: ['RUNNING', 'PAUSED', 'CANCELLING'] } } },
      }),
    ])
    const byId = new Map()
    for (const fr of [...(inCorso ?? []), ...(recenti ?? [])]) if (fr?.id) byId.set(fr.id, fr)
    const flowIds = [...new Set([...byId.values()].map((fr) => fr.flow_id).filter(Boolean))]
    let names = {}
    if (flowIds.length) {
      try {
        const flows = await post(cfg, '/flows/filter', { limit: flowIds.length, flows: { id: { any_: flowIds } } })
        names = Object.fromEntries((flows ?? []).map((f) => [f.id, f.name]))
      } catch {
        /* senza i nomi dei flow le run restano leggibili: si mostra il nome della run */
      }
    }
    const runs = [...byId.values()]
      .map((fr) => mapFlowRun(fr, names))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    return { runs }
  } catch (err) {
    return { error: err.message }
  }
}

// I log di UNA esecuzione, dall'orchestratore (non da CloudWatch: quel job può girare fuori da AWS).
// Stessa forma degli eventi CloudWatch ({ ts, message }) così il pannello log è uno solo.
export async function prefectRunLogs(runId, { limit = 300, env = process.env } = {}) {
  const cfg = prefectConfig(env)
  if (!cfg) return null
  try {
    const rows = await post(cfg, '/logs/filter', {
      limit,
      sort: 'TIMESTAMP_ASC',
      logs: { flow_run_id: { any_: [runId] } },
    })
    return {
      events: (rows ?? []).map((r) => ({
        ts: r?.timestamp ? new Date(r.timestamp).getTime() : null,
        // Livello numerico di Python (40 = ERROR) → nome, che è ciò che il pannello colora.
        message: r?.message ?? '',
        level: levelName(r?.level),
      })),
      truncated: (rows ?? []).length >= limit,
    }
  } catch (err) {
    return { error: err.message }
  }
}

// Livello di logging Python (numero) → nome minuscolo. Pura/testabile.
export function levelName(level) {
  // `Number(null)` è 0, cioè un numero finito: senza questo controllo un livello ASSENTE diventerebbe
  // 'debug', e una riga senza livello si mostrerebbe smorzata come se qualcuno l'avesse marcata così.
  if (level === null || level === undefined || level === '') return ''
  const n = Number(level)
  if (!Number.isFinite(n)) return ''
  if (n >= 50) return 'critical'
  if (n >= 40) return 'error'
  if (n >= 30) return 'warning'
  if (n >= 20) return 'info'
  return 'debug'
}
