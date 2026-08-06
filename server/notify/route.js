// DOVE va ogni notifica, e quali NON si mandano affatto. Puro e testabile: è la regola che decide
// se il watchdog è utile o è rumore che si somma a rumore.
//
// Il punto di partenza è cosa parla GIÀ nel vostro stack:
//   · un cron (catocron) che crasha lo scrive da sé, con la query e il privilegio — meglio di come
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
export function routeOf(transition, { notifyCronFailed = false } = {}) {
  const isCron = TIPI_CRON.includes(transition.type) && transition.outcome != null
  if (isCron && transition.outcome === 'failed' && !notifyCronFailed) return null
  if (isCron && transition.kind === 'alert' && transition.outcome === 'missed') return 'cron'
  return 'main'
}

// Divide le transizioni per destinazione. I RIENTRI tornano dove è stato aperto l'allarme (`route`
// ricordato nello stato): un `<!channel>` che nessuno chiude lascia un canale pieno di rossi di cui
// non sai quali sono ancora aperti. Vale anche per gli alleggerimenti (`improvement`), che sono
// aggiornamenti sullo stesso allarme: seguirlo altrove spezzerebbe il filo in due canali.
export function splitByRoute(transitions, { routeMemory = {}, notifyCronFailed = false } = {}) {
  const out = { main: [], cron: [], skipped: [] }
  for (const tr of transitions) {
    const dest = tr.kind === 'alert' ? routeOf(tr, { notifyCronFailed }) : (routeMemory[tr.key] ?? routeOf(tr, { notifyCronFailed }))
    if (!dest) {
      out.skipped.push(tr)
      continue
    }
    out[dest].push(tr)
  }
  return out
}
