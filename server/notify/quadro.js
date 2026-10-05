import { log } from '../log.js'
import { ambienteDi } from '../rilasci.js'
import { canonicalActor } from '../util/principal.js'
import { stripOrgEnv } from '../util/envToken.js'
import { loadConfig } from '../config.js'
import { postSlack } from './slack.js'

// Il QUADRO dei deploy: il CANVAS di un canale Slack, uno per ambiente, riscritto a ogni giro. Sta al
// posto del registro in cui ogni build lascia due messaggi (`⏳` all'avvio, `🚀`/`🔴` alla fine), ogni
// giro dei cron Lambda due per cron e ogni revisione registrata da un automatismo uno. In un giorno
// normale il canale dei rilasci ne riceve un centinaio, e la domanda vera («cosa gira adesso, e c'è
// qualcosa di rotto?») si risponde leggendo all'indietro.
//
// Perché il canvas e non un messaggio fissato: il canvas del canale è una scheda in cima, sempre a un
// clic, mentre un messaggio fissato resta dov'era nella storia e i messaggi nuovi lo spingono via. E il
// canvas ha le tabelle, che un messaggio non ha. Un canale per ambiente, perché un canale ha un canvas
// solo: l'ambiente lo dice il canale.
//
// ⚠️ La flotta è grande (decine di servizi, cron e Lambda per ambiente), quindi il quadro NON è un
// inventario: un elenco di tutto sarebbe illeggibile quanto il canale che sostituisce. Ha tre piani,
// e solo i primi due hanno righe, ognuno col suo tetto:
//   Adesso        quello che è rotto, giù, rimasto indietro o in corso
//   Ultime N ore  i rilasci recenti, dal più nuovo; quelli fatti insieme sono UNA riga (le Lambda di
//                 un giro dei cron, i servizi che girano la stessa immagine)
//   Il resto      un conteggio, senza nomi: per vederli c'è il link a Dadaguard
// Così la lunghezza del quadro dipende da quanto succede, non da quante risorse esistono.
//
// La verità su COSA GIRA la dice ECS, non CodeBuild: è l'unica fonte che vede tutte le strade per cui
// un servizio cambia (la build della CI, una revisione promossa a mano, un riavvio, le variabili
// aggiornate, la revisione registrata da un automatismo, un apply Terraform sulla task definition).
// CodeBuild aggiunge quello che ECS non sa: il commit, chi l'ha scritto, la build in corso o fallita.
//
// Cosa il quadro copre del canale dei rilasci, e cosa no:
//   ⏳ 🚀 🔴 deploy da CodeBuild                  righe delle applicazioni
//   ⏳ revisione promossa a mano, riavvii, SSM    revisione o rollout nuovo, visto da ECS
//   🔄 revisione nuova da un automatismo          una riga per IMMAGINE condivisa
//   ⏳ 🚀 deploy dei cron Lambda                  una riga per giro, dedotta da ora e autore
//   ⏳ 🚀 ➖ apply dell'infrastruttura             riga IaC
//   🧪 test avviati, deploy saltato o non avviato  NO: vivono in GitHub Actions, che Dadaguard non legge
//
// ⚠️ Riscrivere un canvas non manda notifiche: è il suo pregio (niente rumore) e il suo limite. Per
// questo quando qualcosa si ROMPE (build o apply fallito, servizio giù) il bot scrive anche un
// messaggio nel canale, e lo chiude con ✅ quando torna a posto (vedi `pianoAllarmi`): se va tutto bene
// il canale resta muto, se qualcosa si rompe chi segue il canale lo sa.
//
// Zero storage, come il resto: il canvas da riscrivere non si ricorda, si cerca fra le schede del
// canale (vedi `canvasDelCanale`). Se il canale non ne ha uno, si crea.
//
// Configurazione (tutta opzionale: senza token o canali il quadro non parte e non chiama niente):
//   DADAGUARD_SLACK_BOT_TOKEN   token `xoxb-` di un'app Slack con `canvases:write`, `chat:write`,
//                               `channels:read` e `groups:read` (per i canali privati), invitata nei
//                               canali (deploy/slack-app-manifest.yml). Un webhook NON basta: non
//                               scrive canvas e non modifica i messaggi che ha mandato
//   DADAGUARD_QUADRO_CANALI     un canale per ambiente, nell'ordine dei giri:
//                               `produzione=C0123,staging=C0456`. Gli id, non i nomi
//   DADAGUARD_QUADRO_INTERVAL   secondi fra i giri (default 15, minimo 10). Slack regge ~50 modifiche
//                               di canvas al minuto, e il giro scrive solo i canvas che cambiano
//   DADAGUARD_QUADRO_ORE        quanto indietro guarda «Ultime N ore» (default 24)
//   DADAGUARD_QUADRO_SQUADRE    le squadre con una scheda loro, e i repository che possiedono:
//                               `data=Scraper,scraper-image;altra=repo`. Chi possiede cosa AWS non lo
//                               sa, quindi questa è la sola riga scritta a mano, ed è per REPOSITORY
//                               (il sorgente della build o il repo dell'immagine): una risorsa nuova
//                               di quei repo entra da sé
//   DADAGUARD_SLACK_WEBHOOK     dove dire che il quadro è FERMO (vedi `guardiaQuadro`): lo stesso
//                               canale degli allarmi del watchdog. Senza, lo si dice solo nel log

// 15 secondi: un deploy si vede partire quasi subito. Si può perché ogni lettura del giro è gratuita
// (server/quadroStato.js) e il canvas si riscrive solo quando cambia.
const DEFAULT_INTERVAL_S = 15
const DEFAULT_ORE = 24
// I tetti delle righe. Oltre, una riga dice quante ne mancano e porta a Dadaguard.
const MAX_ADESSO = 10
const MAX_RECENTI = 12
// Le Lambda aggiornate dalla stessa persona a meno di questo l'una dall'altra sono un giro solo: un
// workflow dei cron ne rilascia una ventina in un paio di minuti.
const FINESTRA_LOTTO_MS = 15 * 60_000
// Una revisione ECS registrata oltre questo dopo la fine della build che ha prodotto l'immagine non
// è quella build: è una revisione nuova (variabili, promozione a mano, Terraform) sulla stessa immagine.
const SCARTO_REVISIONE_MS = 15 * 60_000
const FALLITI = new Set(['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'])

// Il titolo del canvas porta l'ambiente col suo colore: il canale lo dice già, ma un canvas aperto da
// un link o dalla ricerca si legge da solo.
export const AMBIENTI = {
  produzione: { titolo: '🟥 Quadro deploy PRODUZIONE', tag: 'PROD', sezione: '🟥 Produzione' },
  staging: { titolo: '🟨 Quadro deploy STAGING', tag: 'STAGING', sezione: '🟨 Staging' },
}
// Le schede che attraversano gli ambienti, una sezione per ambiente dentro.
export const TITOLO_CRON = '⏰ Quadro deploy CRON'
export const titoloSquadra = (s) => `📊 Quadro deploy ${String(s).toUpperCase()}`

export function quadroConfig(env = process.env) {
  // `produzione=C0123,staging=C0456`. L'ordine è quello dei giri; un ambiente che non conosciamo si
  // scarta, perché un canvas su un ambiente che il quadro non sa calcolare sarebbe vuoto per sempre.
  const canali = Object.fromEntries(
    String(env.DADAGUARD_QUADRO_CANALI ?? '')
      .split(',')
      .map((x) => x.split('=').map((y) => y.trim()))
      .filter(([amb, id]) => AMBIENTI[amb] && id),
  )
  const ore = Number(env.DADAGUARD_QUADRO_ORE)
  // `data=Scraper,scraper-image;altra=repo`, in minuscolo: i nomi dei repository non distinguono le
  // maiuscole quando li si confronta, e un `Scraper` contro `scraper` mancato sarebbe un buco muto.
  const squadre = Object.fromEntries(
    String(env.DADAGUARD_QUADRO_SQUADRE ?? '')
      .split(';')
      .map((x) => x.split('='))
      .filter(([nome, repo]) => nome?.trim() && repo?.trim())
      .map(([nome, repo]) => [nome.trim().toLowerCase(), repo.split(',').map((r) => r.trim().toLowerCase()).filter(Boolean)]),
  )
  return {
    token: env.DADAGUARD_SLACK_BOT_TOKEN || null,
    canali,
    squadre,
    // Senza canali si calcolano comunque tutti e due: servono all'anteprima di `/api/quadro`.
    ambienti: Object.keys(canali).length ? Object.keys(canali) : Object.keys(AMBIENTI),
    intervalMs: Math.max(10, Number(env.DADAGUARD_QUADRO_INTERVAL) || DEFAULT_INTERVAL_S) * 1000,
    ore: Number.isFinite(ore) && ore > 0 ? ore : DEFAULT_ORE,
    publicUrl: env.DADAGUARD_PUBLIC_URL || null,
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
    immagine: ecs?.repo ?? null,
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
  // Una Lambda è un cron se il suo nome lo dice (`<org>-<env>-cron-…`): si decide qui, prima che
  // `nomeBreve` tolga quel `cron-` per la lettura.
  const tutteLambda = delQui
    .filter((s) => s.type === 'lambda')
    .map((s) => ({
      nome: nomeBreve(s.name),
      cron: /^cron-/.test(stripOrgEnv(String(s.name))),
      da: s.checks?.version?.build?.deployedAt ?? null,
      chi: s.checks?.version?.build?.by ?? null,
    }))
  const lambda = tutteLambda.filter((l) => !l.cron)
  const lambdaCron = tutteLambda.filter((l) => l.cron)

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
    lambdaCron: lottiLambda(lambdaCron).map((l) => ({ ...l, tipo: 'lambda', chiave, chi: chiLeggibile(l.chi) })),
    lambdaCronSenzaData: lambdaCron.filter((l) => !l.da).length,
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

// Il nome del repository da un indirizzo (`https://github.com/org/Scraper.git` → `Scraper`). Puro.
const repoNome = (url) => (url ? String(url).replace(/\.git$/, '').split('/').pop() : null)

// Un ambiente diviso nelle schede: la PRINCIPALE, ⏰ CRON e una per ogni squadra. Puro/testabile.
//   squadra    un'applicazione o un'immagine condivisa il cui repository (sorgente della build o repo
//              dell'immagine) è di quella squadra: vince su tutto, perché è la domanda «di chi è»
//   cron       le Lambda col nome da cron e le immagini condivise fatte di soli cron
//   principale tutto il resto, con l'IaC, i componenti esterni e le Lambda dell'infrastruttura
// Ogni parte ha la stessa forma dell'ambiente intero, quindi si rende con le stesse funzioni.
export function dividi(qa, { squadre = {} } = {}) {
  if (!qa) return null
  const vuoto = () => ({ ...qa, app: [], immagini: [], esterni: [], lambda: [], lambdaSenzaData: 0, infra: null })
  const principale = { ...vuoto(), esterni: qa.esterni ?? [], lambda: qa.lambda ?? [], lambdaSenzaData: qa.lambdaSenzaData ?? 0, infra: qa.infra ?? null }
  const cron = { ...vuoto(), lambda: qa.lambdaCron ?? [], lambdaSenzaData: qa.lambdaCronSenzaData ?? 0 }
  const perSquadra = Object.fromEntries(Object.keys(squadre).map((nome) => [nome, vuoto()]))
  const squadraDi = (...nomi) => Object.keys(squadre).find((nome) => nomi.some((n) => n && squadre[nome].includes(String(n).toLowerCase())))
  for (const r of qa.app ?? []) {
    const sq = squadraDi(repoNome(r.repo), r.immagine)
    ;(sq ? perSquadra[sq] : principale).app.push(r)
  }
  for (const g of qa.immagini ?? []) {
    const sq = squadraDi(g.nome)
    if (sq) perSquadra[sq].immagini.push(g)
    else if (!g.servizi.length) cron.immagini.push(g)
    else principale.immagini.push(g)
  }
  return { principale, cron, squadre: perSquadra }
}

// ── La resa ──────────────────────────────────────────────────────────────────────────────────────
//
// Markdown dei canvas: link `[testo](url)`, grassetto `**x**`, tabelle. Una cella non può contenere
// `|` né andare a capo, o la tabella si rompe da quella riga in poi: per questo ogni cella passa da
// `cella`, anche quelle che oggi non ne avrebbero bisogno (un motivo di fallimento sì, e arriva da fuori).

// «4 min», «3 h», «2 g»: abbastanza per capire se un rilascio è appeso o vecchio. Puro.
export function eta(iso, ora = Date.now()) {
  if (!iso) return '?'
  const min = Math.max(0, Math.round((ora - tempo(iso)) / 60_000))
  if (min < 60) return `${min} min`
  const ore = Math.round(min / 60)
  if (ore < 24) return `${ore} h`
  return `${Math.round(ore / 24)} g`
}

// Quando, con l'orario e non «X min fa» (Europe/Rome): «alle 08:10», «ieri alle 18:30», «il 03/10 alle
// 18:30». Un tempo relativo cambia ogni minuto, quindi ogni minuto il canvas andava riscritto, e
// l'app di Slack, ricevendo una modifica a canvas aperto, mostrava la versione vecchia e la nuova una
// sotto l'altra finché non lo si riapriva (visto il 05/10/2026). Un orario resta uguale: il canvas si
// riscrive solo quando cambia qualcosa di vero. Puro.
export function alle(iso, ora = Date.now()) {
  if (!iso) return '?'
  const fmt = (d, o) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', ...o }).format(d)
  const giorno = (d) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const d = new Date(iso)
  const ore = fmt(d, { hour: '2-digit', minute: '2-digit' })
  if (giorno(d) === giorno(new Date(ora))) return `alle ${ore}`
  if (giorno(d) === giorno(new Date(ora - 86_400_000))) return `ieri alle ${ore}`
  return `il ${fmt(d, { day: '2-digit', month: '2-digit' })} alle ${ore}`
}

// «dalle 08:41», «da ieri alle 22:07»: l'inizio di qualcosa in corso, fisso come `alle`. Puro.
export const dalle = (iso, ora = Date.now()) => alle(iso, ora).replace(/^alle /, 'dalle ').replace(/^(ieri|il) /, 'da $1 ')

// La durata di una build: «45 s», «6 min». Puro.
export function durata(ms) {
  if (!(ms > 0)) return null
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`
}

const SEP = ' · '
// Il commit apre la sua pagina su GitHub quando il repository è noto.
const sha = (c, repo) => (c ? (repo ? `[${c}](${repo}/commit/${c})` : `\`${c}\``) : '`?`')
const tronca = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
// Un elenco di nomi lungo si accorcia: i primi, poi quanti altri.
const elenco = (nomi, n = 6) => (nomi.length > n ? `${nomi.slice(0, n).join(', ')} e altri ${nomi.length - n}` : nomi.join(', '))
const plurale = (n, uno, tanti) => `${n} ${n === 1 ? uno : tanti}`
export const cella = (t) => String(t ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')

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
  // Un indirizzo lunghissimo (un giro di cento Lambda) si accorcia alla pagina dell'ambiente: meglio
  // tutto che un filtro tagliato a metà, che mostrerebbe solo una parte senza dirlo.
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

// Una «voce» del quadro: dove va (`adesso` o `recente`), quanto pesa, e le celle della sua riga
// (emoji e nome, stato, dettagli). Puro/testabile.
export function voce(v, { ora = Date.now() } = {}) {
  if (v.tipo === 'app') return voceApp(v, ora)
  if (v.tipo === 'immagine') return voceImmagine(v, ora)
  if (v.tipo === 'lambda')
    // Una Lambda sola si chiama per nome; un giro intero si conta, e i nomi vanno nei dettagli.
    return {
      livello: 'recente',
      gravita: 4,
      quando: v.quando,
      emoji: '⚙️',
      nome: v.n === 1 ? v.nomi[0] : `${v.n} Lambda`,
      stato: `${v.n === 1 ? 'Lambda aggiornata' : 'aggiornate insieme'}${SEP}${alle(v.quando, ora)}`,
      dettagli: [daChi(v.chi), v.n > 1 && elenco(v.nomi)],
    }
  if (v.tipo === 'esterno') {
    const tag = `\`${v.tag}\`${v.nomi.length > 1 ? ` su ${v.nomi.length}` : ''}`
    const base = { quando: v.quando, emoji: '📦', nome: v.nome }
    if (v.giu) return { ...base, livello: 'adesso', gravita: 0, emoji: '🚨', stato: 'giù', dettagli: [tag, 'componente esterno'] }
    if (v.inRollout)
      return { ...base, livello: 'adesso', gravita: 3, emoji: '⏳', stato: 'rollout in corso', dettagli: [tag, 'componente esterno, versione fissata dall’IaC'] }
    // Chi l'ha cambiato si dice solo se non è l'IaC stessa: «fissata dall'IaC, dall'IaC» non informa.
    return { ...base, livello: 'recente', gravita: 4, stato: `${tag}${SEP}${alle(v.quando, ora)}`, dettagli: ['componente esterno, versione fissata dall’IaC', !daIac(v.chi) && daChi(v.chi)] }
  }
  if (v.tipo === 'iac') return voceIac(v, ora)
  return null
}

function voceApp(r, ora) {
  const c = sha(r.commit, r.repo)
  const rev = r.revisione ? `rev ${r.revisione}` : null
  const salute = [r.task && `${r.task} task`, r.target && `${r.target} target sani`].filter(Boolean).join(', ') || null
  const t = r.tentativo
  const base = { nome: r.servizio }
  if (r.stato === 'giu')
    return {
      ...base,
      livello: 'adesso',
      gravita: 0,
      quando: r.quando,
      emoji: '🚨',
      stato: `giù: ${r.task ?? '?'} task attivi`,
      dettagli: [`gira ${c}${rev ? ` (${rev})` : ''}`, r.target && `${r.target} target sani`, r.quando && `ultimo cambio ${alle(r.quando, ora)}`],
    }
  if (r.stato === 'fallito') {
    // Un rosso da solo fa credere il servizio giù: si dice cosa sta ancora girando.
    const gira = r.commit ? `gira ancora ${c}${rev ? ` (${rev})` : ''}` : 'nessun rilascio riuscito visto'
    const motivo = t.motivo && `motivo: ${tronca(t.motivo, 140)}`
    if (t.riavvio)
      return { ...base, livello: 'adesso', gravita: 1, quando: t.da, emoji: '❌', stato: `riavvio a mano fallito ${alle(t.da, ora)}`, dettagli: [daChi(t.chi), motivo, gira] }
    return {
      ...base,
      livello: 'adesso',
      gravita: 1,
      quando: t.da,
      emoji: '❌',
      stato: `build${t.numero ? ` #${t.numero}` : ''} fallita${t.fase ? ` al ${t.fase}` : ''} ${alle(t.da, ora)}`,
      dettagli: [gira, t.commit && `tentava ${sha(t.commit, r.repo)}`, t.chi && `di ${t.chi}`, motivo, t.log && `[log della build](${t.log})`],
    }
  }
  if (r.stato === 'in_corso') {
    if (t) {
      const tipico = durata(r.durataTipica) ? `, di solito ${durata(r.durataTipica)}` : ''
      const verso = t.commit && !stessoCommit(t.commit, r.commit) ? `da ${c} a ${sha(t.commit, r.repo)}` : `commit ${sha(t.commit ?? r.commit, r.repo)}`
      return {
        ...base,
        livello: 'adesso',
        gravita: 3,
        quando: t.da,
        emoji: '⏳',
        stato: `build${t.numero ? ` #${t.numero}` : ''} in corso ${dalle(t.da, ora)}${tipico}`,
        dettagli: [t.fase && `fase ${t.fase}`, verso, t.chi && `di ${t.chi}`, salute],
      }
    }
    return { ...base, livello: 'adesso', gravita: 3, quando: r.quando, emoji: '⏳', stato: 'rollout in corso', dettagli: [`${c}${rev ? ` (${rev})` : ''}`, salute, comeTesto(r.come)] }
  }
  return {
    ...base,
    livello: 'recente',
    gravita: 4,
    quando: r.quando,
    emoji: '🚀',
    stato: `${c}${SEP}${alle(r.quando, ora)}`,
    dettagli: [rev, salute, comeTesto(r.come), r.autore && `commit di ${r.autore}`, r.staging && `staging su \`${r.staging}\``],
  }
}

function voceImmagine(g, ora) {
  const quanti = [g.servizi.length && plurale(g.servizi.length, 'servizio', 'servizi'), g.cron.length && `${g.cron.length} cron`].filter(Boolean).join(' e ')
  const tutti = [...g.servizi, ...g.cron]
  const base = { nome: g.nome, quando: g.quando }
  if (g.giu.length) return { ...base, livello: 'adesso', gravita: 0, emoji: '🚨', stato: `giù: ${elenco(g.giu, 4)}`, dettagli: [`immagine \`${g.tag}\` su ${quanti}`] }
  if (g.indietro.length)
    return {
      ...base,
      livello: 'adesso',
      gravita: 2,
      emoji: '⚠️',
      stato: `${g.indietro.length} di ${tutti.length} su un’immagine più vecchia`,
      dettagli: [g.indietro.map((x) => `${x.nome} su \`${x.tag ?? '?'}\``).join(', '), `gli altri su \`${g.tag}\`, aggiornati ${alle(g.quando, ora)}`],
    }
  if (g.inRollout) return { ...base, livello: 'adesso', gravita: 3, emoji: '⏳', stato: 'rollout in corso', dettagli: [`immagine \`${g.tag}\` su ${quanti}`] }
  return { ...base, livello: 'recente', gravita: 4, emoji: '🔄', stato: `\`${g.tag}\` su ${quanti}${SEP}${alle(g.quando, ora)}`, dettagli: [g.chi && `registrata ${daChi(g.chi)}`, elenco(tutti)] }
}

function voceIac(i, ora) {
  const c = `commit ${sha(i.commit, i.repo)}`
  const build = i.numero ? `build #${i.numero}` : null
  const base = { nome: 'IaC', quando: i.quando }
  if (i.stato === 'in_corso') {
    const tipico = durata(i.durataTipica) ? `, di solito ${durata(i.durataTipica)}` : ''
    return { ...base, livello: 'adesso', gravita: 3, emoji: '⏳', stato: `apply in corso ${dalle(i.quando, ora)}${tipico}`, dettagli: [c, build, i.fase && `fase ${i.fase}`, i.chi && `di ${i.chi}`] }
  }
  if (i.stato === 'fallito')
    return {
      ...base,
      livello: 'adesso',
      gravita: 1,
      emoji: '❌',
      stato: `apply fallito${i.fase ? ` al ${i.fase}` : ''} ${alle(i.quando, ora)}`,
      dettagli: [c, build, i.chi && `di ${i.chi}`, i.motivo && `motivo: ${tronca(i.motivo, 140)}`, i.log && `[log della build](${i.log})`],
    }
  return { ...base, livello: 'recente', gravita: 4, emoji: '🏗️', stato: `apply riuscito${SEP}${alle(i.quando, ora)}`, dettagli: [c, build && `${build}${durata(i.durataMs) ? ` in ${durata(i.durataMs)}` : ''}`, i.chi && `di ${i.chi}`] }
}

// Ogni risorsa diventa una voce, e la voce finisce in uno dei tre piani: «adesso», recente, o il
// conteggio del resto. Più la sintesi, che è la riga che si legge per prima. Puro/testabile.
export function smista(q, { ora = Date.now(), url = null, ore = DEFAULT_ORE } = {}) {
  const { app = [], immagini = [], esterni = [], lambda = [], lambdaSenzaData = 0, infra = null, buildIgnote = false } = q
  const soglia = ora - ore * 3_600_000
  const adesso = []
  const recenti = []
  const resto = { app: 0, immagini: 0, lambda: lambdaSenzaData, esterni: 0, iac: null }
  const metti = (v, chiaveResto, peso = 1) => {
    const x = voce(v, { ora })
    if (!x) return
    const conLink = { ...x, link: linkRisorsa(v, url) }
    if (x.livello === 'adesso') adesso.push(conLink)
    else if (x.quando && tempo(x.quando) >= soglia) recenti.push(conLink)
    else if (chiaveResto === 'iac') resto.iac = v.quando
    else resto[chiaveResto] += peso
  }
  app.forEach((r) => metti(r, 'app'))
  immagini.forEach((g) => metti(g, 'immagini'))
  esterni.forEach((e) => metti(e, 'esterni'))
  lambda.forEach((l) => metti(l, 'lambda', l.n))
  if (infra) metti(infra, 'iac')
  adesso.sort((a, b) => a.gravita - b.gravita || piuRecente(a.quando, b.quando))
  recenti.sort((a, b) => piuRecente(a.quando, b.quando))

  // Tre conti, ognuno col suo segno: rotto (giù o fallito), da guardare (rimasto indietro), in corso.
  // Un solo «🔴 da guardare» metteva il rosso anche su un cron con l'immagine vecchia.
  // ❌ e non 🔴 per il rotto: accanto al 🟥 della produzione un cerchio rosso si confondeva col titolo.
  const rotti = adesso.filter((x) => x.gravita <= 1).length
  const avvisi = adesso.filter((x) => x.gravita === 2).length
  const inCorso = adesso.length - rotti - avvisi
  const diversi = app.filter((r) => r.staging)
  const pezzi = [
    rotti && `❌ ${plurale(rotti, 'rotto', 'rotti')}`,
    avvisi && `⚠️ ${avvisi} da guardare`,
    inCorso && `⏳ ${inCorso} in corso`,
    `🚀 ${plurale(recenti.length, 'rilascio', 'rilasci')} nelle ultime ${ore} h`,
    diversi.length && `${diversi.length} su un commit diverso da staging`,
    buildIgnote && '⚠️ build non lette',
  ].filter(Boolean)
  // «Niente di rotto» si dice solo se lo sappiamo: con le build non lette un fallimento non si vede.
  const sintesi = adesso.length || buildIgnote ? pezzi : ['✅ niente di rotto, niente in corso', ...pezzi]
  return { adesso, recenti, resto, sintesi, diversi }
}

// Le sezioni di un ambiente: la tabella, il resto contato e i link. La sintesi la restituisce a parte,
// perché il canvas di un ambiente la mette in testa e uno trasversale sotto il titolo della sezione.
// Puro.
//
// Le scelte di leggibilità, per chi lo apre dal telefono in mezzo ad altro: prima i problemi, poi i
// rilasci dal più nuovo, in fondo il resto contato. Tre colonne e non cinque: l'emoji sta accanto al
// nome, e il nome È il link a Dadaguard, già filtrato sulla risorsa.
function sezioniAmbiente(q, { ora = Date.now(), url = null, ore = DEFAULT_ORE } = {}) {
  const meta = AMBIENTI[q.ambiente] ?? { titolo: `Quadro deploy ${String(q.ambiente).toUpperCase()}`, tag: String(q.ambiente).toUpperCase(), sezione: String(q.ambiente) }
  const { adesso, recenti, resto, sintesi, diversi } = smista(q, { ora, url, ore })
  const tuttiDeploy = url && q.chiave ? `${url}/deploy?account=${encodeURIComponent(q.chiave)}` : null
  const tuttiServizi = url && q.chiave ? `${url}/servizi?account=${encodeURIComponent(q.chiave)}` : null

  const riga = (x) => {
    const nome = x.link ? `[**${x.nome}**](${x.link})` : `**${x.nome}**`
    return `| ${x.emoji} ${cella(nome)} | ${cella(x.stato)} | ${cella(x.dettagli.filter(Boolean).join(SEP))} |`
  }
  const tabella = (voci) => ['| Risorsa | Stato | Dettagli |', '|---|---|---|', ...voci.map(riga)].join('\n')
  const oltre = (n, link) => `E ${n === 1 ? 'un altro' : `altri ${n}`}${link ? `: [tutti su Dadaguard](${link})` : ''}.`

  // UNA tabella per ambiente: prima quello da guardare (rotto, giù, indietro, in corso), poi i rilasci
  // dal più nuovo. Due tabelle, «Adesso» e «Ultime N ore», Slack le dimensionava ognuna sul suo
  // contenuto, con larghezze e rientri diversi, e i due sottotitoli in più facevano sembrare il canvas
  // disordinato (visto il 05/10/2026). L'ordine e l'emoji in testa alla riga dicono già quale è quale.
  const parti = []
  if (q.buildIgnote)
    parti.push(`⚠️ **Build non lette**${q.erroreBuild ? `: ${cella(tronca(q.erroreBuild, 200))}` : ''}. Quello che gira lo dice ECS, ma commit, autori e build in corso o fallite mancano finché non tornano leggibili.`)
  const righe = [...adesso.slice(0, MAX_ADESSO), ...recenti.slice(0, MAX_RECENTI)]
  // Senza righe niente tabella: la sintesi dice già «niente in corso» e «0 rilasci».
  if (righe.length) parti.push(tabella(righe))
  const mancano = Math.max(0, adesso.length - MAX_ADESSO) + Math.max(0, recenti.length - MAX_RECENTI)
  if (mancano) parti.push(oltre(mancano, tuttiDeploy))

  const fermi = [
    resto.app && plurale(resto.app, 'applicazione', 'applicazioni'),
    resto.lambda && `${resto.lambda} Lambda`,
    resto.immagini && plurale(resto.immagini, 'immagine condivisa', 'immagini condivise'),
    resto.esterni && plurale(resto.esterni, 'componente esterno', 'componenti esterni'),
    resto.iac && `IaC, ultimo apply ${alle(resto.iac, ora)}`,
  ].filter(Boolean)

  // I filtri: link alla pagina di Dadaguard già filtrata. Quello sui servizi diversi da staging apre i
  // deploy di quei servizi nei due ambienti insieme, cioè il confronto che serve.
  const link = [
    tuttiDeploy && `[Deploy ${meta.tag}](${tuttiDeploy})`,
    tuttiServizi && `[Servizi ${meta.tag}](${tuttiServizi})`,
    url && diversi.length && `[${diversi.length} diversi da staging](${url}/deploy?service=${encodeURIComponent(diversi.map((r) => r.servizio).join(','))})`,
  ].filter(Boolean)
  // Una riga sola in fondo, uguale in ogni scheda: il resto contato e i link. Due paragrafi separati
  // allungavano ogni sezione di una riga, e nelle schede a due ambienti si leggevano come un elenco.
  const fondo = [fermi.length && `**Senza novità** (${ore} h): ${fermi.join(SEP)}`, link.length && `Dadaguard: ${link.join(SEP)}`].filter(Boolean)
  if (fondo.length) parti.push(fondo.join('  |  '))
  return { meta, sintesi, parti }
}

// Ogni scheda ha la STESSA forma, che contenga un ambiente (🟥 PROD, 🟨 STAGING) o tutti e due (⏰ CRON,
// una squadra): per ogni ambiente il suo titolo, la sintesi, la tabella e una riga in fondo. Due forme
// diverse per le schede a uno e a due ambienti obbligavano a reimparare il canvas a ogni scheda.
// Niente «aggiornato alle»: cambierebbe ogni minuto e riscriverebbe il canvas per niente (vedi
// `alle`); che il quadro sia vivo lo garantisce la guardia dei 10 minuti. Puro/testabile.
export function canvasSezioni(titolo, perAmbiente = [], { ora = Date.now(), url = null, ore = DEFAULT_ORE } = {}) {
  const parti = []
  const sintesi = []
  for (const q of perAmbiente) {
    const s = sezioniAmbiente(q, { ora, url, ore })
    parti.push(`## ${s.meta.sezione}`, `**${s.sintesi.join(SEP)}**`, ...s.parti)
    sintesi.push(perAmbiente.length > 1 ? `${s.meta.tag}: ${s.sintesi.join(SEP)}` : s.sintesi.join(SEP))
  }
  return { titolo, markdown: parti.join('\n\n'), sintesi: sintesi.join(' | ') }
}

// La scheda di un ambiente. Puro/testabile.
export function canvasQuadro(q, opts = {}) {
  const meta = AMBIENTI[q.ambiente] ?? { titolo: `Quadro deploy ${String(q.ambiente).toUpperCase()}` }
  return canvasSezioni(meta.titolo, [q], opts)
}

// La scheda che attraversa gli ambienti (⏰ CRON, una squadra). Puro/testabile.
export const canvasTrasversale = (titolo, perAmbiente = [], opts = {}) => canvasSezioni(titolo, perAmbiente, opts)

// Tutti i canvas di un giro, ognuno col suo canale: uno per ambiente, poi ⏰ CRON e uno per squadra.
// Le schede trasversali vanno nel canale del PRIMO ambiente: sono una sola per tutti e due, e quando
// i due ambienti hanno lo stesso canale stanno accanto alle loro. Puro/testabile.
export function canvasDaScrivere(q, cfg, { ora = Date.now() } = {}) {
  const opts = { ora, url: cfg.publicUrl ?? null, ore: cfg.ore ?? DEFAULT_ORE }
  const parti = Object.fromEntries(cfg.ambienti.map((a) => [a, dividi(q[a], { squadre: cfg.squadre ?? {} })]))
  const presenti = cfg.ambienti.filter((a) => parti[a])
  const out = presenti.map((a) => ({ chiave: a, canale: cfg.canali?.[a] ?? null, ...canvasQuadro(parti[a].principale, opts) }))
  const canaleTrasversale = cfg.canali?.[cfg.ambienti.find((a) => cfg.canali?.[a])] ?? null
  const trasversale = (chiave, titolo, scegli) => ({ chiave, canale: canaleTrasversale, ...canvasTrasversale(titolo, presenti.map((a) => scegli(parti[a])), opts) })
  out.push(trasversale('cron', TITOLO_CRON, (p) => p.cron))
  for (const sq of Object.keys(cfg.squadre ?? {})) out.push(trasversale(sq, titoloSquadra(sq), (p) => p.squadre[sq]))
  return out
}

// ── La parte che parla con Slack ──────────────────────────────────────────────────────────────────

// I metodi di sola lettura vogliono i parametri nell'indirizzo, gli altri accettano JSON.
const GET = new Set(['auth.test', 'conversations.info'])

// Una chiamata alla Web API, senza SDK (come `postSlack`). Slack risponde 200 anche sugli errori, col
// motivo in `error`: si controlla `ok`, non lo status HTTP.
export async function chiamaSlack(metodo, corpo, token, { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const get = GET.has(metodo)
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

// Il NOSTRO canvas fra quelli del canale. Puro/testabile.
//
// ⚠️ Non sta in `properties.canvas`, che resta vuoto: i canvas di un canale sono SCHEDE
// (`properties.tabs`, tipo `canvas`), un canale ne può avere più d'una, e crearne un'altra non dà errore.
// Cercandolo in `properties.canvas`, il 04/10/2026 il primo giro di prova ne ha creato uno e il secondo
// un altro, accanto: senza fermarlo sarebbe stato un canvas nuovo al minuto.
// Il nostro si riconosce dal titolo, che Slack ricopia nell'etichetta della scheda con l'emoji scritta
// come codice (`:large_red_square: Quadro deploy PRODUZIONE`): si confronta il testo, con o senza
// l'emoji davanti. Se ce n'è più d'uno vince il più recente, e gli altri si dicono, non si cancellano.
export function canvasDelCanale(info, titolo) {
  const testo = String(titolo ?? '').replace(/^\S+\s+/u, '')
  const esatto = new RegExp(`^(?::[a-z0-9_+-]+:|\\p{Extended_Pictographic}\\uFE0F?)?\\s*${testo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'u')
  const nostri = (info?.channel?.properties?.tabs ?? [])
    .filter((t) => t?.type === 'canvas' && t.data?.file_id && esatto.test(String(t.label ?? '').trim()))
    .sort((a, b) => Number(b.data.shared_ts ?? 0) - Number(a.data.shared_ts ?? 0))
  return { id: nostri[0]?.data.file_id ?? null, doppioni: nostri.slice(1).map((t) => t.data.file_id) }
}

// Un giro: per ogni ambiente col suo canale, riscrive il canvas del canale, o lo crea se non c'è.
// `deps` per le prove: `leggiDati` ({ deploys, servizi }) e `api` (la Web API).
// Un ambiente che fallisce non ferma l'altro: sono due canali, e il guasto di uno non è una ragione
// per lasciare vecchio il quadro dell'altro.
export async function aggiornaQuadri(cfg, deps = {}) {
  const api = deps.api ?? ((m, c) => chiamaSlack(m, c, cfg.token))
  const dati = await deps.leggiDati()
  const q = quadro({ ...dati, persone: deps.persone ?? null }, cfg.ambienti)
  const ora = deps.ora ?? Date.now()
  // Le schede di un canale si chiedono una volta per giro: i canvas sono più d'uno nello stesso canale.
  const infoDi = new Map()
  const info = async (canale) => {
    if (!infoDi.has(canale)) infoDi.set(canale, await api('conversations.info', { channel: canale }))
    return infoDi.get(canale)
  }
  // L'ultimo markdown scritto per ogni canvas: uguale vuol dire niente da riscrivere. Con un giro ogni
  // 15 secondi riscrivere sempre sarebbero 16 modifiche al minuto per niente, e Slack ne regge ~50.
  const ultimi = deps.ultimi ?? new Map()
  const esiti = []
  for (const c of canvasDaScrivere(q, cfg, { ora })) {
    if (!c.canale) continue
    // Gli allarmi dipendono dai DATI di un ambiente, non dal canvas: si calcolano prima, così un
    // canvas che non si riesce a scrivere non tace anche un servizio giù.
    const allarmi = AMBIENTI[c.chiave] ? { allarmi: datiAllarmi(q[c.chiave], { ora, url: cfg.publicUrl, ore: cfg.ore }) } : {}
    try {
      const document_content = { type: 'markdown', markdown: c.markdown }
      const { id, doppioni } = canvasDelCanale(await info(c.canale), c.titolo)
      if (doppioni.length) log.warn('quadro: il canale ha più canvas con lo stesso titolo, riscrivo il più recente', { canvas: c.chiave, doppioni })
      if (id && ultimi.get(id) === c.markdown) {
        esiti.push({ ambiente: c.chiave, azione: 'invariato', canvas: id, ...allarmi })
      } else if (id) {
        // `replace` senza sezione riscrive il canvas intero: è un quadro, non un documento da integrare.
        await api('canvases.edit', { canvas_id: id, changes: [{ operation: 'replace', document_content }] })
        ultimi.set(id, c.markdown)
        esiti.push({ ambiente: c.chiave, azione: 'riscritto', canvas: id, ...allarmi })
      } else {
        const r = await api('conversations.canvases.create', { channel_id: c.canale, title: c.titolo, document_content })
        // In sola lettura per il canale: una modifica a mano sparirebbe al giro dopo, senza dirlo a chi
        // l'ha fatta. Se non riesce il quadro funziona lo stesso, quindi lo si dice e si va avanti.
        await api('canvases.access.set', { canvas_id: r.canvas_id, access_level: 'read', channel_ids: [c.canale] }).catch((err) =>
          log.warn('quadro: canvas non messo in sola lettura', { canvas: c.chiave, err: err.message }),
        )
        ultimi.set(r.canvas_id, c.markdown)
        esiti.push({ ambiente: c.chiave, azione: 'creato', canvas: r.canvas_id, ...allarmi })
      }
    } catch (err) {
      esiti.push({ ambiente: c.chiave, azione: 'errore', errore: err.message, ...allarmi })
    }
  }
  return esiti
}

// ── Gli allarmi nel canale ───────────────────────────────────────────────────────────────────────
//
// Il canvas è muto; un fallimento no. Quando una risorsa si ROMPE (gravità 0 o 1: giù, build o apply
// fallito, riavvio fallito) il bot scrive un messaggio nel canale dell'ambiente; se si rompe di nuovo
// mentre è ancora aperto, lo dice nella discussione di quel messaggio; quando torna a posto risponde
// ✅ nella discussione e cambia il messaggio in ✅, così il canale mostra a colpo d'occhio cosa è
// ancora aperto. Un allarme per RISORSA, non per evento: tre build fallite di fila sono una storia
// sola, non tre messaggi.
//
// ⚠️ Gli allarmi aperti stanno in memoria, come lo stato del watchdog: a un riavvio di Dadaguard il
// primo giro prende nota di cosa è rotto senza scriverlo (meglio perdere un messaggio che ripetere
// tutti i rossi a ogni rilascio di Dadaguard), e un allarme aperto prima del riavvio non riceve il ✅.

// Il messaggio mrkdwn di Slack, dalle celle markdown del canvas. Puro.
const aMrkdwn = (t) => String(t ?? '').replace(/\*\*([^*]+)\*\*/g, '*$1*').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>')

// La riga dell'allarme, con la grammatica del canale dei rilasci: emoji, nome fra backtick, ambiente
// fra quadre, poi cosa è successo e i dettagli. Puro/testabile.
export function testoAllarme(x, ambiente) {
  const tag = AMBIENTI[ambiente]?.tag ?? String(ambiente).toUpperCase()
  const dettagli = x.dettagli.filter(Boolean).map(aMrkdwn).join(SEP)
  const link = x.link ? `${SEP}<${x.link}|Dadaguard>` : ''
  return `${x.emoji} \`${x.nome}\` [${tag}] ${aMrkdwn(x.stato)}${dettagli ? `${SEP}${dettagli}` : ''}${link}`
}

// Cosa serve agli allarmi di un ambiente: le risorse rotte (con la loro firma), quelle in corso, e se
// le build si sono lette. La FIRMA cambia solo con un guasto nuovo (un'altra build fallita, un altro
// rilascio giù): non con l'orologio, o ogni giro sembrerebbe un guasto nuovo. Puro.
export function datiAllarmi(qa, { ora = Date.now(), url = null, ore = DEFAULT_ORE } = {}) {
  if (!qa) return null
  const { adesso } = smista(qa, { ora, url, ore })
  return {
    rotti: adesso.filter((x) => x.gravita <= 1).map((x) => ({ nome: x.nome, firma: `${x.emoji}|${x.quando ?? ''}`, testo: testoAllarme(x, qa.ambiente) })),
    inCorso: adesso.filter((x) => x.gravita === 3).map((x) => x.nome),
    buildIgnote: Boolean(qa.buildIgnote),
  }
}

// Cosa dire nel canale, confrontando gli allarmi aperti con quello che è rotto adesso. Puro/testabile.
//   apri    una risorsa rotta che non lo era
//   ancora  una risorsa già aperta che si è rotta di nuovo (firma diversa)
//   chiudi  una risorsa aperta che non è più rotta, e non è in corso: un rilascio che riparte dopo un
//           fallimento non ha ancora riparato niente, e un ✅ prima dell'esito sarebbe una promessa
// Con le build non lette non si chiude niente: un fallimento che non si vede non è un fallimento finito.
export function pianoAllarmi(aperti = {}, dati = null, { primoGiro = false } = {}) {
  if (!dati) return { azioni: [], aperti }
  const azioni = []
  const nuovi = { ...aperti }
  const rottiOra = new Set(dati.rotti.map((r) => r.nome))
  for (const r of dati.rotti) {
    const a = aperti[r.nome]
    if (!a) {
      nuovi[r.nome] = { ts: null, testo: r.testo, firma: r.firma }
      if (!primoGiro) azioni.push({ tipo: 'apri', nome: r.nome, testo: r.testo })
    } else if (a.firma !== r.firma) {
      nuovi[r.nome] = { ...a, firma: r.firma }
      azioni.push({ tipo: 'ancora', nome: r.nome, testo: r.testo, ts: a.ts })
    }
  }
  for (const [nome, a] of Object.entries(aperti)) {
    if (rottiOra.has(nome) || dati.inCorso.includes(nome) || dati.buildIgnote) continue
    delete nuovi[nome]
    azioni.push({ tipo: 'chiudi', nome, testo: a.testo, ts: a.ts })
  }
  return { azioni, aperti: nuovi }
}

// Esegue il piano nel canale e restituisce gli allarmi aperti aggiornati (col `ts` dei messaggi nuovi).
// Un «apri» che non parte non resta aperto senza messaggio: si toglie, e il giro dopo riprova.
export async function eseguiAllarmi(api, canale, piano, { ora = Date.now() } = {}) {
  const aperti = { ...piano.aperti }
  const senzaAnteprime = { unfurl_links: false, unfurl_media: false }
  for (const z of piano.azioni) {
    try {
      if (z.tipo === 'apri') {
        const r = await api('chat.postMessage', { channel: canale, text: z.testo, ...senzaAnteprime })
        aperti[z.nome] = { ...aperti[z.nome], ts: r.ts }
      } else if (z.tipo === 'ancora' && z.ts) {
        await api('chat.postMessage', { channel: canale, thread_ts: z.ts, text: z.testo, ...senzaAnteprime })
      } else if (z.tipo === 'chiudi' && z.ts) {
        const quando = new Date(ora).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
        await api('chat.postMessage', { channel: canale, thread_ts: z.ts, text: `✅ risolto alle ${quando}`, ...senzaAnteprime })
        await api('chat.update', { channel: canale, ts: z.ts, text: `✅ ${z.testo.replace(/^\S+\s+/u, '')}${SEP}risolto alle ${quando}` })
      }
    } catch (err) {
      log.error('quadro: allarme non scritto', { canale, azione: z.tipo, risorsa: z.nome, err: err.message })
      if (z.tipo === 'apri') delete aperti[z.nome]
    }
  }
  return aperti
}

// ── La guardia del quadro ────────────────────────────────────────────────────────────────────────
//
// Un quadro fermo è peggio di nessun quadro: dice «niente di rotto» con l'ora di ieri, e l'unico
// segno è un orario che nessuno confronta con l'orologio. Quindi se un ambiente non si aggiorna da
// `sogliaMs` lo si dice UNA volta, e una volta quando torna. Pura/testabile: entra lo stato di prima
// e gli esiti del giro, escono lo stato nuovo e gli avvisi da mandare.
//
// ⚠️ Copre il quadro che gira e fallisce (Slack che risponde errore, AWS che non si legge), non
// Dadaguard spento: un processo morto non avvisa di niente, e lì serve un controllo da fuori.
const SOGLIA_FERMO_MS = 10 * 60_000

export function guardiaQuadro(stato = {}, esiti = [], { ora = Date.now(), avvio = ora, sogliaMs = SOGLIA_FERMO_MS } = {}) {
  const nuovo = { ...stato }
  const avvisi = []
  for (const e of esiti) {
    // Il riferimento di un ambiente mai riuscito è l'avvio: un quadro che non parte mai avvisa lo stesso.
    const s = { ultimoOk: avvio, avvisato: false, ...(nuovo[e.ambiente] ?? {}) }
    if (e.azione !== 'errore') {
      if (s.avvisato) avvisi.push({ ambiente: e.ambiente, tipo: 'rientrato', fermoDa: s.ultimoOk })
      nuovo[e.ambiente] = { ultimoOk: ora, avvisato: false }
      continue
    }
    const avvisa = !s.avvisato && ora - tempo(s.ultimoOk) >= sogliaMs
    if (avvisa) avvisi.push({ ambiente: e.ambiente, tipo: 'fermo', fermoDa: s.ultimoOk, errore: e.errore ?? null })
    nuovo[e.ambiente] = { ...s, avvisato: s.avvisato || avvisa }
  }
  return { stato: nuovo, avvisi }
}

// La riga per il canale degli allarmi, con la grammatica del canale: emoji, nome fra backtick,
// ambiente fra quadre, esito in maiuscolo. Puro/testabile.
export function testoAvviso(a, { ora = Date.now(), url = null } = {}) {
  const tag = AMBIENTI[a.ambiente]?.tag ?? String(a.ambiente).toUpperCase()
  if (a.tipo === 'rientrato') return `✅ \`quadro deploy\` [${tag}] rientrato · di nuovo aggiornato dopo ${eta(a.fermoDa, ora)} fermo`
  const link = url ? `${SEP}<${url}/deploy|deploy su Dadaguard>` : ''
  return `⚠️ \`quadro deploy\` [${tag}] FERMO · il canvas non si aggiorna da ${eta(a.fermoDa, ora)}${SEP}ultimo errore: ${tronca(a.errore ?? 'sconosciuto', 200)}${link}`
}

export function startQuadro(leggiDati, env = process.env) {
  const cfg = quadroConfig(env)
  if (!cfg.token || !Object.keys(cfg.canali).length) {
    log.info('quadro: nessun DADAGUARD_SLACK_BOT_TOKEN o DADAGUARD_QUADRO_CANALI, quadro spento')
    return null
  }
  log.info('quadro: attivo', { ogni: `${cfg.intervalMs / 1000}s`, canali: cfg.canali })
  const webhook = env.DADAGUARD_SLACK_WEBHOOK || null
  const avvio = Date.now()
  let guardia = {}
  const allarmi = {} // ambiente → allarmi aperti
  const visti = new Set() // ambienti che hanno già avuto un giro con i dati: il primo prende nota e basta
  const api = (m, c) => chiamaSlack(m, c, cfg.token)
  const ultimi = new Map() // canvas → ultimo markdown scritto
  // Un giro alla volta. Il primo, a cache fredde, dura più dell'intervallo (26 secondi misurati contro
  // 15): due giri insieme cercherebbero lo stesso canvas, non lo troverebbero tutti e due e ne
  // creerebbero due, cioè il doppione che il giro di prova del 04/10/2026 ha già fatto una volta.
  let inCorso = false
  const giro = () =>
    // `people` si rilegge a ogni giro, come la config del resto: un alias aggiunto vale dal giro dopo.
    aggiornaQuadri(cfg, { leggiDati, persone: loadConfig().people ?? null, ultimi })
      // Un giro che muore prima dei canali (AWS che non si legge) è un errore per OGNI ambiente: per
      // la guardia conta quanto è vecchio il canvas, non dove si è rotto il giro.
      .catch((err) => {
        log.error('quadro: giro fallito', { err: err.message })
        return Object.keys(cfg.canali).map((ambiente) => ({ ambiente, azione: 'errore', errore: err.message }))
      })
      .then(async (esiti) => {
        const errori = esiti.filter((e) => e.azione === 'errore')
        if (errori.length) log.error('quadro: giro con errori', { errori: errori.map((e) => `${e.ambiente}: ${e.errore}`) })
        // Ogni 15 secondi un log per giro sarebbero 5.760 righe al giorno: si scrive solo se qualcosa è cambiato.
        if (esiti.some((e) => e.azione !== 'invariato')) log.info('quadro: giro', { esiti: esiti.map((e) => `${e.ambiente}:${e.azione}`) })
        const g = guardiaQuadro(guardia, esiti, { avvio })
        guardia = g.stato
        for (const a of g.avvisi) {
          const testo = testoAvviso(a, { url: cfg.publicUrl })
          log.warn('quadro: avviso', { testo })
          // Un avviso «fermo» non partito si riprova al giro dopo: si torna a «non avvisato».
          if (webhook && !(await postSlack(webhook, { text: testo })) && a.tipo === 'fermo') guardia[a.ambiente].avvisato = false
        }
        for (const e of esiti) {
          // Senza dati (il giro è morto prima) non si apre e non si chiude niente.
          if (!e.allarmi) continue
          const piano = pianoAllarmi(allarmi[e.ambiente] ?? {}, e.allarmi, { primoGiro: !visti.has(e.ambiente) })
          visti.add(e.ambiente)
          if (piano.azioni.length) log.info('quadro: allarmi', { ambiente: e.ambiente, azioni: piano.azioni.map((z) => `${z.tipo}:${z.nome}`) })
          allarmi[e.ambiente] = await eseguiAllarmi(api, cfg.canali[e.ambiente], piano)
        }
      })
      .catch((err) => log.error('quadro: guardia fallita', { err: err.message }))
  const tick = () => {
    if (inCorso) return
    inCorso = true
    giro().finally(() => {
      inCorso = false
    })
  }
  tick()
  const timer = setInterval(tick, cfg.intervalMs)
  timer.unref?.()
  return timer
}
