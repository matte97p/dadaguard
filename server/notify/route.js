// DOVE va ogni notifica, e quali NON si mandano affatto. Puro e testabile: è la regola che decide
// se il watchdog è utile o è rumore che si somma a rumore.
//
// Il punto di partenza è cosa parla GIÀ nel vostro stack:
//   · un cron (il pacchetto cron condiviso) che crasha lo scrive da sé, con la query e il privilegio — meglio di come
//     potrebbe dirlo Dadaguard, che vede solo "traceback nei log";
//   · i deploy li scrive CodeBuild.
// Quindi ridirlo è duplicare, e due canali che dicono la stessa cosa insegnano a ignorarli entrambi.
//
// Resta il buco che nessuno può coprire dall'interno: **il job che non è mai partito** (schedule non
// applicato, target sbagliato, IAM, concorrenza a zero: in tutti questi casi il job non esiste nel
// momento in cui dovrebbe parlare) — e tutto ciò che non è un cron né un deploy.
const TIPI_CRON = ['lambda', 'ecs-scheduled']

// 'cron'  → destinazione dei cron (dove la squadra guarda già i cron)
// 'main'  → destinazione di tutto il resto (ECS, endpoint, secret, drift, backup, certificati,
//           sicurezza, Bedrock, Cloudflare) — oggi senza voce da nessuna parte
// null    → NON si manda: lo dice già qualcun altro
// 'data'  → il canale degli allarmi della squadra data, per le risorse il cui repository d'immagine è
//           suo (`DADAGUARD_QUADRO_SQUADRE`, la stessa riga del quadro dei deploy): un guasto di uno
//           scraper lo deve vedere chi lo possiede, non il canale di tutti
export function routeOf(transition, { notifyCronFailed = false, repoData = [] } = {}) {
  const isCron = TIPI_CRON.includes(transition.type) && transition.outcome != null
  if (isCron && transition.outcome === 'failed' && !notifyCronFailed) return null
  if (transition.repo && repoData.includes(String(transition.repo).toLowerCase())) return 'data'
  if (isCron && transition.kind === 'alert' && transition.outcome === 'missed') return 'cron'
  return 'main'
}

// Divide le transizioni per destinazione. I RIENTRI tornano dove è stato aperto l'allarme (`route`
// ricordato nello stato): un rosso che nessuno chiude lascia un canale pieno di allarmi di cui
// non sai quali sono ancora aperti. Vale anche per gli alleggerimenti (`improvement`), che sono
// aggiornamenti sullo stesso allarme: seguirlo altrove spezzerebbe il filo in due canali.
export function splitByRoute(transitions, { routeMemory = {}, notifyCronFailed = false, repoData = [] } = {}) {
  const out = { main: [], cron: [], data: [], skipped: [] }
  for (const tr of transitions) {
    const opts = { notifyCronFailed, repoData }
    const dest = tr.kind === 'alert' ? routeOf(tr, opts) : (routeMemory[tr.key] ?? routeOf(tr, opts))
    if (!dest) {
      out.skipped.push(tr)
      continue
    }
    out[dest].push(tr)
  }
  return out
}
