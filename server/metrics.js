// Esposizione Prometheus dei segnali → Grafana/Alertmanager fanno dashboard, alert e storico
// SENZA che Dadaguard diventi un servizio (resta read-only / fetch-on-load). Il valore è la
// SEVERITÀ (0 up · 1 idle/unknown · 2 degraded · 3 down): si allerta su
//   dadaguard_service_status >= 3   (giù)   /   >= 2  (attenzione).
import { SEGMENTI } from './tempiDeploy.js'

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

// `tempi` = le righe di server/tempiDeploy.js (facoltative): durate in SECONDI, come vuole Prometheus,
// con `quantile` 0.5 e 0.9 come etichetta, nello stile dei summary.
export function renderMetrics(status, tempi = []) {
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

  const durata = []
  const fallimento = []
  const settimana = []
  const ripristino = []
  const daStaging = []
  const lenta = []
  const sec = (v) => Math.round(v / 100) / 10
  for (const r of tempi ?? []) {
    const base = { service: r.servizio, account: r.account }
    for (const segment of SEGMENTI) {
      const s = r[segment]
      if (!s) continue
      durata.push([lbl({ ...base, segment, quantile: '0.5' }), sec(s.p50)])
      durata.push([lbl({ ...base, segment, quantile: '0.9' }), sec(s.p90)])
    }
    if (r.fallimento) fallimento.push([lbl(base), Math.round(r.fallimento.tasso * 1000) / 1000])
    if (r.settimana) settimana.push([lbl(base), r.settimana.n])
    if (r.ripristino) ripristino.push([lbl({ ...base, quantile: '0.5' }), sec(r.ripristino.p50)])
    if (r.daStaging) daStaging.push([lbl({ ...base, quantile: '0.5' }), sec(r.daStaging.p50)])
    lenta.push([lbl(base), r.lenta ? 1 : 0])
  }
  block('dadaguard_deploy_duration_seconds', 'Durata dei deploy riusciti per segmento (ci, attesa, coda, build, deploy, totale, lead)', durata)
  block('dadaguard_deploy_failure_ratio', 'Quota di deploy falliti sulle ultime build lette', fallimento)
  block('dadaguard_deploy_last_7d', 'Deploy riusciti negli ultimi 7 giorni', settimana)
  block('dadaguard_deploy_recovery_seconds', 'Tempo da un deploy fallito al successivo riuscito', ripristino)
  block('dadaguard_deploy_staging_to_prod_seconds', 'Attesa di un commit fra staging e produzione', daStaging)
  block('dadaguard_deploy_slow', "1 se l'ultima build riuscita supera il p90 delle precedenti", lenta)
  out.push(
    '# HELP dadaguard_scrape_success 1 se lo scrape ha raccolto lo stato',
    '# TYPE dadaguard_scrape_success gauge',
    'dadaguard_scrape_success 1',
  )
  return out.join('\n') + '\n'
}
