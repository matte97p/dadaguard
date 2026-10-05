import { log } from '../log.js'
import { ambienteDi } from '../rilasci.js'
import { canonicalActor } from '../util/principal.js'
import { stripOrgEnv } from '../util/envToken.js'
import { loadConfig } from '../config.js'
import { postSlack } from './slack.js'
import { applicaTest, githubConfig, nuovoGithub, repoDelQuadro } from './github.js'

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
// ⚠️ La tabella ha TUTTE le risorse che si rilasciano, in ordine alfabetico, sempre le stesse righe
// nello stesso ordine: è la forma che permette di aggiornare il canvas cella per cella. Fino al
// 05/10/2026 il quadro mostrava solo le novità (prima i problemi, poi i rilasci delle ultime 24 ore,
// il resto contato) e si riscriveva intero a ogni cambio; l'app di Slack, ricevendo un `replace` del
// documento intero a canvas APERTO, lo mostrava DOPPIO, il vecchio sopra e il nuovo sotto, finché non
// lo si riapriva (provato quel giorno in un canale di prova). Riscrivendo una cella per volta, per id,
// il canvas aperto resta pulito. Ma una cella si riscrive solo se la riga è ancora quella: con righe
// che entrano ed escono a ogni rilascio gli id non servirebbero a niente. Quindi:
//   la riga di una risorsa non si sposta mai, e cambiano solo le sue celle
//   la prima colonna (il nome) non si riscrive MAI: un `replace` su quella cella attacca il testo in
//   fondo al canvas invece di sostituirlo (provato il 05/10/2026, «frontend» finito sotto la tabella)
//   il canvas intero si riscrive solo quando cambiano le righe (una risorsa nuova o sparita) o quando
//   quello che si legge non torna con quello che ci si aspetta: è raro, e lì lo sdoppio si accetta
// Accanto al canvas c'è una Slack LIST per ambiente con le stesse righe (vedi `sincronizzaLista`): si
// filtra e si ordina, e chi la preferisce la usa. Le due viste dicono la stessa cosa, con gli stessi
// stati (`STATI`).
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
//   ⏳ 🚀 deploy dei cron Lambda                  una riga per Lambda; la sintesi conta i giri, dedotti
//                                                 da ora e autore
//   ⏳ 🚀 ➖ apply dell'infrastruttura             riga IaC
//   🧪 test avviati, 🔴 check rossi               🧪 test avviati, ❌ test falliti: i run di GitHub
//                                                 Actions, letti con una GitHub App (server/notify/github.js)
//
// ⚠️ Riscrivere un canvas non manda notifiche: è il suo pregio (niente rumore) e il suo limite. Per
// questo quando qualcosa si ROMPE (build o apply fallito, servizio giù) il bot scrive anche un
// messaggio nel canale, e lo chiude con ✅ quando torna a posto (vedi `pianoAllarmi`): se va tutto bene
// il canale resta muto, se qualcosa si rompe chi segue il canale lo sa.
//
// Zero storage, come il resto: il canvas da riscrivere non si ricorda, si cerca fra le schede del
// canale (vedi `canvasDelCanale`), e le sue celle si leggono dal canvas stesso (vedi `pianoCelle`). La
// List si ritrova dal titolo fra i file del bot (vedi `ritrovaLista`). Se non c'è, si crea.
//
// Configurazione (tutta opzionale: senza token o canali il quadro non parte e non chiama niente):
//   DADAGUARD_SLACK_BOT_TOKEN   token `xoxb-` di un'app Slack con i permessi elencati in
//                               deploy/slack-app-manifest.yml (uno per chiamata), invitata nei
//                               canali. Un webhook NON basta: non scrive canvas e non modifica i
//                               messaggi che ha mandato
//   DADAGUARD_QUADRO_LISTE      `0` per non tenere la Slack List accanto al canvas (default: accesa)
//   DADAGUARD_GITHUB_*          la GitHub App da cui viene lo stato dei test (vedi server/notify/github.js).
//                               Senza, le righe non hanno mai uno stato di test
//   DADAGUARD_QUADRO_CANALI     un canale per ambiente, nell'ordine dei giri:
//                               `produzione=C0123,staging=C0456`. Gli id, non i nomi
//   DADAGUARD_QUADRO_INTERVAL   secondi fra i giri (default 15, minimo 10). Slack regge ~50 modifiche
//                               di canvas al minuto: il giro scrive solo le celle che cambiano, e al
//                               massimo `MAX_MODIFICHE_GIRO` per giro
//   DADAGUARD_QUADRO_ORE        per quante ore un rilascio resta 🚀 prima di diventare ➖ (default 24)
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
// Le celle riscritte in un giro, in tutti i canvas insieme: `canvases.edit` accetta una modifica per
// chiamata, e un giro di venti Lambda rilasciate insieme sono quaranta celle. Con 10 ogni 15 secondi
// si sta sotto le ~50 modifiche al minuto che Slack regge; quello che avanza va al giro dopo.
export const MAX_MODIFICHE_GIRO = 10
// Le righe nuove della List create in un giro: `slackLists.items.create` ne crea una per chiamata, e
// la prima volta sono tutte nuove.
export const MAX_RIGHE_NUOVE_GIRO = 20
// Le Lambda aggiornate dalla stessa persona a meno di questo l'una dall'altra sono un giro solo: un
// workflow dei cron ne rilascia una ventina in un paio di minuti.
const FINESTRA_LOTTO_MS = 15 * 60_000
// Una revisione ECS registrata oltre questo dopo la fine della build che ha prodotto l'immagine non
// è quella build: è una revisione nuova (variabili, promozione a mano, Terraform) sulla stessa immagine.
const SCARTO_REVISIONE_MS = 15 * 60_000
const FALLITI = new Set(['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'])

// Il titolo del canvas porta l'ambiente: il canale lo dice già, ma un canvas aperto da un link o dalla
// ricerca si legge da solo. Senza emoji, nei titoli come nelle sezioni: i quadrati colorati davanti
// (🟥 🟨, e ⏰ 📊 per le schede trasversali) a chi guarda il canale non piacevano (05/10/2026), e le
// emoji restano dove dicono qualcosa, cioè sullo STATO di una riga. I canvas e le List nati coi titoli
// vecchi si riconoscono lo stesso (`stessoTitolo`) e si rinominano sul posto al primo giro.
export const AMBIENTI = {
  produzione: { titolo: 'Quadro deploy PRODUZIONE', tag: 'PROD', sezione: 'Produzione' },
  staging: { titolo: 'Quadro deploy STAGING', tag: 'STAGING', sezione: 'Staging' },
}
// Le schede che attraversano gli ambienti, una sezione per ambiente dentro.
export const TITOLO_CRON = 'Quadro deploy CRON'
export const titoloSquadra = (s) => `Quadro deploy ${String(s).toUpperCase()}`

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
    liste: !/^(0|no|false|off)$/i.test(String(env.DADAGUARD_QUADRO_LISTE ?? '').trim()),
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
  // Una per una, per la tabella: lì ogni Lambda ha la SUA riga, perché un giro (`lottiLambda`) dipende
  // da chi ha rilasciato quando, e una riga che nasce e muore con i giri non avrebbe una cella fissa.
  const una = (l) => ({ tipo: 'lambda', chiave, nomi: [l.nome], n: 1, da: l.da, quando: l.da, chi: chiLeggibile(l.chi) })

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
    lambdaTutte: lambda.map(una),
    lambdaCronTutte: lambdaCron.map(una),
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

// Un ambiente diviso nelle schede: la PRINCIPALE, CRON e una per ogni squadra. Puro/testabile.
//   squadra    un'applicazione o un'immagine condivisa il cui repository (sorgente della build o repo
//              dell'immagine) è di quella squadra: vince su tutto, perché è la domanda «di chi è»
//   cron       le Lambda col nome da cron e le immagini condivise fatte di soli cron
//   principale tutto il resto, con l'IaC, i componenti esterni e le Lambda dell'infrastruttura
// Ogni parte ha la stessa forma dell'ambiente intero, quindi si rende con le stesse funzioni.
export function dividi(qa, { squadre = {} } = {}) {
  if (!qa) return null
  const vuoto = () => ({ ...qa, app: [], immagini: [], esterni: [], lambda: [], lambdaSenzaData: 0, lambdaTutte: [], infra: null })
  const principale = {
    ...vuoto(),
    esterni: qa.esterni ?? [],
    lambda: qa.lambda ?? [],
    lambdaSenzaData: qa.lambdaSenzaData ?? 0,
    lambdaTutte: qa.lambdaTutte ?? [],
    infra: qa.infra ?? null,
  }
  const cron = { ...vuoto(), lambda: qa.lambdaCron ?? [], lambdaSenzaData: qa.lambdaCronSenzaData ?? 0, lambdaTutte: qa.lambdaCronTutte ?? [] }
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
// Un tag che non è un commit (`latest`) resta testo: un link a `/commit/latest` porta a un 404.
const sha = (c, repo) => (c ? (repo && tagDiCommit(c) ? `[${c}](${repo}/commit/${c})` : `\`${c}\``) : '`?`')
const linkCommit = (c, repo) => (c && repo && tagDiCommit(c) ? { url: `${repo}/commit/${c}`, nome: c } : null)
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

// Una «voce» del quadro: dove va (`adesso` o `recente`), quanto pesa, e cosa dire (emoji e nome,
// stato, dettagli). È la forma degli allarmi nel canale; la tabella ha la sua, `rigaRisorsa`.
// Puro/testabile.
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
// conteggio del resto. La tabella non li usa più (ha tutte le righe, vedi `righeTabella`): servono
// alla sintesi, la riga che si legge per prima, e agli allarmi nel canale. Puro/testabile.
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
  // ❌ e non 🔴 per il rotto: accanto al quadrato rosso che il titolo aveva un cerchio rosso si confondeva.
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

// ── La tabella stabile ───────────────────────────────────────────────────────────────────────────
//
// Gli stati di una riga, gli stessi nel canvas e nella List (dove sono le scelte della colonna Stato,
// con questi `value`: cambiarne uno vuol dire una List nuova, perché le scelte si fissano alla
// creazione). I primi sei sono quelli del canale dei rilasci; `giu` e `indietro` sono i due «da
// guardare» che il quadro diceva già prima, e toglierli avrebbe nascosto un servizio giù dietro un 🚀.
export const STATI = {
  test_avviati: { emoji: '🧪', etichetta: 'test', colore: 'blue' },
  test_falliti: { emoji: '❌', etichetta: 'test KO', colore: 'red' },
  deploy_avviato: { emoji: '⏳', etichetta: 'in corso', colore: 'yellow' },
  deploy_ok: { emoji: '🚀', etichetta: 'OK', colore: 'green' },
  deploy_fallito: { emoji: '❌', etichetta: 'fallito', colore: 'red' },
  giu: { emoji: '🚨', etichetta: 'giù', colore: 'red' },
  indietro: { emoji: '⚠️', etichetta: 'indietro', colore: 'yellow' },
  invariato: { emoji: '➖', etichetta: 'fermo', colore: 'gray' },
}
// Le etichette sono CORTE apposta: nella List la colonna Stato è stretta e Slack non la allarga, e
// «⏳ deploy avviato» usciva come «⏳ deploy a…» (05/10/2026). Cosa è partito o fallito (build,
// apply, riavvio) lo dicono i Dettagli; l'etichetta dice solo a che punto è.
export const INTESTAZIONE = ['Risorsa', 'Stato', 'Versione', 'Dettagli']
// Una cella vuota non si scrive: la List rifiuta un testo di zero caratteri, e un `replace` vuoto nel
// canvas lascerebbe una cella che non si distingue da una non letta. Dove non c'è niente da dire, questo.
const VUOTO = 'n/d'
// Il motivo di un fallimento nella List: tagliato corto, il resto è nel canvas e nel log.
const MOTIVO_BREVE = 60

// Quando, corto e fisso: «oggi 10:40», «ieri 22:05», «03/10 19:05». Come `alle`, cambia solo a
// mezzanotte e non ogni minuto, quindi non riscrive celle per niente; più corto, perché sta nella
// cella dello Stato accanto all'etichetta. Puro.
export function quandoBreve(iso, ora = Date.now()) {
  if (!iso) return null
  const fmt = (d, o) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', ...o }).format(d)
  const giorno = (d) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const d = new Date(iso)
  const ore = fmt(d, { hour: '2-digit', minute: '2-digit' })
  if (giorno(d) === giorno(new Date(ora))) return `oggi ${ore}`
  if (giorno(d) === giorno(new Date(ora - 86_400_000))) return `ieri ${ore}`
  return `${fmt(d, { day: '2-digit', month: '2-digit' })} ${ore}`
}

// I test di GitHub Actions su una riga: `test: { stato: 'in_corso' | 'fallito', da, url }`, dai run
// del repository della riga (vedi `applicaTest` in server/notify/github.js).
// I test contano solo se sono PIÙ RECENTI dell'ultimo cambio e la riga è ferma (🚀 o ➖): un deploy in
// corso o fallito dice di più, e un test di ieri non racconta il rilascio di oggi. Puro/testabile.
export function conTest(riga, test, { ora = Date.now() } = {}) {
  if (!test?.da || !['deploy_ok', 'invariato'].includes(riga.stato) || tempo(test.da) <= tempo(riga.quando)) return riga
  const stato = test.stato === 'fallito' ? 'test_falliti' : 'test_avviati'
  const run = test.url ? `[run dei test](${test.url})` : null
  return { ...riga, stato, quando: test.da, quandoTesto: quandoBreve(test.da, ora), suffisso: null, dettagli: [run, ...riga.dettagli], breve: [run, ...(riga.breve ?? riga.dettagli)] }
}

// Una risorsa diventa una RIGA della tabella: stato (una chiave di `STATI`), versione, dettagli, e
// le quattro celle già pronte per il canvas. La List usa gli stessi campi. Puro/testabile.
export function rigaRisorsa(v, { ora = Date.now(), url = null, ore = DEFAULT_ORE } = {}) {
  // Un rilascio resta 🚀 per `ore` ore, poi la riga diventa ➖: è l'unico cambio che l'orologio fa.
  const fermo = (quando) => (quando && tempo(quando) >= ora - ore * 3_600_000 ? 'deploy_ok' : 'invariato')
  let r
  if (v.tipo === 'app') r = rigaDiApp(v, fermo, ora)
  else if (v.tipo === 'immagine') {
    const quanti = [v.servizi.length && plurale(v.servizi.length, 'servizio', 'servizi'), v.cron.length && `${v.cron.length} cron`].filter(Boolean).join(' e ')
    const tutti = [...v.servizi, ...v.cron]
    const stato = v.giu.length ? 'giu' : v.indietro.length ? 'indietro' : v.inRollout ? 'deploy_avviato' : fermo(v.quando)
    r = {
      nome: v.nome,
      stato,
      quando: v.quando,
      suffisso: stato === 'giu' ? elenco(v.giu, 4) : stato === 'indietro' ? `${v.indietro.length} di ${tutti.length}` : null,
      versione: `\`${v.tag ?? '?'}\``,
      dettagli: [
        `immagine su ${quanti}`,
        v.indietro.length && v.indietro.map((x) => `${x.nome} su \`${x.tag ?? '?'}\``).join(', '),
        v.chi && `registrata ${daChi(v.chi)}`,
        elenco(tutti),
      ],
      breve: [`immagine su ${quanti}`, v.indietro.length && v.indietro.map((x) => x.nome).join(', ')],
    }
  } else if (v.tipo === 'esterno')
    r = {
      nome: v.nome,
      stato: v.giu ? 'giu' : v.inRollout ? 'deploy_avviato' : fermo(v.quando),
      quando: v.quando,
      versione: `\`${v.tag ?? '?'}\``,
      // Chi l'ha cambiato si dice solo se non è l'IaC stessa: «fissata dall'IaC, dall'IaC» non informa.
      dettagli: ['componente esterno, versione fissata dall’IaC', v.nomi.length > 1 && `su ${elenco(v.nomi)}`, !daIac(v.chi) && daChi(v.chi)],
      breve: ['componente esterno'],
    }
  else if (v.tipo === 'lambda')
    // Una Lambda dice di sé solo quando è stata aggiornata e da chi: niente versione, niente «in corso».
    r = { nome: v.nomi[0], stato: fermo(v.quando), quando: v.quando, versione: VUOTO, dettagli: [v.quando ? daChi(v.chi) : 'data di rilascio non letta'] }
  else if (v.tipo === 'iac') {
    const stato = v.stato === 'in_corso' ? 'deploy_avviato' : v.stato === 'fallito' ? 'deploy_fallito' : fermo(v.quando)
    r = {
      nome: 'IaC',
      stato,
      quando: v.quando,
      versione: v.commit ? sha(v.commit, v.repo) : VUOTO,
      versioneLink: linkCommit(v.commit, v.repo),
      dettagli: [
        v.numero && `build #${v.numero}${v.stato === 'ok' && durata(v.durataMs) ? ` in ${durata(v.durataMs)}` : ''}`,
        v.fase && `fase ${v.fase}`,
        v.stato === 'in_corso' && durata(v.durataTipica) && `di solito ${durata(v.durataTipica)}`,
        v.chi && `di ${v.chi}`,
        v.motivo && `motivo: ${tronca(v.motivo, 140)}`,
        v.log && `[log della build](${v.log})`,
      ],
      breve: [v.numero && `build #${v.numero}`, v.motivo ? tronca(v.motivo, MOTIVO_BREVE) : v.chi && `di ${v.chi}`],
    }
  } else return null
  r = conTest({ suffisso: null, versioneLink: null, ...r, quandoTesto: quandoBreve(r.quando, ora) }, v.test, { ora })
  const s = STATI[r.stato]
  const link = linkRisorsa(v, url)
  const dettagli = r.dettagli.filter(Boolean).join(SEP) || VUOTO
  return {
    ...r,
    link,
    dettagli,
    // I dettagli della List: le due cose che contano, perché lì la colonna è stretta e il resto si
    // perdeva fuori dallo schermo. Il canvas ha tutto.
    breve: (r.breve ?? r.dettagli).filter(Boolean).join(SEP) || VUOTO,
    celle: [
      cella(link ? `[**${r.nome}**](${link})` : `**${r.nome}**`),
      cella([`${s.emoji} ${s.etichetta}`, r.quandoTesto, r.suffisso].filter(Boolean).join(SEP)),
      cella(r.versione || VUOTO),
      cella(dettagli),
    ],
  }
}

// La riga di un'applicazione: la parte più ricca, perché ECS e CodeBuild insieme sanno cosa gira, cosa
// sta partendo e cosa è fallito. La Versione è sempre quello che GIRA: un tentativo in corso o fallito
// sta nei Dettagli, con «verso» o «tentava». Puro.
function rigaDiApp(a, fermo, ora) {
  const c = sha(a.commit, a.repo)
  const rev = a.revisione ? `rev ${a.revisione}` : null
  const salute = [a.task && `${a.task} task`, a.target && `${a.target} target sani`].filter(Boolean).join(', ') || null
  const t = a.tentativo
  const base = { nome: a.servizio, versione: a.commit ? c : VUOTO, versioneLink: linkCommit(a.commit, a.repo) }
  if (a.stato === 'giu')
    return {
      ...base,
      stato: 'giu',
      quando: null,
      suffisso: `${a.task ?? '?'} task attivi`,
      dettagli: [rev, a.target && `${a.target} target sani`, a.quando && `ultimo cambio ${quandoBreve(a.quando, ora)}`],
      breve: [`${a.task ?? '?'} task attivi`, a.target && `${a.target} target sani`],
    }
  if (a.stato === 'fallito') {
    const motivo = t.motivo && `motivo: ${tronca(t.motivo, 140)}`
    const motivoBreve = t.motivo && tronca(t.motivo, MOTIVO_BREVE)
    const riavvio = `riavvio a mano${t.chi ? ` ${daChi(t.chi)}` : ''}`
    if (t.riavvio) return { ...base, stato: 'deploy_fallito', quando: t.da, dettagli: [riavvio, motivo, rev], breve: [riavvio, motivoBreve] }
    return {
      ...base,
      stato: 'deploy_fallito',
      quando: t.da,
      breve: [`build${t.numero ? ` #${t.numero}` : ''}${t.fase ? `, fase ${t.fase}` : ''}`, motivoBreve ?? (t.chi && `di ${t.chi}`)],
      dettagli: [
        `build${t.numero ? ` #${t.numero}` : ''}${t.fase ? ` fallita al ${t.fase}` : ' fallita'}`,
        t.commit && !stessoCommit(t.commit, a.commit) && `tentava ${sha(t.commit, a.repo)}`,
        t.chi && `di ${t.chi}`,
        motivo,
        t.log && `[log della build](${t.log})`,
        a.commit ? `gira ancora ${c}` : 'nessun rilascio riuscito visto',
      ],
    }
  }
  if (a.stato === 'in_corso') {
    if (t)
      return {
        ...base,
        stato: 'deploy_avviato',
        quando: t.da,
        breve: [`build${t.numero ? ` #${t.numero}` : ''}${t.fase ? `, fase ${t.fase}` : ''}`, t.chi && `di ${t.chi}`],
        dettagli: [
          `build${t.numero ? ` #${t.numero}` : ''}${t.fase ? `, fase ${t.fase}` : ''}`,
          t.commit && !stessoCommit(t.commit, a.commit) && `verso ${sha(t.commit, a.repo)}`,
          t.chi && `di ${t.chi}`,
          durata(a.durataTipica) && `di solito ${durata(a.durataTipica)}`,
          salute,
        ],
      }
    return { ...base, stato: 'deploy_avviato', quando: a.quando, dettagli: ['rollout ECS', rev, salute, comeTesto(a.come)], breve: ['rollout ECS', salute] }
  }
  return {
    ...base,
    stato: fermo(a.quando),
    quando: a.quando,
    dettagli: [rev, salute, comeTesto(a.come), a.autore && `commit di ${a.autore}`, a.staging && `staging su \`${a.staging}\``],
    breve: [comeBreve(a.come), a.autore && `di ${a.autore}`],
  }
}

// Come è arrivato, in due parole, per la List: «build #661», «riavvio», «hotfix #12». Puro.
function comeBreve(c) {
  if (!c) return null
  if (c.tipo === 'riavvio') return `riavvio${c.chi ? ` ${daChi(c.chi)}` : ''}`
  if (c.tipo === 'revisione') return c.build ? `revisione, build #${c.build}` : 'revisione a mano'
  return `${c.tipo === 'hotfix' ? 'hotfix' : 'build'} #${c.build ?? '?'}`
}

// L'ordine delle righe: alfabetico, senza badare alle maiuscole (`IaC` fra `frontend` e `tenders`), e
// a parità il confronto esatto, perché due giri devono dare lo stesso ordine sempre.
const perNome = (a, b) => a.nome.localeCompare(b.nome, 'it', { sensitivity: 'base', numeric: true }) || (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0)

// Tutte le righe di una parte del quadro, in ordine alfabetico per nome: l'ordine non dipende da cosa
// succede, quindi una riga resta dov'era e cambiano solo le sue celle. Puro/testabile.
export function righeTabella(q, opts = {}) {
  const voci = [...(q.app ?? []), ...(q.immagini ?? []), ...(q.esterni ?? []), ...(q.lambdaTutte ?? []), ...(q.infra ? [q.infra] : [])]
  return voci
    .map((v) => rigaRisorsa(v, opts))
    .filter(Boolean)
    .sort(perNome)
}

// Le sezioni di un ambiente: sintesi, tabella e una riga in fondo. Puro.
//
// La forma è FISSA, perché è quella che `pianoCelle` si aspetta di rileggere nel canvas: un titolo, un
// paragrafo di sintesi, la tabella con tutte le righe, il fondo. Quello che va e viene (le build non
// lette, i servizi diversi da staging) cambia il TESTO di un paragrafo che c'è sempre, non aggiunge
// paragrafi: un paragrafo in più è una struttura diversa, e una struttura diversa vuol dire riscrivere
// il canvas intero, cioè lo sdoppio.
function sezioniAmbiente(q, { ora = Date.now(), url = null, ore = DEFAULT_ORE, liste = {} } = {}) {
  const meta = AMBIENTI[q.ambiente] ?? { titolo: `Quadro deploy ${String(q.ambiente).toUpperCase()}`, tag: String(q.ambiente).toUpperCase(), sezione: String(q.ambiente) }
  const { sintesi, diversi } = smista(q, { ora, url, ore })
  const tuttiDeploy = url && q.chiave ? `${url}/deploy?account=${encodeURIComponent(q.chiave)}` : null
  const tuttiServizi = url && q.chiave ? `${url}/servizi?account=${encodeURIComponent(q.chiave)}` : null

  // I filtri: link alla pagina di Dadaguard già filtrata. Quello sui servizi diversi da staging apre i
  // deploy di quei servizi nei due ambienti insieme, cioè il confronto che serve.
  const link = [
    tuttiDeploy && `[Deploy ${meta.tag}](${tuttiDeploy})`,
    tuttiServizi && `[Servizi ${meta.tag}](${tuttiServizi})`,
    url && diversi.length && `[${diversi.length} diversi da staging](${url}/deploy?service=${encodeURIComponent(diversi.map((r) => r.servizio).join(','))})`,
  ].filter(Boolean)
  const ignote =
    q.buildIgnote &&
    `⚠️ **Build non lette**${q.erroreBuild ? `: ${cella(tronca(q.erroreBuild, 200))}` : ''}. Quello che gira lo dice ECS, ma commit, autori e build in corso o fallite mancano finché non tornano leggibili.`
  // La List dell'ambiente, per prima: il segnalibro che la appunta al canale finisce in una cartella
  // dove non la trova nessuno, e una scheda per una List l'API non la crea (vedi `creaLista`).
  const lista = liste[q.ambiente] && `[Lista ${meta.tag}](${liste[q.ambiente]})`
  const fondo = [ignote, lista, link.length && `Dadaguard: ${link.join(SEP)}`].filter(Boolean).join('  |  ') || null
  return { meta, sintesi, righe: righeTabella(q, { ora, url, ore }), fondo }
}

// Ogni scheda ha la STESSA forma, che contenga un ambiente (PROD, STAGING) o tutti e due (CRON,
// una squadra): per ogni ambiente il suo titolo, la sintesi, la tabella e una riga in fondo. Due forme
// diverse per le schede a uno e a due ambienti obbligavano a reimparare il canvas a ogni scheda.
// Niente «aggiornato alle»: cambierebbe ogni minuto e riscriverebbe una cella per niente (vedi
// `alle`); che il quadro sia vivo lo garantisce la guardia dei 10 minuti.
// Oltre al markdown (per crearlo o riscriverlo intero) restituisce il MODELLO, lo stesso contenuto
// blocco per blocco, che `pianoCelle` confronta con quello che legge nel canvas. Puro/testabile.
export function canvasSezioni(titolo, perAmbiente = [], { ora = Date.now(), url = null, ore = DEFAULT_ORE, liste = {} } = {}) {
  const parti = []
  const sintesi = []
  const sezioni = []
  for (const q of perAmbiente) {
    const s = sezioniAmbiente(q, { ora, url, ore, liste })
    const sezione = { titolo: s.meta.sezione, sintesi: `**${s.sintesi.join(SEP)}**`, righe: s.righe.map((r) => r.celle), fondo: s.fondo }
    sezioni.push(sezione)
    parti.push(`## ${sezione.titolo}`, sezione.sintesi)
    // Senza righe niente tabella: un'intestazione senza righe non dice niente.
    if (sezione.righe.length) parti.push([`| ${INTESTAZIONE.join(' | ')} |`, `|${INTESTAZIONE.map(() => '---').join('|')}|`, ...sezione.righe.map((c) => `| ${c.join(' | ')} |`)].join('\n'))
    if (sezione.fondo) parti.push(sezione.fondo)
    sintesi.push(perAmbiente.length > 1 ? `${s.meta.tag}: ${s.sintesi.join(SEP)}` : s.sintesi.join(SEP))
  }
  return { titolo, markdown: parti.join('\n\n'), sintesi: sintesi.join(' | '), modello: { sezioni } }
}

// La scheda di un ambiente. Puro/testabile.
export function canvasQuadro(q, opts = {}) {
  const meta = AMBIENTI[q.ambiente] ?? { titolo: `Quadro deploy ${String(q.ambiente).toUpperCase()}` }
  return canvasSezioni(meta.titolo, [q], opts)
}

// La scheda che attraversa gli ambienti (CRON, una squadra). Puro/testabile.
export const canvasTrasversale = (titolo, perAmbiente = [], opts = {}) => canvasSezioni(titolo, perAmbiente, opts)

// Tutti i canvas di un giro, ognuno col suo canale: uno per ambiente, poi CRON e uno per squadra.
// Le schede trasversali vanno nel canale del PRIMO ambiente: sono una sola per tutti e due, e quando
// i due ambienti hanno lo stesso canale stanno accanto alle loro. Puro/testabile.
// `liste`: ambiente → indirizzo della sua List, per il link in fondo.
export function canvasDaScrivere(q, cfg, { ora = Date.now(), liste = {} } = {}) {
  const opts = { ora, url: cfg.publicUrl ?? null, ore: cfg.ore ?? DEFAULT_ORE, liste }
  const parti = Object.fromEntries(cfg.ambienti.map((a) => [a, dividi(q[a], { squadre: cfg.squadre ?? {} })]))
  const presenti = cfg.ambienti.filter((a) => parti[a])
  const out = presenti.map((a) => ({ chiave: a, canale: cfg.canali?.[a] ?? null, ...canvasQuadro(parti[a].principale, opts) }))
  const canaleTrasversale = cfg.canali?.[cfg.ambienti.find((a) => cfg.canali?.[a])] ?? null
  const trasversale = (chiave, titolo, scegli) => ({ chiave, canale: canaleTrasversale, ...canvasTrasversale(titolo, presenti.map((a) => scegli(parti[a])), opts) })
  out.push(trasversale('cron', TITOLO_CRON, (p) => p.cron))
  for (const sq of Object.keys(cfg.squadre ?? {})) out.push(trasversale(sq, titoloSquadra(sq), (p) => p.squadre[sq]))
  return out
}

// Il titolo della List di un ambiente: quello del canvas, con «Lista» al posto di «Quadro».
export const titoloLista = (ambiente) => (AMBIENTI[ambiente]?.titolo ?? `Quadro deploy ${String(ambiente).toUpperCase()}`).replace('Quadro deploy', 'Lista deploy')

// Le righe della List di ogni ambiente: TUTTE le risorse dell'ambiente, di tutte le schede (principale,
// CRON, squadre), perché una List si filtra e si ordina da sé e una per scheda sarebbe solo più
// liste da cercare. Va nel canale dell'ambiente. Puro/testabile.
export function listeDaScrivere(q, cfg, { ora = Date.now() } = {}) {
  const opts = { ora, url: cfg.publicUrl ?? null, ore: cfg.ore ?? DEFAULT_ORE }
  return cfg.ambienti
    .filter((a) => q[a] && AMBIENTI[a])
    .map((a) => {
      const p = dividi(q[a], { squadre: cfg.squadre ?? {} })
      const righe = [p.principale, p.cron, ...Object.values(p.squadre)].flatMap((x) => righeTabella(x, opts)).sort(perNome)
      return { chiave: a, canale: cfg.canali?.[a] ?? null, titolo: titoloLista(a), righe }
    })
}

// ── La parte che parla con Slack ──────────────────────────────────────────────────────────────────

// I metodi di sola lettura vogliono i parametri nell'indirizzo, gli altri accettano JSON.
// ⚠️ `files.info` in POST JSON risponde `invalid_arguments`: vuole la query string.
const GET = new Set(['auth.test', 'conversations.info', 'files.info', 'files.list'])

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

// Il contenuto di un file di Slack (il canvas, in HTML), con lo stesso token: `url_private_download`
// non è pubblico.
export async function scaricaSlack(url, token, { timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`slack file: HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

// Lo stesso titolo, con o senza un'emoji davanti, da una parte o dall'altra: Slack la ricopia come
// codice nell'etichetta di una scheda e nel titolo di un file (`:large_red_square: Quadro deploy
// PRODUZIONE`), e i titoli fino al 05/10/2026 l'avevano (🟥, 🟨, ⏰, 📊). È così che i canvas e le
// List di prima si ritrovano invece di crearne di nuovi. Puro/testabile.
const senzaEmoji = (t) =>
  String(t ?? '')
    .trim()
    .replace(/^(?::[a-z0-9_+-]+:|\p{Extended_Pictographic}\uFE0F?)\s*/u, '')
    .trim()
export const stessoTitolo = (etichetta, titolo) => Boolean(senzaEmoji(titolo)) && senzaEmoji(etichetta) === senzaEmoji(titolo)

// Il NOSTRO canvas fra quelli del canale. Puro/testabile.
//
// ⚠️ Non sta in `properties.canvas`, che resta vuoto: i canvas di un canale sono SCHEDE
// (`properties.tabs`, tipo `canvas`), un canale ne può avere più d'una, e crearne un'altra non dà errore.
// Cercandolo in `properties.canvas`, il 04/10/2026 il primo giro di prova ne ha creato uno e il secondo
// un altro, accanto: senza fermarlo sarebbe stato un canvas nuovo al minuto.
// Il nostro si riconosce dal titolo (`stessoTitolo`). Se ce n'è più d'uno vince il più recente, e gli
// altri si dicono, non si cancellano.
export function canvasDelCanale(info, titolo) {
  const nostri = (info?.channel?.properties?.tabs ?? [])
    .filter((t) => t?.type === 'canvas' && t.data?.file_id && stessoTitolo(t.label, titolo))
    .sort((a, b) => Number(b.data.shared_ts ?? 0) - Number(a.data.shared_ts ?? 0))
  return { id: nostri[0]?.data.file_id ?? null, doppioni: nostri.slice(1).map((t) => t.data.file_id) }
}

// ── Le celle del canvas ──────────────────────────────────────────────────────────────────────────
//
// Il canvas si legge com'è ADESSO, dall'HTML che Slack restituisce per il file (`files.info`, poi
// `url_private_download`), e non da una copia in memoria: è l'unico modo di avere gli id dei blocchi,
// che Slack assegna lui e cambia a ogni riscrittura completa, e di sapere cosa c'è scritto davvero
// dopo un riavvio di Dadaguard. La forma, vista il 05/10/2026:
//   <div class="quip-canvas-content"><h1 id="temp:C:…">titolo</h1><h2 id=…>Produzione</h2>
//   <p id=… class="line"><b>sintesi</b></p><table><tr><td><p id=… class="line">cella</p></td>…</tr>…
//   </table><p id=… class="line">fondo</p>…</div>
// Ogni cella ha il suo paragrafo con un id, e quello si riscrive con `canvases.edit` + `section_id`.
// La `<table>` invece NON ha id: non si può né cancellare né rifare a pezzi, per questo la sua forma
// (righe e colonne) non cambia mai se non riscrivendo tutto.

const ENTITA = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decodifica = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITA[e.toLowerCase()] ?? m),
  )
// Il testo di un pezzo di HTML del canvas, senza tag. Puro.
export const testoHtml = (html) => decodifica(String(html ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
// Il testo che il markdown di una cella mostra: i link diventano il loro testo, via grassetto, codice e
// l'escape di `|`. È anche il testo delle celle della List. Puro.
export const testoPiatto = (md) =>
  String(md ?? '')
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\\\|/g, '|')
    .replace(/\s+/g, ' ')
    .trim()
// Per il confronto si tolgono anche `_` e `*`: un `_x_` arrivato da fuori (il motivo di un fallimento)
// diventa corsivo nel canvas e sparisce dal testo, e senza questo la cella sembrerebbe cambiata a
// ogni giro.
const confrontabile = (t) => String(t).replace(/[_*`]/g, '').replace(/\s+/g, ' ').trim()

// I blocchi del canvas, nell'ordine: titoli, paragrafi e tabelle (con le celle). Puro/testabile.
export function leggiCanvasHtml(html) {
  const blocchi = []
  const re = /<(h[1-6]|p)\b([^>]*)>([\s\S]*?)<\/\1>|<table\b[^>]*>([\s\S]*?)<\/table>/g
  const idDi = (attr) => /\bid="([^"]*)"/.exec(attr ?? '')?.[1] ?? null
  for (const m of String(html ?? '').matchAll(re)) {
    if (m[1]) {
      blocchi.push({ tipo: m[1], id: idDi(m[2]), testo: testoHtml(m[3]) })
      continue
    }
    const righe = [...m[4].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) =>
      [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((td) => ({ id: idDi(/<p\b([^>]*)>/.exec(td[1])?.[1]), testo: testoHtml(td[1]) })),
    )
    blocchi.push({ tipo: 'table', righe })
  }
  return blocchi
}

// Cosa riscrivere di un canvas, confrontando il MODELLO (`canvasSezioni`) con i blocchi letti. Esce
// l'elenco delle celle e dei paragrafi da riscrivere, uno per id; o `null` quando la forma non torna
// (sezioni, righe, colonne o nomi diversi, cioè una risorsa nuova o sparita), e lì l'unica strada è
// riscrivere tutto. I nomi della prima colonna si confrontano e non si riscrivono mai (vedi in testa).
// Il titolo del canvas (`h1`) e i paragrafi vuoti non contano. Puro/testabile.
export function pianoCelle(modello, blocchi) {
  const b = blocchi.filter((x) => x.tipo !== 'h1' && !(x.tipo === 'p' && !x.testo))
  const uguale = (md, testo) => confrontabile(testoPiatto(md)) === confrontabile(testo)
  const modifiche = []
  const cambia = (blocco, markdown) => {
    if (!blocco.id) return false
    if (!uguale(markdown, blocco.testo)) modifiche.push({ id: blocco.id, markdown })
    return true
  }
  let i = 0
  for (const s of modello?.sezioni ?? []) {
    const h = b[i++]
    if (h?.tipo !== 'h2' || !uguale(s.titolo, h.testo)) return null
    const p = b[i++]
    if (p?.tipo !== 'p' || !cambia(p, s.sintesi)) return null
    if (s.righe.length) {
      const t = b[i++]
      if (t?.tipo !== 'table' || t.righe.length !== s.righe.length + 1) return null
      if (t.righe[0].length !== INTESTAZIONE.length || t.righe[0].some((c, k) => !uguale(INTESTAZIONE[k], c.testo))) return null
      for (const [j, celle] of s.righe.entries()) {
        const viste = t.righe[j + 1]
        if (viste.length !== celle.length || !uguale(celle[0], viste[0].testo)) return null
        for (let k = 1; k < celle.length; k++) if (!cambia(viste[k], celle[k])) return null
      }
    }
    if (s.fondo) {
      const f = b[i++]
      if (f?.tipo !== 'p' || !cambia(f, s.fondo)) return null
    }
  }
  return i === b.length ? modifiche : null
}

// Un giro: per ogni canvas col suo canale, lo aggiorna (cella per cella, o intero se la forma è
// cambiata) o lo crea se non c'è; poi la List di ogni ambiente.
// `deps` per le prove: `leggiDati` ({ deploys, servizi }), `api` (la Web API), `scarica` (il contenuto
// di un file), `ultimi` e `liste` (la memoria fra un giro e l'altro), `maxModifiche`.
// Un canvas che fallisce non ferma gli altri: sono canali diversi, e il guasto di uno non è una ragione
// per lasciare vecchio il quadro dell'altro.
export async function aggiornaQuadri(cfg, deps = {}) {
  const api = deps.api ?? ((m, c) => chiamaSlack(m, c, cfg.token))
  const scarica = deps.scarica ?? ((url) => scaricaSlack(url, cfg.token))
  const dati = await deps.leggiDati()
  const ora = deps.ora ?? Date.now()
  const q = quadro({ ...dati, persone: deps.persone ?? null }, cfg.ambienti)
  // Lo stato dei test non ferma mai il giro (`leggi` non lancia): senza GitHub il quadro dice tutto
  // il resto, come prima che ci fosse.
  if (deps.github) applicaTest(q, await deps.github.leggi(repoDelQuadro(q, { org: deps.github.org ?? null }), { ora }))
  // Le schede di un canale si chiedono una volta per giro: i canvas sono più d'uno nello stesso canale.
  const infoDi = new Map()
  const info = async (canale) => {
    if (!infoDi.has(canale)) infoDi.set(canale, await api('conversations.info', { channel: canale }))
    return infoDi.get(canale)
  }
  const leggiHtml = async (id) => {
    const f = await api('files.info', { file: id })
    const url = f?.file?.url_private_download ?? f?.file?.url_private
    if (!url) throw new Error('files.info senza indirizzo del contenuto')
    return scarica(url)
  }
  // Prima le List e poi i canvas: il canvas di un ambiente porta in fondo il link alla sua List, e
  // l'indirizzo si sa solo dopo averla ritrovata o creata.
  const esitiListe = []
  const linkListe = {}
  if (cfg.liste) {
    const memoria = deps.liste ?? nuovaMemoriaListe()
    for (const l of listeDaScrivere(q, cfg, { ora })) {
      if (!l.canale) continue
      try {
        memoria.bot ??= (await api('auth.test', {})).user_id
        const e = await sincronizzaLista(api, l, memoria.ambienti, { bot: memoria.bot })
        if (e.permalink) linkListe[l.chiave] = e.permalink
        esitiListe.push({ ambiente: `lista-${l.chiave}`, ...e })
      } catch (err) {
        // Al giro dopo si riparte dal ritrovarla: una List cancellata a mano, o righe tolte da qualcuno,
        // non si aggiustano insistendo con gli id che si avevano.
        memoria.ambienti.delete(l.chiave)
        esitiListe.push({ ambiente: `lista-${l.chiave}`, azione: 'errore', errore: err.message })
      }
    }
  }
  // L'ultimo markdown con cui il canvas è stato allineato: uguale vuol dire niente da fare, senza
  // nemmeno rileggerlo. Con un giro ogni 15 secondi rileggere sempre sarebbero due chiamate a canvas
  // per niente.
  const ultimi = deps.ultimi ?? new Map()
  // I canvas di cui si è già controllato il titolo, in questo processo: uno nato col titolo di prima si
  // rinomina una volta, al primo giro in cui lo si incontra.
  const titoli = deps.titoli ?? new Set()
  let budget = deps.maxModifiche ?? MAX_MODIFICHE_GIRO
  const esiti = []
  for (const c of canvasDaScrivere(q, cfg, { ora, liste: linkListe })) {
    if (!c.canale) continue
    // Gli allarmi dipendono dai DATI di un ambiente, non dal canvas: si calcolano prima, così un
    // canvas che non si riesce a scrivere non tace anche un servizio giù.
    const allarmi = AMBIENTI[c.chiave] ? { allarmi: datiAllarmi(q[c.chiave], { ora, url: cfg.publicUrl, ore: cfg.ore }) } : {}
    try {
      const document_content = { type: 'markdown', markdown: c.markdown }
      const { id, doppioni } = canvasDelCanale(await info(c.canale), c.titolo)
      if (doppioni.length) log.warn('quadro: il canale ha più canvas con lo stesso titolo, aggiorno il più recente', { canvas: c.chiave, doppioni })
      // `ultimi` dice già che quel canvas è stato allineato in questo processo, quindi controllato.
      if (id && !titoli.has(id) && !ultimi.has(id)) {
        // Rinominato sul posto, non ricreato: chi l'ha nei preferiti o ne ha il link lo ritrova. ⚠️
        // L'etichetta della SCHEDA del canale non segue il rename (provato il 05/10/2026: resta quella
        // di quando il canvas è stato condiviso), e un'API per cambiarla non c'è.
        const attuale = (await api('files.info', { file: id }))?.file?.title
        if (attuale !== c.titolo) await api('canvases.edit', { canvas_id: id, changes: [{ operation: 'rename', title_content: { type: 'markdown', markdown: c.titolo } }] })
        titoli.add(id)
      }
      if (id && ultimi.get(id) === c.markdown) {
        esiti.push({ ambiente: c.chiave, azione: 'invariato', canvas: id, ...allarmi })
        continue
      }
      if (!id) {
        const r = await api('conversations.canvases.create', { channel_id: c.canale, title: c.titolo, document_content })
        // In sola lettura per il canale: una modifica a mano sparirebbe al giro dopo, senza dirlo a chi
        // l'ha fatta. Se non riesce il quadro funziona lo stesso, quindi lo si dice e si va avanti.
        await api('canvases.access.set', { canvas_id: r.canvas_id, access_level: 'read', channel_ids: [c.canale] }).catch((err) =>
          log.warn('quadro: canvas non messo in sola lettura', { canvas: c.chiave, err: err.message }),
        )
        ultimi.set(r.canvas_id, c.markdown)
        esiti.push({ ambiente: c.chiave, azione: 'creato', canvas: r.canvas_id, ...allarmi })
        continue
      }
      // Un canvas che non si riesce a leggere si riscrive intero, come prima di questa lettura: meglio
      // lo sdoppio nel client aperto che un quadro fermo.
      const piano = await leggiHtml(id)
        .then((html) => pianoCelle(c.modello, leggiCanvasHtml(html)))
        .catch((err) => {
          log.warn('quadro: canvas non letto, lo riscrivo intero', { canvas: c.chiave, err: err.message })
          return null
        })
      if (!piano) {
        // `replace` senza sezione riscrive il canvas intero: la forma è cambiata, e la tabella non ha
        // un id con cui rifarla da sola.
        await api('canvases.edit', { canvas_id: id, changes: [{ operation: 'replace', document_content }] })
        ultimi.set(id, c.markdown)
        esiti.push({ ambiente: c.chiave, azione: 'riscritto', canvas: id, ...allarmi })
        continue
      }
      const adesso = piano.slice(0, Math.max(0, budget))
      for (const m of adesso) {
        // Una modifica per chiamata: `canvases.edit` ne accetta una sola.
        await api('canvases.edit', { canvas_id: id, changes: [{ operation: 'replace', section_id: m.id, document_content: { type: 'markdown', markdown: m.markdown } }] })
        budget--
      }
      const restano = piano.length - adesso.length
      // Allineato solo se è stato scritto tutto: quello che avanza, il giro dopo lo ritrova rileggendo.
      if (!restano) ultimi.set(id, c.markdown)
      esiti.push({ ambiente: c.chiave, azione: piano.length ? 'celle' : 'invariato', canvas: id, celle: adesso.length, restano, ...allarmi })
    } catch (err) {
      esiti.push({ ambiente: c.chiave, azione: 'errore', errore: err.message, ...allarmi })
    }
  }
  return [...esiti, ...esitiListe]
}

// ── La Slack List ────────────────────────────────────────────────────────────────────────────────
//
// Le stesse righe del canvas, una List per ambiente nel suo canale, in sola lettura per il canale e
// con un segnalibro in cima. A differenza del canvas una List si aggiorna per CELLA con una chiamata
// sola (`slackLists.items.update`, fino a 100 celle), si filtra e si ordina: c'è chi la preferisce,
// e i dev scelgono. Provato in un canale di prova il 05/10/2026: creazione, righe, celle, accesso, segnalibro.
//
// Dopo un riavvio di Dadaguard la List NON si ricrea: sarebbe lo stesso guaio già pagato coi canvas
// (`canvasDelCanale`), una List nuova a ogni rilascio di Dadaguard. Si ritrova fra i file del bot
// (`files.list` con `types=lists`, scope `files:read`) dal titolo e dal canale; colonne e righe si
// rileggono da lì (`files.info` per lo schema, `slackLists.items.list` per le righe, per nome nella
// colonna Risorsa). `bookmarks.list` sarebbe la strada diretta, ma vuole `bookmarks:read`, che
// l'app non ha.

// L'ordine delle colonne è quello della creazione e l'API non lo cambia (né lo cambia la larghezza:
// le viste di una List non hanno un metodo per scriverle, provato il 05/10/2026). Quindi Dettagli sta
// PRIMA di Versione, dove la si legge senza scorrere, e Versione è un TESTO con dentro il link al
// commit, non una colonna di tipo link: una cella link vuota (un'immagine, una Lambda, senza commit)
// mostrava comunque l'icona del link, vuota.
export const SCHEMA_LISTA = [
  { key: 'risorsa', name: 'Risorsa', type: 'text', is_primary_column: true },
  {
    key: 'stato',
    name: 'Stato',
    type: 'select',
    options: { format: 'single_select', choices: Object.entries(STATI).map(([value, s]) => ({ value, label: `${s.emoji} ${s.etichetta}`, color: s.colore })) },
  },
  { key: 'quando', name: 'Quando', type: 'text' },
  { key: 'dettagli', name: 'Dettagli', type: 'text' },
  { key: 'versione', name: 'Versione', type: 'text' },
  { key: 'dadaguard', name: 'Dadaguard', type: 'link' },
]
const TIPO_COLONNA = Object.fromEntries(SCHEMA_LISTA.map((c) => [c.key, c.type]))

export const nuovaMemoriaListe = () => ({ bot: null, ambienti: new Map() })

// ⚠️ Un testo vuoto la List lo rifiuta (`must be more than 0 characters`): per svuotare una cella si
// manda l'elenco vuoto, sia per il testo sia per il link (provato il 05/10/2026).
const testoLista = (t) => ({ rich_text: t ? [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: t }] }] }] : [] })
// Un testo che è un link (`text` torna il testo del link, provato il 05/10/2026).
const testoConLink = (url, t) => ({ rich_text: url ? [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url, text: t }] }] }] : [] })
const linkLista = (url, nome) => ({ link: url ? [{ original_url: url, display_as_url: false, display_name: nome }] : [] })

// Le celle di una riga per la List: per ogni colonna la FIRMA (una stringa da confrontare con quella
// riletta, vedi `firmeDaItem`) e il valore da mandare. `tipi` sono quelli della List com'è: una List
// nata prima del 05/10/2026 ha Versione di tipo link, e lì si scrive un link. Puro/testabile.
export function celleLista(r, tipi = TIPO_COLONNA) {
  const dettagli = testoPiatto(r.breve ?? r.dettagli)
  const v = r.versioneLink
  return {
    risorsa: { firma: r.nome, valore: testoLista(r.nome) },
    stato: { firma: r.stato, valore: { select: [r.stato] } },
    quando: { firma: r.quandoTesto ?? '', valore: testoLista(r.quandoTesto) },
    dettagli: { firma: dettagli, valore: testoLista(dettagli) },
    versione:
      tipi.versione === 'link'
        ? { firma: v ? `${v.url}|${v.nome}` : '', valore: linkLista(v?.url, v?.nome) }
        : { firma: v?.nome ?? '', valore: testoConLink(v?.url, v?.nome) },
    dadaguard: { firma: r.link ? `${r.link}|apri` : '', valore: linkLista(r.link, 'apri') },
  }
}

// Le firme di una riga com'è nella List (`slackLists.items.list`), nella stessa forma di `celleLista`.
// Il link torna in camelCase (`originalUrl`, `displayName`) anche se si scrive in snake_case. Puro.
export function firmeDaItem(item, colonne, tipi = TIPO_COLONNA) {
  const perColonna = new Map((item?.fields ?? []).map((f) => [f.column_id, f]))
  return Object.fromEntries(
    Object.entries(colonne).map(([key, col]) => {
      const f = perColonna.get(col)
      if (!f) return [key, '']
      if (tipi[key] === 'select') return [key, f.select?.[0] ?? '']
      if (tipi[key] === 'link') {
        const l = f.link?.[0]
        return [key, l ? `${l.originalUrl ?? l.original_url ?? ''}|${l.displayName ?? l.display_name ?? ''}` : '']
      }
      return [key, f.text ?? '']
    }),
  )
}

const colonneDa = (schema) => Object.fromEntries((schema ?? []).filter((c) => c?.key && c?.id).map((c) => [c.key, c.id]))
const tipiDa = (schema) => Object.fromEntries((schema ?? []).filter((c) => c?.key).map((c) => [c.key, c.type]))

// Una List nata con lo schema di prima: etichette lunghe nella colonna Stato, Versione di tipo link,
// colonne in un altro ordine. ⚠️ Lo schema di una List esistente l'API NON lo cambia: `slackLists.update`
// con `schema` risponde ok e lascia tutto com'era (provato il 05/10/2026), e per colonne e viste non
// c'è un metodo. Quindi una List vecchia si continua a usare (le scelte hanno gli stessi valori) e lo
// si dice nel log: per averla nuova la si cancella a mano in Slack, e al giro dopo il quadro ne crea
// una. Il quadro non la ricrea da sé: non può cancellare la vecchia (servirebbe `files:write`), e due
// List con lo stesso titolo nel canale sarebbero peggio di una con le etichette lunghe. Puro.
export function listaVecchia(schema) {
  const stato = (schema ?? []).find((c) => c.key === 'stato')
  const etichette = Object.fromEntries((stato?.options?.choices ?? []).map((c) => [c.value, c.label]))
  const attese = SCHEMA_LISTA.find((c) => c.key === 'stato').options.choices
  return attese.some((c) => etichette[c.value] !== c.label) || SCHEMA_LISTA.map((c) => c.key).join() !== (schema ?? []).map((c) => c.key).join() || tipiDa(schema).versione !== TIPO_COLONNA.versione
}

// La List di un ambiente com'è nella memoria: id, colonne (chiave → id), tipi, indirizzo e righe (nome
// → id e firme). `null` se il bot non ne ha una con quel titolo in quel canale. Una List col titolo
// giusto ma mai condivisa con nessun canale vale come ripiego: è quella di un giro morto prima di
// condividerla. Un titolo di prima (con l'emoji davanti) si riconosce e si corregge sul posto.
export async function ritrovaLista(api, l, { bot }) {
  const r = await api('files.list', { user: bot, types: 'lists', count: 100 })
  const conTitolo = (r.files ?? []).filter((f) => stessoTitolo(f.title ?? f.name, l.titolo)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
  const nelCanale = (f) => [...(f.channels ?? []), ...(f.groups ?? [])].includes(l.canale)
  const f = conTitolo.find(nelCanale) ?? conTitolo.find((x) => !x.channels?.length && !x.groups?.length)
  if (!f) return null
  const info = (await api('files.info', { file: f.id })).file
  const schema = info?.list_metadata?.schema
  const colonne = colonneDa(schema)
  // Una List col titolo giusto ma senza le nostre colonne non è nostra: scriverci darebbe
  // `invalid_arguments` a ogni giro.
  const mancano = SCHEMA_LISTA.filter((c) => !colonne[c.key]).map((c) => c.key)
  if (mancano.length) {
    log.warn('quadro: la List trovata non ha le colonne attese, ne creo una nuova', { lista: f.id, mancano })
    return null
  }
  if (listaVecchia(schema))
    log.warn('quadro: la List ha lo schema di prima (etichette lunghe, colonne in altro ordine); per averla nuova cancellala a mano, al giro dopo se ne crea una', { lista: f.id, titolo: l.titolo })
  if ((f.title ?? f.name) !== l.titolo)
    await api('slackLists.update', { id: f.id, name: l.titolo }).catch((err) => log.warn('quadro: List non rinominata', { lista: f.id, err: err.message }))
  const tipi = tipiDa(schema)
  const righe = new Map()
  const doppie = []
  let cursor = null
  for (let pagina = 0; pagina < 50; pagina++) {
    const it = await api('slackLists.items.list', { list_id: f.id, limit: 100, ...(cursor ? { cursor } : {}) })
    for (const item of it.items ?? []) {
      const firme = firmeDaItem(item, colonne, tipi)
      // Due righe con lo stesso nome (un giro morto fra la creazione e la memoria): una si tiene, l'altra
      // si toglie, o la List mostrerebbe la stessa risorsa due volte con due stati.
      if (!firme.risorsa || righe.has(firme.risorsa)) doppie.push(item.id)
      else righe.set(firme.risorsa, { id: item.id, firme })
    }
    cursor = it.response_metadata?.next_cursor || null
    if (!cursor) break
  }
  return { id: f.id, colonne, tipi, permalink: info?.permalink ?? null, righe, doppie }
}

// Una List nuova: creata, messa in sola lettura per il canale (come il canvas: una modifica a mano
// sparirebbe al giro dopo), e appuntata nel canale con un segnalibro. Accesso e segnalibro, se non
// riescono, si dicono e basta: la List funziona lo stesso.
// ⚠️ Il segnalibro NON è una scheda: Slack lo mette nella cartella dei segnalibri, dove nessuno lo
// trova (05/10/2026), e un'API per aggiungere una List come scheda del canale, come si fa coi canvas,
// non c'è. Per questo il link alla List sta anche in fondo al canvas del suo ambiente.
export async function creaLista(api, l) {
  const r = await api('slackLists.create', { name: l.titolo, schema: SCHEMA_LISTA })
  await api('slackLists.access.set', { list_id: r.list_id, access_level: 'read', channel_ids: [l.canale] }).catch((err) =>
    log.warn('quadro: List non messa in sola lettura', { lista: l.chiave, err: err.message }),
  )
  const info = await api('files.info', { file: r.list_id }).catch(() => null)
  let schema = r.list_metadata?.schema
  if (SCHEMA_LISTA.some((c) => !colonneDa(schema)[c.key])) schema = info?.file?.list_metadata?.schema
  if (info?.file?.permalink)
    await api('bookmarks.add', { channel_id: l.canale, title: l.titolo, type: 'link', link: info.file.permalink, emoji: ':clipboard:' }).catch((err) =>
      log.warn('quadro: segnalibro della List non aggiunto', { lista: l.chiave, err: err.message }),
    )
  return { id: r.list_id, colonne: colonneDa(schema), tipi: tipiDa(schema), permalink: info?.file?.permalink ?? null, righe: new Map(), doppie: [] }
}

// Allinea la List di un ambiente alle sue righe: la ritrova o la crea, poi toglie le righe sparite (e
// le doppie), crea le nuove (al massimo `maxNuove` per giro) e riscrive le sole celle cambiate, cento
// per chiamata. Il confronto è con le firme in memoria, rilette dalla List dopo un riavvio: un giro
// in cui non cambia niente non chiama niente.
export async function sincronizzaLista(api, l, memoria, { bot, maxNuove = MAX_RIGHE_NUOVE_GIRO } = {}) {
  // Senza righe non si tocca niente: un ambiente vuoto è quasi sempre una lettura andata male, e
  // allinearsi vorrebbe dire cancellare tutte le righe per ricrearle al giro dopo.
  if (!l.righe.length) return { azione: 'invariato' }
  let st = memoria.get(l.chiave)
  let creata = false
  if (!st) {
    st = await ritrovaLista(api, l, { bot })
    if (!st) {
      st = await creaLista(api, l)
      creata = true
    }
    memoria.set(l.chiave, st)
  }
  const voluti = new Map()
  for (const r of l.righe) if (!voluti.has(r.nome)) voluti.set(r.nome, celleLista(r, st.tipi ?? TIPO_COLONNA))
  let tolte = 0
  for (const id of st.doppie ?? []) {
    await api('slackLists.items.delete', { list_id: st.id, id })
    tolte++
  }
  st.doppie = []
  for (const [nome, riga] of st.righe) {
    if (voluti.has(nome)) continue
    await api('slackLists.items.delete', { list_id: st.id, id: riga.id })
    st.righe.delete(nome)
    tolte++
  }
  let nuove = 0
  let restano = 0
  for (const [nome, celle] of voluti) {
    if (st.righe.has(nome)) continue
    if (nuove >= maxNuove) {
      restano++
      continue
    }
    const initial_fields = Object.entries(celle)
      .filter(([, c]) => c.firma)
      .map(([key, c]) => ({ column_id: st.colonne[key], ...c.valore }))
    const r = await api('slackLists.items.create', { list_id: st.id, initial_fields })
    st.righe.set(nome, { id: r.item.id, firme: Object.fromEntries(Object.entries(celle).map(([key, c]) => [key, c.firma])) })
    nuove++
  }
  const cambiate = []
  for (const [nome, celle] of voluti) {
    const riga = st.righe.get(nome)
    if (riga) for (const [key, c] of Object.entries(celle)) if (riga.firme[key] !== c.firma) cambiate.push({ riga, key, c })
  }
  for (let i = 0; i < cambiate.length; i += 100) {
    const blocco = cambiate.slice(i, i + 100)
    await api('slackLists.items.update', { list_id: st.id, cells: blocco.map(({ riga, key, c }) => ({ row_id: riga.id, column_id: st.colonne[key], ...c.valore })) })
    for (const { riga, key, c } of blocco) riga.firme[key] = c.firma
  }
  const azione = creata ? 'creata' : nuove || tolte || cambiate.length ? 'aggiornata' : 'invariato'
  return { azione, lista: st.id, permalink: st.permalink ?? null, nuove, celle: cambiate.length, tolte, restano }
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
    // Solo i RILASCI rotti (gravità 1: build, apply o riavvio falliti). Un servizio giù (gravità 0)
    // è un allarme del watchdog, che lo scrive già nel canale degli allarmi: ripeterlo qui era un
    // doppione (05/10/2026). Nel canvas resta, in cima.
    rotti: adesso.filter((x) => x.gravita === 1).map((x) => ({ nome: x.nome, firma: `${x.emoji}|${x.quando ?? ''}`, testo: testoAllarme(x, qa.ambiente) })),
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
// La List di un ambiente ha la sua guardia (`lista-produzione`): si dice «la List», non «il canvas».
export function testoAvviso(a, { ora = Date.now(), url = null } = {}) {
  const lista = String(a.ambiente).startsWith('lista-')
  const amb = lista ? String(a.ambiente).slice('lista-'.length) : a.ambiente
  const tag = `${lista ? 'LISTA ' : ''}${AMBIENTI[amb]?.tag ?? String(amb).toUpperCase()}`
  if (a.tipo === 'rientrato') return `✅ \`quadro deploy\` [${tag}] rientrato · di nuovo aggiornato dopo ${eta(a.fermoDa, ora)} fermo`
  const link = url ? `${SEP}<${url}/deploy|deploy su Dadaguard>` : ''
  return `⚠️ \`quadro deploy\` [${tag}] FERMO · ${lista ? 'la List' : 'il canvas'} non si aggiorna da ${eta(a.fermoDa, ora)}${SEP}ultimo errore: ${tronca(a.errore ?? 'sconosciuto', 200)}${link}`
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
  const ultimi = new Map() // canvas → ultimo markdown con cui è allineato
  const liste = nuovaMemoriaListe() // ambiente → List, colonne e righe: si riempie al primo giro
  // Lo stato dei test da GitHub Actions: senza le credenziali dell'App le righe non ne hanno, e lo si
  // dice qui, una volta, invece che a ogni giro.
  const github = nuovoGithub(githubConfig(env))
  if (!github) log.warn('quadro: nessuna GitHub App (DADAGUARD_GITHUB_APP_ID e DADAGUARD_GITHUB_APP_KEY), righe senza stato dei test')
  // Un giro alla volta. Il primo, a cache fredde, dura più dell'intervallo (26 secondi misurati contro
  // 15): due giri insieme cercherebbero lo stesso canvas, non lo troverebbero tutti e due e ne
  // creerebbero due, cioè il doppione che il giro di prova del 04/10/2026 ha già fatto una volta.
  let inCorso = false
  const giro = () =>
    // `people` si rilegge a ogni giro, come la config del resto: un alias aggiunto vale dal giro dopo.
    aggiornaQuadri(cfg, { leggiDati, persone: loadConfig().people ?? null, ultimi, liste, github })
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
