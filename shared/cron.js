// Lo STATO di un cron e il VERDETTO su un gruppo di cron, detti una volta sola per la pagina Cron
// (web/pages/RunsPage.jsx) e per il canvas delle corse in Slack (server/notify/corse.js).
//
// Vive in `shared/` e non in web/rilasci.js perché lo usano tutti e due: con due copie la pagina
// diceva «1 cron fallito» e il canvas, scritto a parte, avrebbe potuto dire «1 corsa fallita» o
// contare un cron in corso come a posto, cioè due verità sullo stesso dato. Qui ci sono solo le regole;
// le PAROLE restano nei dizionari (web/i18n.jsx per la pagina, server/i18n.js per il canvas, con le
// stesse chiavi e lo stesso testo, vedi test/corse.test.js). Nessun import: lo carica anche il server,
// e l'immagine copia `shared/` intera (vedi il Dockerfile).

// Esito di una corsa → livello dell'interfaccia. `unknown` è arancio e non verde: una corsa di cui non
// sappiamo com'è finita non è andata bene, è solo non letta.
const LIVELLO_ESITO = { running: 'info', ok: 'ok', failed: 'crit', cancelled: 'off', unknown: 'warn', scheduled: 'off' }
export const livelloCorsa = (r) => LIVELLO_ESITO[r?.outcome] ?? 'off'

// Lo stato di un cron nella lista, dal più grave: l'ultima corsa fallita, una in corso, nessuna corsa
// pur essendo acceso (non è partito), spento di proposito, tutto a posto.
export function statoCron(cron) {
  const runs = cron?.runs ?? []
  if (runs.some((r) => r.running)) {
    const finita = runs.find((r) => !r.running)
    return finita?.outcome === 'failed' ? 'crit' : 'info'
  }
  if (!runs.length) return cron?.enabled === false ? 'off' : 'warn'
  return livelloCorsa(runs.find((r) => !r.running) ?? runs[0])
}

// Perché una corsa è fallita, in una frase. In ordine di quanto il motivo è certo: l'uccisione per
// memoria la dice ECS, il timeout la dice Lambda, l'exit code il container. Un fallimento con uscita 0
// vuol dire che il job ha scritto errori nei log pur finendo «bene», ed è il caso che la card verde
// non avrebbe mai mostrato.
export function motivoCorsa(run, t = (k) => k) {
  if (!run || run.outcome !== 'failed') {
    if (run?.outcome === 'unknown') return t('rilasci.cron.motivo.ignoto')
    return null
  }
  if (run.stopReason && /OutOfMemory|OOMKilled/i.test(run.stopReason)) return t('runs.oom')
  if (run.timedOut) return t('runs.timedOut')
  if (run.exitCode != null && run.exitCode !== 0) return t('runs.exit', { code: run.exitCode })
  if (run.state && run.source === 'prefect') return run.state
  if (run.stopReason) return run.stopReason
  return t('rilasci.cron.motivo.erroriNeiLog')
}

// I tre conti del verdetto. «In corso» è chi ha una corsa viva, anche se la precedente è fallita: quel
// cron conta due volte (fallito E in corso), come conta sulla pagina da quando c'è.
export function contaCron(crons = []) {
  const stati = crons.map(statoCron)
  return {
    totale: crons.length,
    falliti: stati.filter((s) => s === 'crit').length,
    nonPartiti: stati.filter((s) => s === 'warn').length,
    inCorso: crons.filter((c) => (c.runs ?? []).some((r) => r.running)).length,
  }
}

// Il verdetto in cima, come chiavi da tradurre: `forte` è la parte in grassetto, `resto` quello che
// segue (o null). Un fallimento vince su tutto, poi chi non è partito, poi chi sta girando.
export function verdettoCron({ falliti = 0, nonPartiti = 0, inCorso = 0 } = {}) {
  if (falliti)
    return {
      livello: 'crit',
      forte: ['rilasci.cron.v.falliti', { n: falliti }],
      resto: inCorso ? ['rilasci.cron.v.eInCorso', { n: inCorso }] : nonPartiti ? ['rilasci.cron.v.eNonPartiti', { n: nonPartiti }] : null,
    }
  if (nonPartiti)
    return { livello: 'warn', forte: ['rilasci.cron.v.nonPartiti', { n: nonPartiti }], resto: inCorso ? ['rilasci.cron.v.eInCorso', { n: inCorso }] : null }
  if (inCorso) return { livello: 'info', forte: ['rilasci.cron.v.inCorso', { n: inCorso }], resto: ['rilasci.cron.v.restoOk', {}] }
  return { livello: 'ok', forte: ['rilasci.cron.v.ok', {}], resto: null }
}
