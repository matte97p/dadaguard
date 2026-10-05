// Le regole delle pagine Deploy e Cron, fuori dai .jsx: i test girano con `node --test`, che non carica
// JSX, e queste sono le righe che decidono cosa si vede (in che fascia cade un deploy, quanto dura di
// solito un cron, perche' una corsa e' fallita). Tutto puro.
import { esitoBuild } from './adattatori.js'
import { isByHand } from './deployKinds.js'

// ── Deploy ──────────────────────────────────────────────────────────────────────────────────────

// L'istogramma: `n` fasce uguali che coprono le ultime `ore`, dalla piu' vecchia alla piu' recente.
// Ogni fascia conta riusciti, falliti, in corso e fatti a mano. «A mano» e' un conteggio a parte e non
// un quarto esito: un hotfix riuscito e' riuscito, e il colore deve dire anche quello.
export function fasceDeploy(builds = [], { now = Date.now(), ore = 24, n = 24 } = {}) {
  const span = ore * 3600_000
  const passo = span / n
  const inizio = now - span
  const fasce = Array.from({ length: n }, (_, i) => ({ da: inizio + i * passo, ok: 0, crit: 0, info: 0, off: 0, aMano: 0 }))
  for (const b of builds) {
    const at = b?.startedAt ? new Date(b.startedAt).getTime() : NaN
    if (!Number.isFinite(at) || at < inizio || at > now) continue
    const f = fasce[Math.min(n - 1, Math.floor((at - inizio) / passo))]
    f[esitoBuild(b)]++
    if (isByHand(b)) f.aMano++
  }
  return fasce
}

// Le ultime `max` build di un servizio come quadratini, dalla piu' vecchia (sinistra) alla piu'
// recente (destra), che e' il verso in cui si legge il tempo in tutto il resto dell'interfaccia.
export function ultimiDeploy(builds = [], max = 5) {
  return [...builds]
    .sort((a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0))
    .slice(0, max)
    .reverse()
    .map((b) => ({ build: b, livello: esitoBuild(b), aMano: isByHand(b) }))
}

// I conteggi in cima, sulle build VISIBILI: con i totali fissi della flotta il filtro sembrava inerte.
export function contaDeploy(builds = []) {
  const out = { ok: 0, crit: 0, info: 0, off: 0, aMano: 0 }
  for (const b of builds) {
    out[esitoBuild(b)]++
    if (isByHand(b)) out.aMano++
  }
  return out
}

// Le etichette sotto l'istogramma: cinque orari equidistanti, l'ultimo e' «adesso». Sopra le 48 ore
// l'orario da solo non dice in che giorno si e', quindi si scrive la data.
export function asseDeploy({ now = Date.now(), ore = 24, adesso = 'adesso', locale } = {}) {
  const span = ore * 3600_000
  const fmt = (ms) =>
    ore > 48
      ? new Date(ms).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })
      : new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return [0, 1, 2, 3].map((i) => fmt(now - span + (i * span) / 4)).concat(adesso)
}

// I link «Apri altrove» di una build. Il server li mandera' composti in `altrove` (commit su GitHub,
// progetto CodeBuild); finche' non arrivano restano i due link che la build porta gia': i log di
// CloudWatch e la dashboard di Cloudflare. Un link uguale a un altro non si ripete.
export function linkBuild(b, t = (k) => k) {
  const etichetta = { 'github-commit': 'rilasci.link.commit', codebuild: 'rilasci.link.codebuild' }
  const out = []
  for (const a of Array.isArray(b?.altrove) ? b.altrove : []) {
    if (!a?.url) continue
    out.push({ label: t(etichetta[a.chiave] ?? 'rilasci.link.altro'), href: a.url, nota: a.filtro ?? null })
  }
  if (b?.logsUrl) out.push({ label: t('rilasci.link.logBuild'), href: b.logsUrl, nota: 'CloudWatch' })
  if (b?.deployUrl) out.push({ label: t('rilasci.link.cloudflare'), href: b.deployUrl, nota: 'Cloudflare' })
  const visti = new Set()
  return out.filter((l) => !visti.has(l.href) && visti.add(l.href))
}

// ── Cron ────────────────────────────────────────────────────────────────────────────────────────

// Esito di una corsa → livello dell'interfaccia. `unknown` e' arancio e non verde: una corsa di cui non
// sappiamo com'e' finita non e' andata bene, e' solo non letta.
const LIVELLO_ESITO = { running: 'info', ok: 'ok', failed: 'crit', cancelled: 'off', unknown: 'warn', scheduled: 'off' }
export const livelloCorsa = (r) => LIVELLO_ESITO[r?.outcome] ?? 'off'

// Durata di una corsa: quella vera se e' finita, quella maturata finora se gira.
export function durataCorsa(run, now = Date.now()) {
  if (!run?.startedAt) return null
  if (run.durationMs != null && !run.running) return run.durationMs
  const fine = run.running ? now : run.endedAt
  if (!fine) return null
  return Math.max(0, fine - run.startedAt)
}

// Quanto dura di solito: la mediana delle corse riuscite, calcolata dal server (server/meta/cron.js)
// e mandata come `durataTipicaMs`, null con meno di due corse. Una corsa sola non e' un'abitudine, e
// un «di solito» inventato fa sembrare lento un cron sano.
export function durataTipica(cron) {
  return Number.isFinite(cron?.durataTipicaMs) ? cron.durataTipicaMs : null
}

// Perche' una corsa e' fallita, in una frase. In ordine di quanto il motivo e' certo: l'uccisione per
// memoria la dice ECS, il timeout la dice Lambda, l'exit code il container. Un fallimento con uscita 0
// vuol dire che il job ha scritto errori nei log pur finendo «bene», ed e' il caso che la card verde
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

// Il comando per leggere i log da terminale. Si compone solo quando il log group e' certo: lo dichiara
// il cron (ECS), o e' quello che AWS da' per convenzione a ogni Lambda. Altrimenti niente: un comando
// inventato si copia, fallisce, e insegna a non fidarsi degli altri.
export function comandoCron(cron) {
  if (typeof cron?.comando === 'string' && cron.comando) return cron.comando
  const gruppo = cron?.logGroup ?? (cron?.type === 'lambda' && cron?.function ? `/aws/lambda/${cron.function}` : null)
  if (!gruppo) return null
  const regione = cron.region ? ` --region ${cron.region}` : ''
  return `aws logs tail ${gruppo} --since 1h${regione}`
}

// Lo stato di un cron nella lista, dal piu' grave: l'ultima corsa fallita, una in corso, nessuna corsa
// pur essendo acceso (non e' partito), spento di proposito, tutto a posto.
export function statoCron(cron) {
  const runs = cron?.runs ?? []
  if (runs.some((r) => r.running)) {
    const finita = runs.find((r) => !r.running)
    return finita?.outcome === 'failed' ? 'crit' : 'info'
  }
  if (!runs.length) return cron?.enabled === false ? 'off' : 'warn'
  return livelloCorsa(runs.find((r) => !r.running) ?? runs[0])
}

// I link «Apri altrove» di un cron. Arriveranno dal server in `altrove`; quello che si sa gia' e' il log
// group, e il link alla console CloudWatch si compone dal nome e dalla regione senza indovinare niente.
export function linkCron(cron, t = (k) => k) {
  const out = []
  const etichetta = { 'cloudwatch-log': 'rilasci.link.cloudwatch', 'posthog-log': 'rilasci.link.posthogLog', 'posthog-errori': 'rilasci.link.posthogErrori' }
  for (const a of Array.isArray(cron?.altrove) ? cron.altrove : []) {
    if (a?.url) out.push({ label: t(etichetta[a.chiave] ?? 'rilasci.link.altro'), href: a.url, nota: a.filtro ?? null })
  }
  const gruppo = cron?.logGroup ?? (cron?.type === 'lambda' && cron?.function ? `/aws/lambda/${cron.function}` : null)
  if (gruppo && cron?.region && !out.some((l) => l.href.includes('cloudwatch'))) {
    // La console vuole il nome del log group con `/` scritto `$252F` (doppia codifica): e' il formato
    // dei suoi link, non una scelta nostra.
    const nome = encodeURIComponent(gruppo).replace(/%/g, '$25')
    out.push({
      label: t('rilasci.link.cloudwatch'),
      href: `https://${cron.region}.console.aws.amazon.com/cloudwatch/home?region=${cron.region}#logsV2:log-groups/log-group/${nome}`,
      nota: gruppo,
    })
  }
  return out
}
