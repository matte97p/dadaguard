// Il CODICE di un cron: dove sta il sorgente di quello che gira, letto dal tag AWS `Codice` (le regole
// di lettura e di resa sono in shared/codice.js, qui c'è la parte che chiama AWS e la configurazione).
//
// Da dove si legge, senza chiamate nuove dove si può:
//   · cron ECS RunTask: dalla task definition, che la lista delle corse legge già e tiene in cache
//     un'ora (`leggiTaskDef` in server/runs.js, chiesta coi tag). Stessa chiave, stessa chiamata;
//   · cron Lambda: dai tag della funzione (`getLambdaTags`), in cache un'ora, perché i tag li muove un
//     apply e non il traffico. Serve `lambda:ListTags` nel ruolo: senza, i tag arrivano vuoti e il cron
//     tiene il nome di oggi (vedi deploy/dadaguard-readonly-policy.json).
// Si legge anche per i cron SPENTI, che le corse non le interrogano: un cron spento col nome dello
// schedule in mezzo a quelli col percorso del codice sembrerebbe di un'altra specie. Con la cache
// costa una chiamata all'ora per cron.
//
// Configurazione (tutta facoltativa):
//   DADAGUARD_GITHUB_ORG   l'organizzazione GitHub dei repository nominati come `<repo>/<percorso>`:
//                          con lei il percorso diventa un link. Senza, si mostra il percorso senza
//                          link: il nome dell'organizzazione nel codice non c'è (il repo è pubblico).
//                          È la stessa variabile della GitHub App dei test (server/notify/github.js)
//   DADAGUARD_GITHUB_REF   il ramo dei link (default `main`)
import { leggiTaskDef } from './runs.js'
import { getLambdaTags } from './runtime/lambdaConfig.js'
import { codiceDaTag, urlCodice, etichetteCron, piegaReaper } from '../shared/codice.js'
import { nomeBreve } from './notify/quadro.js'

export function codiceConfig(env = process.env) {
  return {
    org: String(env.DADAGUARD_GITHUB_ORG ?? '').trim() || null,
    ref: String(env.DADAGUARD_GITHUB_REF ?? '').trim() || 'main',
  }
}

// Il Codice di un cron, o null. Non lancia MAI: un tag è un'etichetta, e una lettura fallita (permesso,
// throttling) non deve togliere la riga né le sue corse, solo lasciarle il nome di oggi.
export async function cronCodice(cron, aws) {
  try {
    if (cron?.type === 'ecs-scheduled' && cron.taskDefinition) return codiceDaTag((await leggiTaskDef(aws, cron.taskDefinition)).tags)
    if (cron?.type === 'lambda' && cron.function) return codiceDaTag(await getLambdaTags(cron.function, aws))
  } catch {
    /* nessun tag leggibile: il cron tiene il nome di oggi */
  }
  return null
}

// La lista dei cron pronta per la pagina: reaper dentro la riga del loro job, un'etichetta per riga
// (il percorso del codice, o il nome dello schedule se il tag manca) e il link al codice. La chiave
// `key` NON cambia: ci sono appesi i link `?cron=`, le cache e il canvas, e un'etichetta nuova non deve
// rompere un link vecchio. Pura/testabile.
export function vestiCron(crons = [], cfg = codiceConfig()) {
  const piegati = piegaReaper(crons, { breve: nomeBreve })
  const breve = (c) => nomeBreve(c.name)
  const etichette = etichetteCron(piegati, { nome: (c) => c.name, breve })
  const veste = (c, etichetta) => ({ ...c, etichetta, codiceUrl: urlCodice(c.codice, cfg) })
  return piegati.map((c) => {
    const v = veste(c, etichette.get(c.key))
    // Il reaper porta il Codice del suo job: la sua etichetta è quella del job, con `reaper` accanto.
    if (c.reaper) v.reaper = veste(c.reaper, `${v.etichetta} · reaper`)
    return v
  })
}
