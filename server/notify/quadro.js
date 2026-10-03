import { log } from '../log.js'
import { ambienteDi } from '../rilasci.js'
import { canonicalActor } from '../util/principal.js'
import { stripOrgEnv } from '../util/envToken.js'
import { loadConfig } from '../config.js'

// Il QUADRO dei deploy: un messaggio Slack per ambiente, fissato in cima al canale e RISCRITTO a ogni
// giro, al posto del registro in cui ogni build lascia due messaggi (`⏳` all'avvio, `🚀`/`🔴` alla
// fine), ogni giro dei cron Lambda due per cron e ogni revisione registrata da un automatismo uno. In
// un giorno normale il canale dei rilasci ne riceve un centinaio, e la domanda vera («cosa gira
// adesso, e c'è qualcosa di rotto?») si risponde leggendo all'indietro.
//
// ⚠️ La flotta è grande (decine di servizi, cron e Lambda per ambiente), quindi il quadro NON è un
// inventario: un elenco di tutto sarebbe illeggibile quanto il canale che sostituisce. Ha tre piani,
// e solo i primi due hanno righe, ognuno col suo tetto:
//   Adesso        quello che è rotto, giù, rimasto indietro o in corso
//   Ultime N ore  i rilasci recenti, dal più nuovo; quelli fatti insieme sono UNA riga (le Lambda di
//                 un giro dei cron, i servizi che girano la stessa immagine)
//   Il resto      un conteggio, senza nomi: per vederli c'è il link a Dadaguard
// Così la lunghezza del messaggio dipende da quanto succede, non da quante risorse esistono.
//
// La verità su COSA GIRA la dice ECS, non CodeBuild: è l'unica fonte che vede tutte le strade per cui
// un servizio cambia (la build della CI, una revisione promossa a mano, un riavvio, le variabili
// aggiornate, la revisione registrata da un automatismo, un apply Terraform sulla task definition).
// CodeBuild aggiunge quello che ECS non sa: il commit, chi l'ha scritto, la build in corso o fallita.
//
// Cosa il quadro copre del canale, e cosa no:
//   ⏳ 🚀 🔴 deploy da CodeBuild                  righe delle applicazioni
//   ⏳ revisione promossa a mano, riavvii, SSM    revisione o rollout nuovo, visto da ECS
//   🔄 revisione nuova da un automatismo          una riga per IMMAGINE condivisa
//   ⏳ 🚀 deploy dei cron Lambda                  una riga per giro, dedotta da ora e autore
//   ⏳ 🚀 ➖ apply dell'infrastruttura             riga IaC
//   🧪 test avviati, deploy saltato o non avviato  NO: vivono in GitHub Actions, che Dadaguard non legge
//
// ⚠️ Un messaggio RISCRITTO non manda notifiche: è il suo pregio (niente rumore) e il suo limite. Un
// fallimento che deve svegliare qualcuno resta un messaggio NUOVO, e non è compito del quadro.
//
// I link a Dadaguard sono link nel testo, non pulsanti: un pulsante, anche se apre solo un indirizzo,
// manda a Slack un clic che l'app dovrebbe confermare da un indirizzo pubblico, e senza quello Slack
// gli mette accanto un triangolo d'avviso. Dadaguard sta dietro l'accesso aziendale e non lo ha.
//
// Zero storage, come il resto: il messaggio da riscrivere non si ricorda, si RITROVA fra quelli
// fissati nel canale (scritto da noi, con l'ambiente nei metadati o nel testo).
//
// Configurazione (tutta opzionale: senza token o canale il quadro non parte e non chiama niente):
//   DADAGUARD_SLACK_BOT_TOKEN   token `xoxb-` di un'app Slack con `chat:write`, `pins:read`,
//                               `pins:write`. Un webhook NON basta: non modifica un messaggio mandato
//   DADAGUARD_QUADRO_CANALE     id del canale (`C0123…`), non il nome: le API vogliono l'id
//   DADAGUARD_QUADRO_AMBIENTI   quali ambienti e in che ordine (default `produzione,staging`)
//   DADAGUARD_QUADRO_INTERVAL   secondi fra i giri (default 60: un deploy dura ~4 minuti, e a 300 un
//                               rilascio intero passerebbe senza che il quadro lo veda in corso)
//   DADAGUARD_QUADRO_ORE        quanto indietro guarda «Ultime N ore» (default 24)
//   DADAGUARD_SLACK_TEAM_ID     id del workspace (`T0…`), solo per il link d'anteprima di
//                               `/api/quadro`: senza, il Block Kit Builder si apre vuoto

const DEFAULT_INTERVAL_S = 60
const DEFAULT_ORE = 24
// I tetti delle righe. Oltre, una riga dice quante ne mancano e porta a Dadaguard.
const MAX_ADESSO = 6
const MAX_RECENTI = 8
// Le Lambda aggiornate dalla stessa persona a meno di questo l'una dall'altra sono un giro solo: un
// workflow dei cron ne rilascia una ventina in un paio di minuti.
const FINESTRA_LOTTO_MS = 15 * 60_000
// Una revisione ECS registrata oltre questo dopo la fine della build che ha prodotto l'immagine non
// è quella build: è una revisione nuova (variabili, promozione a mano, Terraform) sulla stessa immagine.
const SCARTO_REVISIONE_MS = 15 * 60_000
const EVENTO = 'dadaguard_quadro'
const FALLITI = new Set(['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'])
const SEP = '  ·  '

// Come si riconosce l'ambiente senza leggere: il titolo grande con un quadrato colorato e la BARRA
// dello stesso colore a sinistra del corpo (rossa la produzione, gialla lo staging). Il tag `[PROD]`
// delle notifiche resta nel testo di ripiego, che è quello delle notifiche e dei lettori di schermo.
export const AMBIENTI = {
  produzione: { titolo: '🟥  PRODUZIONE', tag: 'PROD', colore: '#E01E5A' },
  staging: { titolo: '🟨  STAGING', tag: 'STAGING', colore: '#ECB22E' },
}

export function quadroConfig(env = process.env) {
  const ambienti = (env.DADAGUARD_QUADRO_AMBIENTI || 'produzione,staging')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => AMBIENTI[s])
  const ore = Number(env.DADAGUARD_QUADRO_ORE)
  return {
    token: env.DADAGUARD_SLACK_BOT_TOKEN || null,
    canale: env.DADAGUARD_QUADRO_CANALE || null,
    ambienti,
    intervalMs: Math.max(30, Number(env.DADAGUARD_QUADRO_INTERVAL) || DEFAULT_INTERVAL_S) * 1000,
    ore: Number.isFinite(ore) && ore > 0 ? ore : DEFAULT_ORE,
    publicUrl: env.DADAGUARD_PUBLIC_URL || null,
    team: env.DADAGUARD_SLACK_TEAM_ID || null,
  }
}

const tempo = (x) => new Date(x ?? 0).getTime()
const piuRecente = (a, b) => tempo(b) - tempo(a)
const corto = (sha) => (sha && /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : (sha ?? null))
// Due riferimenti allo stesso commit, anche se uno è accorciato a 7 cifre e l'altro a 8.
const stessoCommit = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a))
// Il nome come lo dice chi ci lavora: senza `<org>-<env>-` (l'ambiente lo dice già il colore) e senza
// `cron-`. È anche la chiave con cui ECS e CodeBuild si incontrano: il servizio ECS si chiama
// `<org>-<env>-dashboard`, il progetto di deploy dà `dashboard`.
export const nomeBreve = (n = '') => stripOrgEnv(String(n)).replace(/^cron-/, '') || n
// Un tag che è un commit è un'immagine NOSTRA, costruita dalla CI; uno che è una versione
// (`v2.195.0`, `18.9.1`, `3.6-python3.12`) è un componente esterno, fissato dall'IaC. Dedotto dal tag,
// senza elenchi di nomi.
export const tagDiCommit = (t) => /^[0-9a-f]{7,40}$/i.test(String(t ?? ''))

// Chi ha fatto il cambio, detto per esteso quando il nome grezzo non si capisce: la sessione con cui
// l'apply dell'infrastruttura registra le risorse si chiama `codebuild-iac-<build>`.
export function chiLeggibile(chi) {
  if (!chi) return null
  const s = stripOrgEnv(String(chi))
  const iac = /^codebuild-iac(?:-(\d+))?$/i.exec(s)
  if (iac) return iac[1] ? `IaC (build #${iac[1]})` : 'IaC'
  return s
}

const daIac = (chi) => /^IaC\b/.test(chi ?? '')
// «da matte97p», ma «dall'IaC»: la preposizione si lega alla vocale.
export const daChi = (chi) => (chi ? (daIac(chi) ? `dall'${chi}` : `da ${chi}`) : null)

// ── I dati ───────────────────────────────────────────────────────────────────────────────────────

// Lo stato delle BUILD di un servizio in un ambiente. Tre stati, e la differenza fra il secondo e il
// terzo è quella che il canale di oggi non dice:
//   in_corso  l'ultimo tentativo sta girando
//   fallito   l'ultimo tentativo è fallito DOPO l'ultimo riuscito: gira ancora il commit di prima
//   ok        l'ultimo riuscito è anche l'ultimo tentativo
// Un riavvio a mano non cambia il commit: conta come evento più recente, non come rilascio.
// `durataTipica` è la mediana delle build riuscite: serve a dire se una build in corso è lenta.
// Puro/testabile.
export function statoBuild(builds = []) {
  const ordinate = [...builds].sort((a, b) => piuRecente(a.startedAt, b.startedAt))
  const ultima = ordinate[0] ?? null
  if (!ultima) return null
  const vere = ordinate.filter((b) => b.kind !== 'restart')
  const riuscita = vere.find((b) => b.status === 'SUCCEEDED') ?? null
  const durate = vere
    .filter((b) => b.status === 'SUCCEEDED' && b.durationMs > 0)
    .map((b) => b.durationMs)
    .sort((a, b) => a - b)
  const durataTipica = durate.length ? durate[Math.floor(durate.length / 2)] : null
  let stato = 'ok'
  if (ultima.inProgress || ultima.status === 'IN_PROGRESS') stato = 'in_corso'
  else if (FALLITI.has(ultima.status) && tempo(ultima.startedAt) >= tempo(riuscita?.startedAt)) stato = 'fallito'
  return { stato, riuscita, ultima, durataTipica }
}

// Cosa ECS dice di un servizio, dalla stessa lettura che fa la dashboard (nessuna chiamata in più).
// Puro.
export function datiEcs(servizio = {}) {
  const runtime = servizio.checks?.runtime ?? null
  const build = servizio.checks?.version?.build ?? null
  const th = runtime?.targetHealth
  return {
    nome: nomeBreve(servizio.name),
    tipo: servizio.type,
    // Solo un SERVIZIO è giù: un cron in rosso ha fallito una corsa, e lo racconta il canale dei cron.
    giu: servizio.type === 'ecs' && servizio.overall === 'down',
    inRollout: Boolean(runtime?.deploying),
    task: runtime?.desiredCount != null ? `${runtime.runningCount ?? 0}/${runtime.desiredCount}` : null,
    target: th?.total > 0 ? `${th.healthy ?? 0}/${th.total}` : null,
    tag: build?.tag ?? null,
    repo: build?.repo ?? null,
    revisione: build?.revision ?? null,
    da: build?.deployedAt ?? null,
    chi: build?.by ?? null,
  }
}

// Le Lambda aggiornate INSIEME, cioè dalla stessa persona a pochi minuti l'una dall'altra, sono un
// giro solo: nel canale sono due messaggi per Lambda, qui una riga. Dedotto da ora e autore, che
// sono gli unici due fatti che una Lambda dice di sé. Puro/testabile.
export function lottiLambda(lambda = []) {
  const ordinate = lambda.filter((l) => l.da).sort((a, b) => tempo(a.da) - tempo(b.da))
  const lotti = []
  for (const l of ordinate) {
    const ultimo = lotti.at(-1)
    if (ultimo && ultimo.chi === l.chi && tempo(l.da) - tempo(ultimo.quando) <= FINESTRA_LOTTO_MS) {
      ultimo.nomi.push(l.nome)
      ultimo.quando = l.da
    } else lotti.push({ chi: l.chi, da: l.da, quando: l.da, nomi: [l.nome] })
  }
  return lotti.map((x) => ({ ...x, n: x.nomi.length })).sort((a, b) => piuRecente(a.quando, b.quando))
}

// Come è arrivato in produzione quello che gira. Puro.
// ⚠️ Con le build NON lette non si dice niente: «nessuna build» sarebbe un fatto inventato, ed è quello
// che il quadro diceva su ogni riga il 03/10/2026, quando CodeBuild non rispondeva per un buco di rete.
function comeArrivato(b, sorgente, ecs, buildIgnote = false) {
  if (buildIgnote) return null
  const ultima = b?.ultima
  if (ultima?.kind === 'restart' && ultima.status === 'SUCCEEDED' && tempo(ultima.startedAt) >= tempo(sorgente?.startedAt))
    return { tipo: 'riavvio', chi: ultima.forcedBy ?? null, quando: ultima.startedAt }
  // Una revisione registrata molto dopo la build che ha prodotto l'immagine non è quella build:
  // sono variabili nuove, una promozione a mano o un apply. Gira la stessa immagine, cambiato altro.
  const fine = tempo(sorgente?.endedAt ?? sorgente?.startedAt)
  if (sorgente && ecs?.da && tempo(ecs.da) - fine > SCARTO_REVISIONE_MS)
    return { tipo: 'revisione', chi: ecs.chi ?? null, build: sorgente.number ?? null }
  if (sorgente) {
    const tipo = sorgente.trigger === 'hotfix' ? 'hotfix' : sorgente.trigger === 'manuale' ? 'manuale' : 'ci'
    return { tipo, build: sorgente.number ?? null, durataMs: sorgente.durationMs ?? null, chi: sorgente.forcedBy ?? null }
  }
  if (ecs) return { tipo: 'revisione', chi: ecs.chi ?? null, build: null }
  return null
}

// Una riga per applicazione, unendo ECS e CodeBuild per nome. Puro.
function rigaApp(nome, ecs, builds, { persone, chiave, buildIgnote = false }) {
  const b = statoBuild(builds)
  const riuscita = b?.riuscita ?? null
  // Cosa gira: l'immagine in ECS, che per le build della CI è taggata col commit. Senza ECS (un sito
  // statico), l'ultima build riuscita.
  const commit = corto(ecs?.tag) ?? riuscita?.commit ?? null
  // La build che ha prodotto ciò che gira, se si trova: da lì vengono autore, numero e durata.
  const sorgente = builds.find((x) => x.status === 'SUCCEEDED' && x.kind !== 'restart' && stessoCommit(x.commit, commit)) ?? (ecs ? null : riuscita)
  let stato = 'ok'
  if (ecs?.giu) stato = 'giu'
  else if (b?.stato === 'in_corso' || ecs?.inRollout) stato = 'in_corso'
  else if (b?.stato === 'fallito') stato = 'fallito'
  const u = b?.ultima ?? null
  const tentativo =
    (stato === 'in_corso' && b?.stato === 'in_corso') || stato === 'fallito'
      ? {
          numero: u.number ?? null,
          commit: u.commit ?? null,
          fase: stato === 'fallito' ? (u.failPhase ?? null) : (u.phase ?? null),
          da: u.startedAt ?? null,
          motivo: u.failReason ?? null,
          log: u.logsUrl ?? null,
          riavvio: u.kind === 'restart',
          chi: canonicalActor(u.forcedBy ?? u.author ?? null, persone),
        }
      : null
  const come = comeArrivato(b, sorgente, ecs, buildIgnote)
  return {
    tipo: 'app',
    servizio: nome,
    chiave,
    stato,
    commit,
    repo: sorgente?.repo ?? riuscita?.repo ?? null,
    revisione: ecs?.revisione ?? null,
    task: ecs?.task ?? null,
    target: ecs?.target ?? null,
    quando: come?.quando ?? ecs?.da ?? riuscita?.startedAt ?? null,
    autore: canonicalActor(sorgente?.author ?? null, persone),
    come: come && { ...come, chi: chiLeggibile(canonicalActor(come.chi, persone)) },
    tentativo,
    durataTipica: b?.durataTipica ?? null,
    esterno: !builds.length && Boolean(ecs?.tag) && !tagDiCommit(ecs.tag),
  }
}

// Il quadro di UN ambiente. Entrano il payload per-account di `/api/deploys` e i servizi di
// `/api/status`: è lo stesso dato delle due pagine, quindi zero chiamate AWS in più. Puro/testabile.
export function quadroAmbiente(ambiente, { deploys = {}, servizi = [], persone = null } = {}) {
  const chiavi = Object.keys(deploys).filter((k) => ambienteDi(k) === ambiente && !deploys[k]?.error)
  const chiave =
    chiavi[0] ??
    Object.keys(deploys).find((k) => ambienteDi(k) === ambiente) ??
    servizi.find((s) => ambienteDi(s.account?.key ?? '') === ambiente)?.account?.key ??
    null

  // Le build di questo ambiente si sono lette? Un account in errore (o nessun account) vuol dire che
  // non lo sappiamo, e da lì in giù il quadro non può dedurre niente che dipenda dalle build.
  const erroreBuild = Object.keys(deploys).filter((k) => ambienteDi(k) === ambiente && deploys[k]?.error).map((k) => deploys[k].error)[0] ?? null
  const buildIgnote = chiavi.length === 0
  const perServizio = new Map()
  const iac = []
  for (const k of chiavi) {
    for (const b of deploys[k]?.builds ?? []) {
      // Solo build e riavvii: le altre azioni a mano (shell nei container, porte dei security group)
      // non cambiano cosa gira, e qui diventerebbero «servizi» chiamati come un container o un `sg-…`.
      if (!b.service || b.provider === 'cloudflare' || (b.kind && b.kind !== 'restart')) continue
      if (b.iac) iac.push(b)
      else perServizio.set(nomeBreve(b.service), [...(perServizio.get(nomeBreve(b.service)) ?? []), b])
    }
  }

  const delQui = servizi.filter((s) => ambienteDi(s.account?.key ?? '') === ambiente)
  const ecs = delQui.filter((s) => s.type === 'ecs' || s.type === 'ecs-scheduled').map(datiEcs)
  const lambda = delQui
    .filter((s) => s.type === 'lambda')
    .map((s) => ({ nome: nomeBreve(s.name), da: s.checks?.version?.build?.deployedAt ?? null, chi: s.checks?.version?.build?.by ?? null }))

  // Le immagini condivise: stesso repo su due o più servizi o cron, e NESSUNO di loro ha una build
  // propria. Dedotto dal dato, senza elenchi: un repo nuovo condiviso entra da sé.
  const perRepo = new Map()
  for (const e of ecs) if (e.repo) perRepo.set(e.repo, [...(perRepo.get(e.repo) ?? []), e])
  const gruppi = []
  const inGruppo = new Set()
  for (const [repo, lista] of perRepo) {
    // Senza build lette non si sa chi ne ha una propria: raggruppare metterebbe il Backend fra le
    // immagini condivise, col primo cron sul tag `latest` segnato come «rimasto indietro».
    if (buildIgnote || lista.length < 2 || lista.some((e) => perServizio.has(e.nome))) continue
    lista.forEach((e) => inGruppo.add(e.nome))
    // Il tag più recente è «quello che gira»; chi ne ha un altro è rimasto indietro e si dice per nome.
    const recente = lista.reduce((a, e) => (tempo(e.da) > tempo(a.da) ? e : a), lista[0])
    gruppi.push({
      tipo: 'immagine',
      nome: repo,
      chiave,
      tag: corto(recente.tag),
      servizi: lista.filter((e) => e.tipo === 'ecs').map((e) => e.nome).sort(),
      cron: lista.filter((e) => e.tipo === 'ecs-scheduled').map((e) => e.nome).sort(),
      indietro: lista.filter((e) => e.tag !== recente.tag).map((e) => ({ nome: e.nome, tag: corto(e.tag) })),
      quando: recente.da,
      chi: chiLeggibile(recente.chi),
      giu: lista.filter((e) => e.giu).map((e) => e.nome),
      inRollout: lista.some((e) => e.inRollout),
      esterno: !tagDiCommit(recente.tag),
    })
  }

  const ecsServizi = new Map(ecs.filter((e) => e.tipo === 'ecs' && !inGruppo.has(e.nome)).map((e) => [e.nome, e]))
  const nomi = [...new Set([...ecsServizi.keys(), ...perServizio.keys()])]
  const tutte = nomi.map((n) => rigaApp(n, ecsServizi.get(n) ?? null, perServizio.get(n) ?? [], { persone, chiave, buildIgnote }))

  // I componenti esterni (proxy, agenti, orchestratori: versioni fissate dall'IaC) stanno a parte,
  // che siano un servizio solo o un'immagine condivisa: non sono rilasci di nessuno.
  const esterni = [
    ...tutte
      .filter((r) => r.esterno)
      .map((r) => ({ tipo: 'esterno', nome: r.servizio, chiave, tag: r.commit, nomi: [r.servizio], quando: r.quando, chi: r.come?.chi ?? null, giu: r.stato === 'giu', inRollout: r.stato === 'in_corso' })),
    ...gruppi
      .filter((g) => g.esterno)
      .map((g) => ({ tipo: 'esterno', nome: g.nome, chiave, tag: g.tag, nomi: [...g.servizi, ...g.cron], quando: g.quando, chi: g.chi, giu: g.giu.length > 0, inRollout: g.inRollout })),
  ]

  const i = statoBuild(iac)
  const ultimaIac = i?.ultima ?? null
  const infra = i && {
    tipo: 'iac',
    chiave,
    stato: i.stato,
    commit: (i.stato === 'ok' ? i.riuscita : ultimaIac)?.commit ?? null,
    repo: ultimaIac?.repo ?? null,
    numero: ultimaIac?.number ?? null,
    quando: ultimaIac?.startedAt ?? null,
    durataMs: ultimaIac?.durationMs ?? null,
    durataTipica: i.durataTipica,
    chi: canonicalActor(ultimaIac?.author ?? null, persone),
    fase: i.stato === 'fallito' ? (ultimaIac?.failPhase ?? null) : (ultimaIac?.phase ?? null),
    motivo: i.stato === 'fallito' ? (ultimaIac?.failReason ?? null) : null,
    log: i.stato === 'fallito' ? (ultimaIac?.logsUrl ?? null) : null,
  }

  return {
    ambiente,
    chiave,
    app: tutte.filter((r) => !r.esterno),
    immagini: gruppi.filter((g) => !g.esterno).sort((a, b) => a.nome.localeCompare(b.nome)),
    esterni,
    lambda: lottiLambda(lambda).map((l) => ({ ...l, tipo: 'lambda', chiave, chi: chiLeggibile(l.chi) })),
    lambdaSenzaData: lambda.filter((l) => !l.da).length,
    infra,
    buildIgnote,
    erroreBuild,
  }
}

// Tutti gli ambienti chiesti, più il confronto con staging sulle righe di produzione. Puro/testabile.
export function quadro({ deploys = {}, servizi = [], persone = null } = {}, ambienti = ['produzione', 'staging']) {
  const out = Object.fromEntries(ambienti.map((a) => [a, quadroAmbiente(a, { deploys, servizi, persone })]))
  if (out.produzione) {
    const staging = out.staging ?? quadroAmbiente('staging', { deploys, servizi, persone })
    const inStaging = new Map(staging.app.map((r) => [r.servizio, r.commit]))
    for (const r of out.produzione.app) {
      const s = inStaging.get(r.servizio)
      // «Su un altro commit», non «da rilasciare»: senza la storia git non si sa chi dei due è avanti,
      // e dirlo sarebbe inventare. Nel caso normale è staging, e chi legge lo sa.
      if (s && r.commit && !stessoCommit(s, r.commit)) r.staging = s
    }
  }
  return out
}

// ── La resa ──────────────────────────────────────────────────────────────────────────────────────

// «4 min», «3 h», «2 g»: abbastanza per capire se un rilascio è appeso o vecchio. Puro.
export function eta(iso, ora = Date.now()) {
  if (!iso) return '?'
  const min = Math.max(0, Math.round((ora - tempo(iso)) / 60_000))
  if (min < 60) return `${min} min`
  const ore = Math.round(min / 60)
  if (ore < 24) return `${ore} h`
  return `${Math.round(ore / 24)} g`
}

// La durata di una build: «45 s», «6 min». Puro.
export function durata(ms) {
  if (!(ms > 0)) return null
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`
}

// Il commit apre la sua pagina su GitHub quando il repository è noto. Il link non va fra backtick:
// dentro un blocco di codice Slack non riconosce i link.
const sha = (c, repo) => (c ? (repo ? `<${repo}/commit/${c}|${c}>` : `\`${c}\``) : '`?`')
const tronca = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
// Un elenco di nomi lungo si accorcia: i primi, poi quanti altri.
const elenco = (nomi, n = 6) => (nomi.length > n ? `${nomi.slice(0, n).join(', ')} e altri ${nomi.length - n}` : nomi.join(', '))
const plurale = (n, uno, tanti) => `${n} ${n === 1 ? uno : tanti}`

// I link a Dadaguard già filtrati sulla risorsa della riga. Le applicazioni e l'IaC hanno una storia
// di build, quindi vanno alla pagina Deploy; Lambda, immagini condivise e componenti esterni non ne
// hanno, quindi vanno alla pagina Servizi filtrata sui loro nomi.
export function linkRisorsa(v, url) {
  if (!url || !v.chiave) return null
  const account = encodeURIComponent(v.chiave)
  if (v.tipo === 'app') return `${url}/deploy?service=${encodeURIComponent(v.servizio)}&account=${account}`
  if (v.tipo === 'iac') return `${url}/deploy?service=IaC&account=${account}`
  const nomi = v.tipo === 'immagine' ? [...v.servizi, ...v.cron] : v.nomi
  const conNomi = `${url}/servizi?account=${account}&q=${encodeURIComponent(nomi.join(','))}`
  // Slack tronca gli indirizzi oltre i 3000 caratteri: meglio la pagina dell'ambiente intero che un
  // filtro tagliato a metà, che mostrerebbe solo una parte senza dirlo.
  return conNomi.length <= 2900 ? conNomi : `${url}/servizi?account=${account}`
}

// Come è arrivato quello che gira, in parole. Puro.
function comeTesto(c) {
  if (!c) return null
  const chi = c.chi ? ` ${daChi(c.chi)}` : ''
  if (c.tipo === 'ci') return `build #${c.build ?? '?'} della CI${durata(c.durataMs) ? ` in ${durata(c.durataMs)}` : ''}`
  if (c.tipo === 'hotfix') return `hotfix forzato${chi}, build #${c.build ?? '?'}`
  if (c.tipo === 'manuale') return `build #${c.build ?? '?'} avviata a mano${chi}`
  if (c.tipo === 'riavvio') return `riavviato a mano${chi}`
  return `revisione registrata${chi}${c.build ? `, immagine della build #${c.build}` : ', nessuna build'}`
}

// Una «voce» del quadro: la riga principale e i dettagli sotto, più piccoli. `livello` decide dove
// va: `adesso` (rotto, giù, indietro, in corso) o `recente`. Puro/testabile.
export function voce(v, { ora = Date.now() } = {}) {
  if (v.tipo === 'app') return voceApp(v, ora)
  if (v.tipo === 'immagine') return voceImmagine(v, ora)
  if (v.tipo === 'lambda')
    // Una Lambda sola si chiama per nome; un giro intero si conta, e i nomi vanno sotto.
    return {
      livello: 'recente',
      gravita: 4,
      quando: v.quando,
      testo: v.n === 1 ? `⚙️  *${v.nomi[0]}*  Lambda aggiornata${SEP}${eta(v.quando, ora)} fa` : `⚙️  *${v.n} Lambda aggiornate*${SEP}${eta(v.quando, ora)} fa`,
      dettagli: [daChi(v.chi), v.n > 1 && elenco(v.nomi)],
    }
  if (v.tipo === 'esterno') {
    const su = v.nomi.length > 1 ? ` su ${v.nomi.length}` : ''
    if (v.giu) return { livello: 'adesso', gravita: 0, quando: v.quando, testo: `🚨  *${v.nome}*  giù`, dettagli: [`\`${v.tag}\`${su}`, 'componente esterno'] }
    if (v.inRollout)
      return { livello: 'adesso', gravita: 3, quando: v.quando, testo: `⏳  *${v.nome}*  rollout in corso`, dettagli: [`\`${v.tag}\`${su}`, 'componente esterno, versione fissata dall’IaC'] }
    return {
      livello: 'recente',
      gravita: 4,
      quando: v.quando,
      testo: `📦  *${v.nome}*  \`${v.tag}\`${su}${SEP}${eta(v.quando, ora)} fa`,
      // Chi l'ha cambiato si dice solo se non è l'IaC stessa: «fissata dall'IaC, dall'IaC» non informa.
      dettagli: ['componente esterno, versione fissata dall’IaC', !daIac(v.chi) && daChi(v.chi)],
    }
  }
  if (v.tipo === 'iac') return voceIac(v, ora)
  return null
}

function voceApp(r, ora) {
  const c = sha(r.commit, r.repo)
  const rev = r.revisione ? `rev ${r.revisione}` : null
  const salute = [r.task && `${r.task} task`, r.target && `${r.target} target sani`].filter(Boolean).join(', ') || null
  const t = r.tentativo
  if (r.stato === 'giu')
    return {
      livello: 'adesso',
      gravita: 0,
      quando: r.quando,
      testo: `🚨  *${r.servizio}*  giù: ${r.task ?? '?'} task attivi`,
      dettagli: [`gira ${c}${rev ? ` (${rev})` : ''}`, r.target && `${r.target} target sani`, r.quando && `ultimo cambio ${eta(r.quando, ora)} fa`],
    }
  if (r.stato === 'fallito') {
    const gira = r.commit ? `gira ancora ${c}${rev ? ` (${rev})` : ''}` : 'nessun rilascio riuscito visto'
    if (t.riavvio)
      return {
        livello: 'adesso',
        gravita: 1,
        quando: t.da,
        testo: `🔴  *${r.servizio}*  riavvio a mano fallito ${eta(t.da, ora)} fa`,
        dettagli: [t.chi && `da ${t.chi}`, t.motivo && `motivo: ${tronca(t.motivo, 140)}`, gira],
      }
    return {
      livello: 'adesso',
      gravita: 1,
      quando: t.da,
      testo: `🔴  *${r.servizio}*  build${t.numero ? ` #${t.numero}` : ''} fallita${t.fase ? ` al ${t.fase}` : ''} ${eta(t.da, ora)} fa`,
      dettagli: [gira, t.commit && `tentava ${sha(t.commit, r.repo)}`, t.chi && `di ${t.chi}`, t.motivo && `motivo: ${tronca(t.motivo, 140)}`, t.log && `<${t.log}|log della build>`],
    }
  }
  if (r.stato === 'in_corso') {
    if (t) {
      const tipico = durata(r.durataTipica) ? `, di solito ${durata(r.durataTipica)}` : ''
      const verso = t.commit && !stessoCommit(t.commit, r.commit) ? `da ${c} a ${sha(t.commit, r.repo)}` : `commit ${sha(t.commit ?? r.commit, r.repo)}`
      return {
        livello: 'adesso',
        gravita: 3,
        quando: t.da,
        testo: `⏳  *${r.servizio}*  build${t.numero ? ` #${t.numero}` : ''} in corso da ${eta(t.da, ora)}${tipico}`,
        dettagli: [t.fase && `fase ${t.fase}`, verso, t.chi && `di ${t.chi}`, salute],
      }
    }
    return {
      livello: 'adesso',
      gravita: 3,
      quando: r.quando,
      testo: `⏳  *${r.servizio}*  rollout in corso`,
      dettagli: [`${c}${rev ? ` (${rev})` : ''}`, salute, comeTesto(r.come)],
    }
  }
  return {
    livello: 'recente',
    gravita: 4,
    quando: r.quando,
    testo: `🚀  *${r.servizio}*  ${c}${SEP}${eta(r.quando, ora)} fa`,
    dettagli: [rev, salute, comeTesto(r.come), r.autore && `commit di ${r.autore}`, r.staging && `staging su \`${r.staging}\``],
  }
}

function voceImmagine(g, ora) {
  const quanti = [g.servizi.length && plurale(g.servizi.length, 'servizio', 'servizi'), g.cron.length && `${g.cron.length} cron`].filter(Boolean).join(' e ')
  const tutti = [...g.servizi, ...g.cron]
  if (g.giu.length)
    return { livello: 'adesso', gravita: 0, quando: g.quando, testo: `🚨  *${g.nome}*  giù: ${elenco(g.giu, 4)}`, dettagli: [`immagine \`${g.tag}\` su ${quanti}`] }
  if (g.indietro.length)
    return {
      livello: 'adesso',
      gravita: 2,
      quando: g.quando,
      testo: `⚠️  *${g.nome}*  ${g.indietro.length} di ${tutti.length} su un’immagine più vecchia`,
      dettagli: [g.indietro.map((x) => `${x.nome} su \`${x.tag ?? '?'}\``).join(', '), `gli altri su \`${g.tag}\` da ${eta(g.quando, ora)}`],
    }
  if (g.inRollout)
    return { livello: 'adesso', gravita: 3, quando: g.quando, testo: `⏳  *${g.nome}*  rollout in corso`, dettagli: [`immagine \`${g.tag}\` su ${quanti}`] }
  return {
    livello: 'recente',
    gravita: 4,
    quando: g.quando,
    testo: `🔄  *${g.nome}*  \`${g.tag}\` su ${quanti}${SEP}${eta(g.quando, ora)} fa`,
    dettagli: [g.chi && `registrata ${daChi(g.chi)}`, elenco(tutti)],
  }
}

function voceIac(i, ora) {
  const c = `commit ${sha(i.commit, i.repo)}`
  const build = i.numero ? `build #${i.numero}` : null
  if (i.stato === 'in_corso') {
    const tipico = durata(i.durataTipica) ? `, di solito ${durata(i.durataTipica)}` : ''
    return { livello: 'adesso', gravita: 3, quando: i.quando, testo: `⏳  *IaC*  apply in corso da ${eta(i.quando, ora)}${tipico}`, dettagli: [c, build, i.fase && `fase ${i.fase}`, i.chi && `di ${i.chi}`] }
  }
  if (i.stato === 'fallito')
    return {
      livello: 'adesso',
      gravita: 1,
      quando: i.quando,
      testo: `🔴  *IaC*  apply fallito${i.fase ? ` al ${i.fase}` : ''} ${eta(i.quando, ora)} fa`,
      dettagli: [c, build, i.chi && `di ${i.chi}`, i.motivo && `motivo: ${tronca(i.motivo, 140)}`, i.log && `<${i.log}|log della build>`],
    }
  return {
    livello: 'recente',
    gravita: 4,
    quando: i.quando,
    testo: `🏗️  *IaC*  apply riuscito${SEP}${eta(i.quando, ora)} fa`,
    dettagli: [c, build && `${build}${durata(i.durataMs) ? ` in ${durata(i.durataMs)}` : ''}`, i.chi && `di ${i.chi}`],
  }
}

// Il testo di ripiego (notifiche, anteprima, lettori di schermo) E il marcatore con cui il messaggio
// si ritrova se Slack non restituisce i metadati: per questo comincia sempre con le stesse parole.
export function intestazione(ambiente) {
  return `Quadro deploy [${AMBIENTI[ambiente]?.tag ?? ambiente.toUpperCase()}]`
}

// Una voce in due blocchi: la riga principale, col link a Dadaguard in fondo, e i dettagli sotto in
// piccolo. Slack accetta 3000 caratteri per testo: si taglia prima, o rifiuta il messaggio intero.
function blocchiVoce(x, link) {
  const apri = link ? `${SEP}<${link}|Dadaguard ›>` : ''
  const out = [{ type: 'section', text: { type: 'mrkdwn', text: tronca(`${x.testo}${apri}`, 2900) } }]
  const dettagli = x.dettagli.filter(Boolean).join(SEP)
  if (dettagli) out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: tronca(dettagli, 2900) }] })
  return out
}

const titolo = (t) => ({ type: 'section', text: { type: 'mrkdwn', text: `*${t}*` } })
const piccolo = (t) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: tronca(t, 2900) }] })

// Il messaggio Slack di un ambiente. Puro/testabile.
export function messaggioQuadro(q, { ora = Date.now(), url = null, ore = DEFAULT_ORE } = {}) {
  const { ambiente, chiave, app = [], immagini = [], esterni = [], lambda = [], lambdaSenzaData = 0, infra = null, buildIgnote = false, erroreBuild = null } = q
  const meta = AMBIENTI[ambiente] ?? { titolo: ambiente.toUpperCase(), tag: ambiente.toUpperCase(), colore: '#868686' }
  const soglia = ora - ore * 3_600_000
  const recente = (x) => x.quando && tempo(x.quando) >= soglia

  // Ogni risorsa diventa una voce; chi non è né «adesso» né recente finisce nel conteggio del resto.
  const adesso = []
  const recenti = []
  const resto = { app: 0, immagini: 0, lambda: lambdaSenzaData, esterni: 0, iac: null }
  const smista = (v, chiaveResto, peso = 1) => {
    const x = voce(v, { ora })
    if (!x) return
    const conLink = { ...x, link: linkRisorsa(v, url) }
    if (x.livello === 'adesso') adesso.push(conLink)
    else if (recente(x)) recenti.push(conLink)
    else if (chiaveResto === 'iac') resto.iac = v.quando
    else resto[chiaveResto] += peso
  }
  app.forEach((r) => smista(r, 'app'))
  immagini.forEach((g) => smista(g, 'immagini'))
  esterni.forEach((e) => smista(e, 'esterni'))
  lambda.forEach((l) => smista(l, 'lambda', l.n))
  if (infra) smista(infra, 'iac')

  adesso.sort((a, b) => a.gravita - b.gravita || piuRecente(a.quando, b.quando))
  recenti.sort((a, b) => piuRecente(a.quando, b.quando))

  // Tre conti, ognuno col suo segno: rotto (giù o fallito), da guardare (rimasto indietro), in corso.
  // Un solo «🔴 da guardare» metteva il rosso anche su un cron con l'immagine vecchia.
  const rotti = adesso.filter((x) => x.gravita <= 1).length
  const avvisi = adesso.filter((x) => x.gravita === 2).length
  const inCorso = adesso.length - rotti - avvisi
  const diversi = app.filter((r) => r.staging)
  const pezzi = [
    rotti && `🔴 ${plurale(rotti, 'rotto', 'rotti')}`,
    avvisi && `⚠️ ${avvisi} da guardare`,
    inCorso && `⏳ ${inCorso} in corso`,
    `🚀 ${plurale(recenti.length, 'rilascio', 'rilasci')} nelle ultime ${ore} h`,
    diversi.length && `${diversi.length} su un commit diverso da staging`,
    buildIgnote && '⚠️ build non lette',
  ].filter(Boolean)
  // «Niente di rotto» si dice solo se lo sappiamo: con le build non lette un fallimento non si vede.
  const sintesi = adesso.length || buildIgnote ? pezzi : ['✅ niente di rotto, niente in corso', ...pezzi]
  const orario = new Date(ora).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })

  // Titolo e sintesi stanno FUORI dall'allegato, il corpo dentro: il blocco `header` è garantito solo
  // al primo livello del messaggio, e un messaggio con un blocco rifiutato non parte affatto.
  const testa = [
    { type: 'header', text: { type: 'plain_text', text: meta.titolo, emoji: true } },
    piccolo([...sintesi, `aggiornato alle ${orario}`].join(SEP)),
  ]

  const tuttiDeploy = url && chiave ? `${url}/deploy?account=${encodeURIComponent(chiave)}` : null
  const tuttiServizi = url && chiave ? `${url}/servizi?account=${encodeURIComponent(chiave)}` : null
  const oltre = (n, link) => piccolo(`e ${n === 1 ? 'un altro' : `altri ${n}`}${link ? `: <${link}|tutti su Dadaguard>` : ''}`)

  const corpo = []
  if (buildIgnote)
    corpo.push(piccolo(`⚠️ *Build non lette*${erroreBuild ? `: ${erroreBuild}` : ''}. Quello che gira lo dice ECS, ma commit, autori e build in corso o fallite mancano finché non tornano leggibili.`))
  if (adesso.length) {
    corpo.push(titolo('Adesso'))
    adesso.slice(0, MAX_ADESSO).forEach((x) => corpo.push(...blocchiVoce(x, x.link)))
    if (adesso.length > MAX_ADESSO) corpo.push(oltre(adesso.length - MAX_ADESSO, tuttiServizi))
  }
  corpo.push(titolo(`Ultime ${ore} ore`))
  if (recenti.length) {
    recenti.slice(0, MAX_RECENTI).forEach((x) => corpo.push(...blocchiVoce(x, x.link)))
    if (recenti.length > MAX_RECENTI) corpo.push(oltre(recenti.length - MAX_RECENTI, tuttiDeploy))
  } else corpo.push(piccolo('nessun rilascio'))

  const fermi = [
    resto.app && plurale(resto.app, 'applicazione', 'applicazioni'),
    resto.lambda && `${resto.lambda} Lambda`,
    resto.immagini && plurale(resto.immagini, 'immagine condivisa', 'immagini condivise'),
    resto.esterni && plurale(resto.esterni, 'componente esterno', 'componenti esterni'),
    resto.iac && `IaC, ultimo apply ${eta(resto.iac, ora)} fa`,
  ].filter(Boolean)
  if (fermi.length) corpo.push(piccolo(`*Senza novità nelle ultime ${ore} ore*: ${fermi.join(SEP)}`))

  // I filtri: link alla pagina di Dadaguard già filtrata. Quello sui servizi diversi da staging apre i
  // deploy di quei servizi nei due ambienti insieme, cioè il confronto che serve.
  const link = [
    tuttiDeploy && `<${tuttiDeploy}|Deploy ${meta.tag}>`,
    tuttiServizi && `<${tuttiServizi}|Servizi ${meta.tag}>`,
    url && diversi.length && `<${url}/deploy?service=${encodeURIComponent(diversi.map((r) => r.servizio).join(','))}|${diversi.length} diversi da staging>`,
  ].filter(Boolean)
  if (link.length) corpo.push({ type: 'divider' }, piccolo(`Su Dadaguard: ${link.join(SEP)}`))

  return {
    text: `${intestazione(ambiente)}: ${sintesi.join(' · ')}`,
    blocks: testa,
    // Gli allegati sono l'unico modo di avere la barra colorata: il corpo sta dentro.
    attachments: [{ color: meta.colore, blocks: corpo }],
    metadata: { event_type: EVENTO, event_payload: { ambiente } },
  }
}

// Il link che apre il messaggio nel Block Kit Builder di Slack: l'anteprima di come apparirà, senza
// mandare niente a nessuno. Puro.
//
// ⚠️ Col workspace (`T0…`) l'indirizzo è `/block-kit-builder/<workspace>/builder#…`. Senza, Slack
// reindirizza al workspace di chi apre e per strada perde il contenuto: la pagina si apre VUOTA,
// che si legge come «l'anteprima non funziona». Il workspace non sta nel codice (il repo è pubblico):
// arriva da `DADAGUARD_SLACK_TEAM_ID`.
export function anteprimaUrl(msg, { team = null } = {}) {
  const payload = encodeURIComponent(JSON.stringify({ blocks: msg.blocks, attachments: msg.attachments }))
  return team ? `https://app.slack.com/block-kit-builder/${team}/builder#${payload}` : `https://app.slack.com/block-kit-builder/#${payload}`
}

// ── La parte che parla con Slack ──────────────────────────────────────────────────────────────────

// Una chiamata alla Web API, senza SDK (come `postSlack`). Slack risponde 200 anche sugli errori, col
// motivo in `error`: si controlla `ok`, non lo status HTTP.
export async function chiamaSlack(metodo, corpo, token, { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const get = metodo === 'pins.list' || metodo === 'auth.test'
    const qs = get ? `?${new URLSearchParams(corpo ?? {})}` : ''
    const res = await fetch(`https://slack.com/api/${metodo}${qs}`, {
      method: get ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(get ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
      body: get ? undefined : JSON.stringify(corpo),
      signal: ctrl.signal,
    })
    const json = await res.json()
    if (!json.ok) throw new Error(`slack ${metodo}: ${json.error ?? res.status}`)
    return json
  } finally {
    clearTimeout(timer)
  }
}

// Il quadro di un ambiente fra i messaggi fissati: scritto da NOI (stesso bot) e con quell'ambiente
// nei metadati, o in mancanza con l'intestazione nel testo. Il bot conta: un collega che fissa a mano
// un messaggio che comincia uguale non deve vedersi riscrivere il suo. Puro/testabile.
export function trovaFissato(items = [], { botId, ambiente }) {
  const marcatore = intestazione(ambiente)
  const msg = items
    .filter((i) => i.type === 'message' && i.message)
    .map((i) => i.message)
    .find((m) => {
      if (botId && m.bot_id !== botId) return false
      const meta = m.metadata
      if (meta?.event_type === EVENTO) return meta.event_payload?.ambiente === ambiente
      return String(m.text ?? '').startsWith(marcatore)
    })
  return msg?.ts ?? null
}

// Un giro: per ogni ambiente ritrova il quadro e lo riscrive, o lo manda e lo fissa se non c'è.
// `deps` per le prove: `leggiDati` ({ deploys, servizi }) e `api` (la Web API).
export async function aggiornaQuadri(cfg, deps = {}) {
  const api = deps.api ?? ((m, c) => chiamaSlack(m, c, cfg.token))
  const dati = await deps.leggiDati()
  const q = quadro({ ...dati, persone: deps.persone ?? null }, cfg.ambienti)
  const ora = deps.ora ?? Date.now()
  const { bot_id: botId } = await api('auth.test', {})
  const { items = [] } = await api('pins.list', { channel: cfg.canale })
  const esiti = []
  for (const ambiente of cfg.ambienti) {
    const msg = messaggioQuadro(q[ambiente], { ora, url: cfg.publicUrl, ore: cfg.ore })
    const ts = trovaFissato(items, { botId, ambiente })
    if (ts) {
      await api('chat.update', { channel: cfg.canale, ts, ...msg })
      esiti.push({ ambiente, azione: 'riscritto', ts })
    } else {
      const r = await api('chat.postMessage', { channel: cfg.canale, ...msg })
      await api('pins.add', { channel: cfg.canale, timestamp: r.ts })
      esiti.push({ ambiente, azione: 'creato', ts: r.ts })
    }
  }
  return esiti
}

export function startQuadro(leggiDati, env = process.env) {
  const cfg = quadroConfig(env)
  if (!cfg.token || !cfg.canale) {
    log.info('quadro: nessun DADAGUARD_SLACK_BOT_TOKEN o DADAGUARD_QUADRO_CANALE, quadro spento')
    return null
  }
  log.info('quadro: attivo', { ogni: `${cfg.intervalMs / 1000}s`, ambienti: cfg.ambienti })
  const tick = () =>
    // `people` si rilegge a ogni giro, come la config del resto: un alias aggiunto vale dal giro dopo.
    aggiornaQuadri(cfg, { leggiDati, persone: loadConfig().people ?? null })
      .then((esiti) => log.info('quadro: giro', { esiti: esiti.map((e) => `${e.ambiente}:${e.azione}`) }))
      .catch((err) => log.error('quadro: giro fallito', { err: err.message }))
  tick()
  const timer = setInterval(tick, cfg.intervalMs)
  timer.unref?.()
  return timer
}
