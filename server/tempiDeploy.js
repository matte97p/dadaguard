// «Quanto ci mette un rilascio, e dove perde tempo?», per servizio: CI, coda, build e deploy, più i
// numeri che dicono se il canale di rilascio è sano (tasso di fallimento, frequenza, ripristino,
// attesa fra staging e produzione).
//
// Tutto puro: entrano il payload per-account di `/api/deploys` (le build CodeBuild con le fasi) e,
// facoltativi, i run GitHub Actions dei repository; esce una riga per servizio. Nessuna chiamata AWS.
//
// Mediana e p90, non la media: una build a cache fredda dura il triplo, e una media la porta dentro
// ogni numero per settimane. La mediana dice com'è di solito, il p90 com'è nei giorni storti.
//
// Cosa diventa cosa, dalle fasi CodeBuild (buildspec di `codebuild-image`):
//   coda    SUBMITTED + QUEUED + PROVISIONING           in attesa di una macchina
//   build   DOWNLOAD_SOURCE + INSTALL + PRE_BUILD +     `docker build` e push su ECR
//           BUILD
//   deploy  POST_BUILD + UPLOAD_ARTIFACTS + FINALIZING  `update-service` fino al rollout convergente
// La CI NON è la durata del run GitHub: nei workflow dove il job di deploy lancia CodeBuild e ne
// aspetta la fine, il run contiene anche la build. Si misura quindi dall'inizio del primo run del
// push all'ultimo job finito prima che la build dello stesso commit partisse; il tempo da lì all'avvio
// della build è l'ATTESA (approvazioni, wait timer, runner occupati), contata a parte.
import { ambienteDi } from './rilasci.js'
import { repoDaUrl } from './notify/github.js'

const CODA = new Set(['SUBMITTED', 'QUEUED', 'PROVISIONING'])
const BUILD = new Set(['DOWNLOAD_SOURCE', 'INSTALL', 'PRE_BUILD', 'BUILD'])
const DEPLOY = new Set(['POST_BUILD', 'UPLOAD_ARTIFACTS', 'FINALIZING'])
const FALLITI = new Set(['FAILED', 'FAULT', 'TIMED_OUT'])
export const SEGMENTI = ['ci', 'attesa', 'coda', 'build', 'deploy', 'totale', 'lead']

// Sotto questo numero di build riuscite il p90 non vuol dire niente, e «lenta» sarebbe rumore.
const MIN_CAMPIONI_LENTA = 5
// «Lenta» chiede anche uno scarto vero: un minuto sopra il p90 e un quarto sopra la mediana. Un p90
// di 3m10s superato di 4 secondi non è una notizia.
const SCARTO_MIN_MS = 60_000
const SCARTO_MEDIANA = 1.25
// Una CI più lunga di così non è la CI di quel commit: è un run rilanciato ore dopo, o un altro push
// con lo stesso commit (un merge fast-forward su un secondo ramo).
const CI_MAX_MS = 3 * 3_600_000
const SETTIMANA_MS = 7 * 86_400_000

const ms = (v) => (v == null ? null : new Date(v).getTime())

// Quantile con interpolazione lineare (lo stesso di numpy di default). Puro.
export function quantile(valori, q) {
  const v = valori.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const pos = (v.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return Math.round(v[lo] + (v[hi] - v[lo]) * (pos - lo))
}

const riassunto = (valori) => {
  const v = valori.filter(Number.isFinite)
  return v.length ? { p50: quantile(v, 0.5), p90: quantile(v, 0.9), n: v.length } : null
}

// Le durate di una build per segmento, dalle sue fasi. Un segmento senza nessuna fase misurata resta
// null, non zero: «0s di coda» e «non lo so» sono due cose diverse. Puro/testabile.
export function segmentiBuild(b = {}) {
  const somma = (set) => {
    const f = (b.phases ?? []).filter((p) => set.has(p.type) && Number.isFinite(p.durationMs))
    return f.length ? f.reduce((s, p) => s + p.durationMs, 0) : null
  }
  return { coda: somma(CODA), build: somma(BUILD), deploy: somma(DEPLOY), totale: Number.isFinite(b.durationMs) ? b.durationMs : null }
}

// Una build di deploy vera: ha un numero e delle fasi. I riavvii a mano (CloudTrail) e i rollout di
// Cloudflare stanno nello stesso elenco ma non hanno niente da cronometrare.
const isBuildVera = (b) => b && b.number != null && Array.isArray(b.phases) && b.phases.length > 0 && b.provider !== 'cloudflare'

// I run nati da un push del commit di questa build sul ramo dell'ambiente. Puro.
export function runDelCommit(b, runs = [], ramo = null) {
  const sha = String(b?.commit ?? '').toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return []
  return runs.filter((r) => r.event === 'push' && (!ramo || r.head_branch === ramo) && String(r.head_sha ?? '').toLowerCase().startsWith(sha))
}

// La CI del commit di questa build, divisa in due: il LAVORO (dal primo run del push all'ultimo job
// finito prima che la build partisse: test, lint, migration) e l'ATTESA (da lì all'avvio della build:
// un'approvazione su un environment protetto, un wait timer, un runner occupato, un gruppo di
// `concurrency`). Senza la divisione un deploy di produzione che aspetta una persona si legge come
// «test lenti in produzione». `jobs` = Map id del run → job (API `/runs/{id}/jobs`); senza i job di
// nessun run, tutto il tempo resta CI e l'attesa è null. Null se non c'è un run, o se il risultato è
// assurdo. Puro/testabile.
export function ciDellaBuild(b, runs = [], ramo = null, jobs = null) {
  const delCommit = runDelCommit(b, runs, ramo)
  const partenze = delCommit.map((r) => ms(r.run_started_at ?? r.created_at)).filter(Number.isFinite)
  if (!partenze.length) return null
  const inizio = Math.min(...partenze)
  const avvio = ms(b.startedAt)
  if (!(avvio - inizio >= 0 && avvio - inizio <= CI_MAX_MS)) return null
  const fini = delCommit
    .flatMap((r) => jobs?.get(r.id) ?? [])
    .map((j) => ms(j.completed_at))
    .filter((t) => Number.isFinite(t) && t >= inizio && t <= avvio)
  if (!fini.length) return { inizio, ci: avvio - inizio, attesa: null }
  const fineLavoro = Math.max(...fini)
  return { inizio, ci: fineLavoro - inizio, attesa: avvio - fineLavoro }
}

// Il tempo di ripristino: da una build fallita alla prima riuscita dopo, contato solo sulla PRIMA
// fallita di una serie (tre rossi di fila sono un guasto solo, durato fino al verde). Puro/testabile.
export function ripristini(builds = []) {
  const finite = builds.filter((b) => FALLITI.has(b.status) || b.status === 'SUCCEEDED').sort((a, b) => ms(a.startedAt) - ms(b.startedAt))
  const out = []
  let rotto = null
  for (const b of finite) {
    if (FALLITI.has(b.status)) rotto ??= b
    else if (rotto) {
      const d = ms(b.endedAt ?? b.startedAt) - ms(rotto.endedAt ?? rotto.startedAt)
      if (d >= 0) out.push(d)
      rotto = null
    }
  }
  return out
}

// L'ultima build riuscita è lenta? Il confronto è con le build di PRIMA: mettere l'ultima dentro il
// suo stesso p90 la renderebbe meno lenta di quanto è. Puro/testabile.
export function buildLenta(riuscite = []) {
  if (riuscite.length < MIN_CAMPIONI_LENTA + 1) return null
  const [ultima, ...prima] = [...riuscite].sort((a, b) => ms(b.startedAt) - ms(a.startedAt))
  const tot = prima.map((b) => b.durationMs)
  const p90 = quantile(tot, 0.9)
  const p50 = quantile(tot, 0.5)
  if (!Number.isFinite(ultima.durationMs) || p90 == null) return null
  const lenta = ultima.durationMs > p90 + SCARTO_MIN_MS && ultima.durationMs > p50 * SCARTO_MEDIANA
  return lenta ? { durationMs: ultima.durationMs, p50, p90, build: ultima.number, commit: ultima.commit } : null
}

// L'attesa di un commit fra staging e produzione: da quando il deploy in staging è finito a quando
// quello in produzione è partito, per gli stessi commit. Conta solo dove il commit è lo STESSO nei due
// ambienti (fast-forward, o promozione dello stesso sha): un merge commit ha un altro sha, e lì la
// riga dice «n/d» invece di inventare un abbinamento. Puro/testabile.
export function attesaStaging(staging = [], produzione = []) {
  const primoInStaging = new Map()
  for (const b of staging)
    if (b.status === 'SUCCEEDED' && b.commit) {
      const t = ms(b.endedAt ?? b.startedAt)
      if (!primoInStaging.has(b.commit) || t < primoInStaging.get(b.commit)) primoInStaging.set(b.commit, t)
    }
  const visti = new Set()
  const out = []
  for (const b of [...produzione].sort((a, c) => ms(a.startedAt) - ms(c.startedAt))) {
    if (b.status !== 'SUCCEEDED' || !b.commit || visti.has(b.commit) || !primoInStaging.has(b.commit)) continue
    visti.add(b.commit)
    const d = ms(b.startedAt) - primoInStaging.get(b.commit)
    if (d >= 0) out.push(d)
  }
  return out
}

// La tabella: una riga per account e servizio.
//
// `runs` = Map `owner/repo` (minuscolo) → run GitHub Actions; senza, la colonna CI resta vuota.
// `rami` = ramo → ambiente (`DADAGUARD_GITHUB_RAMI`), per prendere il run del ramo giusto.
// `jobs` = Map id del run → job, per dividere la CI dalle attese (vedi `ciDellaBuild`).
export function tempiPerServizio(perAccount = {}, { runs = null, jobs = null, rami = {}, ora = Date.now() } = {}) {
  const ramoDi = ramoPerAmbiente(rami)
  const gruppi = new Map()
  for (const [chiave, dati] of Object.entries(perAccount)) {
    for (const b of dati?.builds ?? []) {
      if (!isBuildVera(b) || b.inProgress) continue
      const k = `${chiave}|${b.service}`
      if (!gruppi.has(k)) gruppi.set(k, { account: chiave, accountLabel: dati.label ?? chiave, servizio: b.service, builds: [] })
      gruppi.get(k).builds.push(b)
    }
  }

  // Le build riuscite di ogni servizio per ambiente, per l'attesa staging → produzione.
  const perAmbiente = { staging: new Map(), produzione: new Map() }
  for (const g of gruppi.values()) {
    const amb = ambienteDi(g.account)
    if (amb) perAmbiente[amb].set(g.servizio, [...(perAmbiente[amb].get(g.servizio) ?? []), ...g.builds])
  }

  const righe = []
  for (const g of gruppi.values()) {
    const amb = ambienteDi(g.account)
    const riuscite = g.builds.filter((b) => b.status === 'SUCCEEDED')
    const fallite = g.builds.filter((b) => FALLITI.has(b.status))
    const seg = riuscite.map(segmentiBuild)

    // CI e lead time (dal push a in produzione), solo dove i run del repository ci sono.
    const ci = []
    const attesa = []
    const lead = []
    for (const b of riuscite) {
      const lista = runDelRepo(b, runs)
      if (!lista) continue
      const c = ciDellaBuild(b, lista, ramoDi[amb] ?? null, jobs)
      if (!c) continue
      ci.push(c.ci)
      if (c.attesa != null) attesa.push(c.attesa)
      if (b.endedAt) lead.push(ms(b.endedAt) - c.inizio)
    }

    // Frequenza: rilasci riusciti negli ultimi 7 giorni. Il campione è limitato (le ultime build per
    // progetto), quindi se la più vecchia letta è dentro la settimana il numero è un minimo.
    const piuVecchia = Math.min(...g.builds.map((b) => ms(b.startedAt)).filter(Number.isFinite))
    const settimana = riuscite.filter((b) => ora - ms(b.startedAt) <= SETTIMANA_MS).length

    const finite = riuscite.length + fallite.length
    righe.push({
      account: g.account,
      accountLabel: g.accountLabel,
      servizio: g.servizio,
      ambiente: amb,
      campioni: riuscite.length,
      ci: riassunto(ci),
      attesa: riassunto(attesa),
      coda: riassunto(seg.map((s) => s.coda)),
      build: riassunto(seg.map((s) => s.build)),
      deploy: riassunto(seg.map((s) => s.deploy)),
      totale: riassunto(seg.map((s) => s.totale)),
      lead: riassunto(lead),
      fallimento: finite ? { falliti: fallite.length, finiti: finite, tasso: fallite.length / finite } : null,
      settimana: { n: settimana, almeno: Number.isFinite(piuVecchia) && ora - piuVecchia < SETTIMANA_MS },
      ripristino: riassunto(ripristini(g.builds)),
      daStaging: amb === 'produzione' ? riassunto(attesaStaging(perAmbiente.staging.get(g.servizio) ?? [], g.builds)) : null,
      lenta: buildLenta(riuscite),
    })
  }
  return righe.sort((a, b) => Boolean(b.lenta) - Boolean(a.lenta) || a.servizio.localeCompare(b.servizio) || a.account.localeCompare(b.account))
}

const ramoPerAmbiente = (rami = {}) => Object.fromEntries(Object.entries(rami).map(([ramo, amb]) => [amb, ramo]))
const runDelRepo = (b, runs) => {
  const repo = repoDaUrl(b.repo)
  return (repo && runs?.get(`${repo.owner}/${repo.repo}`.toLowerCase())) || null
}

// I run di cui servono i job: quelli abbinati a una build riuscita. Gli altri (push su commit mai
// rilasciati, build fuori campione) non entrano in nessun numero, e leggerne i job costerebbe rate
// limit per niente. Puro.
export function runDaLeggere(perAccount = {}, runs = null, rami = {}) {
  const ramoDi = ramoPerAmbiente(rami)
  const out = new Map()
  for (const [chiave, dati] of Object.entries(perAccount))
    for (const b of dati?.builds ?? []) {
      if (!isBuildVera(b) || b.status !== 'SUCCEEDED') continue
      const repo = repoDaUrl(b.repo)
      const lista = runDelRepo(b, runs)
      if (!lista) continue
      for (const r of runDelCommit(b, lista, ramoDi[ambienteDi(chiave)] ?? null)) out.set(r.id, { owner: repo.owner, repo: repo.repo, id: r.id, finito: r.status === 'completed' })
    }
  return [...out.values()]
}

// I repository da leggere su GitHub per la colonna CI: quelli delle build, con l'inizio della finestra
// (la build più vecchia letta). Puro.
export function repoDelleBuild(perAccount = {}, { org = null } = {}) {
  const out = new Map()
  for (const dati of Object.values(perAccount))
    for (const b of dati?.builds ?? []) {
      const r = isBuildVera(b) && repoDaUrl(b.repo)
      if (!r || (org && r.owner.toLowerCase() !== org)) continue
      const k = `${r.owner}/${r.repo}`.toLowerCase()
      const da = ms(b.startedAt)
      const gia = out.get(k)
      if (!gia) out.set(k, { ...r, da })
      else if (Number.isFinite(da) && (!Number.isFinite(gia.da) || da < gia.da)) gia.da = da
    }
  return [...out.values()]
}
