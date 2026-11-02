// Gli esiti CERTI delle corse ECS, letti dall'API finche' il task c'era: codice d'uscita, OOM, task
// mai partito. Li scrive `ecsRuns` (server/runs.js: la lista delle corse e il giro del canvas Slack, ogni
// pochi minuti), li leggono la vista «Andamento» e il check della home prima di guardare nei log.
// Chiave: log group e stream della corsa. Tetto alla memoria: oltre, esce il piu' vecchio.
//
// Sta in un modulo suo perche' lo leggono sia server/runs.js sia server/runtime/ecsScheduled.js, e il
// primo importa gia' dal secondo: tenerlo in runs.js chiuderebbe il giro.
export const esitiEcs = new Map()
export const MAX_ESITI_ECS = 20_000
