// Le regole delle pagine Deploy e Cron, fuori dai .jsx: i test girano con `node --test`, che non carica
// JSX, e queste sono le righe che decidono cosa si vede (in che fascia cade un deploy, quanto dura di
// solito un cron, perche' una corsa e' fallita). Tutto puro.
import { esitoBuild } from './adattatori.js'
import { isByHand } from './deployKinds.js'
import { statoCron, motivoCorsa, statoReaper } from '../shared/cron.js'

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

// Esito di una corsa, stato di un cron e motivo di un fallimento: in shared/cron.js, perché li usa
// anche il canvas delle corse in Slack (server/notify/corse.js), e due copie dicono due cose.
export { livelloCorsa, statoCron, motivoCorsa } from '../shared/cron.js'

// Il nome da leggere di un cron: il percorso del suo codice (il tag `Codice`, vedi shared/codice.js),
// che il server mette in `etichetta`; senza tag, lo schedule di sempre. Pura.
export const nomeCron = (c) => c?.etichetta ?? c?.name ?? ''

// Il reaper di un job, quando è un PROBLEMA: la riga prende il suo stato (`statoCron`), e il
// suggerimento deve dire perché, altrimenti un job «Ok 3 h fa» con la pillola rossa è un indovinello.
// A posto, il reaper non dice niente. Pura.
export function avvisoReaper(c, t = (k) => k) {
  const sr = statoReaper(c)
  if (!(sr === 'crit' || sr === 'warn') || statoCron(c) === 'off') return null
  const ultima = (c.reaper.runs ?? []).find((r) => !r.running)
  return t('rilasci.cron.reaperGuasto', { stato: t(`rilasci.cron.stato.${sr}`), motivo: motivoCorsa(ultima, t) ?? '' }).replace(/\s*·\s*$/, '')
}

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

// I link «Apri altrove» di un cron. Arriveranno dal server in `altrove`; quello che si sa gia' e' il log
// group, e il link alla console CloudWatch si compone dal nome e dalla regione senza indovinare niente.
export function linkCron(cron, t = (k) => k) {
  const out = []
  const etichetta = { 'cloudwatch-log': 'rilasci.link.cloudwatch', 'posthog-log': 'rilasci.link.posthogLog' }
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
