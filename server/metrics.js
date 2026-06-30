// Esposizione Prometheus dei segnali → Grafana/Alertmanager fanno dashboard, alert e storico
// SENZA che Dadaguard diventi un servizio (resta read-only / fetch-on-load). Il valore è la
// SEVERITÀ (0 up · 1 idle/unknown · 2 degraded · 3 down): si allerta su
//   dadaguard_service_status >= 3   (giù)   /   >= 2  (attenzione).
const SEV = { up: 0, idle: 1, disabled: 1, unknown: 1, degraded: 2, down: 3 }

const esc = (v) =>
  String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ')
const lbl = (o) =>
  Object.entries(o)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(',')

export function renderMetrics(status) {
  const out = []
  const block = (name, help, samples) => {
    if (!samples.length) return
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`)
    for (const [labels, val] of samples) out.push(`${name}{${labels}} ${val}`)
  }

  const svc = []
  const check = []
  const latency = []
  const running = []
  const desired = []
  for (const s of status.services ?? []) {
    const base = { service: s.name, account: s.account?.key ?? '', type: s.type ?? '' }
    svc.push([lbl({ ...base, overall: s.overall }), SEV[s.overall] ?? 1])
    for (const [key, c] of Object.entries(s.checks ?? {})) {
      check.push([lbl({ ...base, check: key, status: c.status }), SEV[c.status] ?? 1])
    }
    const liv = s.checks?.liveness
    if (typeof liv?.latencyMs === 'number') latency.push([lbl(base), liv.latencyMs])
    const rt = s.checks?.runtime
    if (typeof rt?.runningCount === 'number') running.push([lbl(base), rt.runningCount])
    if (typeof rt?.desiredCount === 'number') desired.push([lbl(base), rt.desiredCount])
  }

  block('dadaguard_service_status', 'Severità del servizio (0 up,1 idle/unknown,2 degraded,3 down)', svc)
  block('dadaguard_check_status', 'Severità del singolo check', check)
  block('dadaguard_liveness_latency_ms', 'Latenza della liveness in ms', latency)
  block('dadaguard_runtime_running', 'Task/istanze in esecuzione', running)
  block('dadaguard_runtime_desired', 'Task/istanze desiderate', desired)
  out.push(
    '# HELP dadaguard_scrape_success 1 se lo scrape ha raccolto lo stato',
    '# TYPE dadaguard_scrape_success gauge',
    'dadaguard_scrape_success 1',
  )
  return out.join('\n') + '\n'
}
