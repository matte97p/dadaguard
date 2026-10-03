import { log } from '../log.js'
import { ambienteDi } from '../rilasci.js'
import { canonicalActor } from '../util/principal.js'
import { stripOrgEnv } from '../util/envToken.js'
import { loadConfig } from '../config.js'

// Il QUADRO dei deploy: un messaggio Slack per ambiente, fissato in cima al canale e RISCRITTO a ogni
// giro, al posto del registro in cui ogni build lascia due messaggi (`⏳` all'avvio, `🚀`/`🔴` alla
// fine) e ogni revisione registrata da un automatismo ne lascia uno. In un giorno normale il canale
// dei rilasci ne riceve un centinaio, e la domanda vera («cosa gira adesso, e c'è qualcosa di rotto?»)
// si risponde leggendo all'indietro. Il quadro la risponde in un colpo d'occhio, come la vista delle
// applicazioni in un controller GitOps.
//
// La verità su COSA GIRA la dice ECS, non CodeBuild: è l'unica fonte che vede tutte le strade per cui
// un servizio cambia (la build della CI, una revisione promossa a mano, un riavvio, la revisione
// registrata da un automatismo, un apply Terraform sulla task definition). CodeBuild aggiunge quello
// che ECS non sa: il commit, chi l'ha scritto, la build in corso o fallita. Un servizio senza ECS (un
// frontend statico) resta sulla sola CodeBuild.
//
// Cosa il quadro copre del canale, e cosa no:
//   ⏳ 🚀 🔴 deploy da CodeBuild                  righe delle applicazioni
//   ⏳ revisione promossa a mano, riavvii, SSM    cambio di revisione o rollout, visto da ECS
//   🔄 revisione nuova da un automatismo          una riga per IMMAGINE condivisa, non una per servizio
//   ⏳ 🚀 ➖ apply dell'infrastruttura             riga IaC
//   🧪 test avviati, deploy saltato o non avviato  NO: vivono in GitHub Actions, che Dadaguard non legge
//
// ⚠️ Un messaggio RISCRITTO non manda notifiche: è il suo pregio (niente rumore) e il suo limite. Un
// fallimento che deve svegliare qualcuno resta un messaggio NUOVO, e non è compito del quadro.
//
// Zero storage, come il resto: il messaggio da riscrivere non si ricorda, si RITROVA fra quelli
// fissati nel canale (scritto da noi, con l'ambiente nei metadati o nel testo). Il filesystem del task
// è effimero, e un `ts` salvato lì si perderebbe a ogni rilascio di Dadaguard stessa.
//
// Configurazione (tutta opzionale: senza token o canale il quadro non parte e non chiama niente):
//   DADAGUARD_SLACK_BOT_TOKEN      token `xoxb-` di un'app Slack con `chat:write`, `pins:read`,
//                                  `pins:write`. Un webhook NON basta: non modifica un messaggio mandato
//   DADAGUARD_QUADRO_CANALE        id del canale (`C0123…`), non il nome: le API vogliono l'id
//   DADAGUARD_QUADRO_AMBIENTI      quali ambienti e in che ordine (default `produzione,staging`)
//   DADAGUARD_QUADRO_INTERVAL      secondi fra i giri (default 60: un deploy dura ~4 minuti, e a 300 un
//                                  rilascio intero passerebbe senza che il quadro lo veda in corso)
//   DADAGUARD_QUADRO_FERMI_GIORNI  oltre quanti giorni un servizio fermo e sano si riassume in una
//                                  riga in fondo invece di occupare la sua (default 7)

const DEFAULT_INTERVAL_S = 60
const DEFAULT_FERMI_GIORNI = 7
const EVENTO = 'dadaguard_quadro'
const FALLITI = new Set(['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'])

// Come si riconosce l'ambiente senza leggere: la BARRA colorata a sinistra del messaggio (rossa la
// produzione, gialla lo staging) e il titolo grande con un quadrato dello stesso colore. Il tag
// `[PROD]` delle notifiche resta nel testo di ripiego, che è quello delle notifiche e dei lettori di
// schermo.
export const AMBIENTI = {
  produzione: { titolo: '🟥  PRODUZIONE', tag: 'PROD', colore: '#E01E5A' },
  staging: { titolo: '🟨  STAGING', tag: 'STAGING', colore: '#ECB22E' },
}

export function quadroConfig(env = process.env) {
  const ambienti = (env.DADAGUARD_QUADRO_AMBIENTI || 'produzione,staging')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => AMBIENTI[s])
  const giorni = Number(env.DADAGUARD_QUADRO_FERMI_GIORNI)
  return {
    token: env.DADAGUARD_SLACK_BOT_TOKEN || null,
    canale: env.DADAGUARD_QUADRO_CANALE || null,
    ambienti,
    intervalMs: Math.max(30, Number(env.DADAGUARD_QUADRO_INTERVAL) || DEFAULT_INTERVAL_S) * 1000,
    fermiGiorni: Number.isFinite(giorni) && giorni > 0 ? giorni : DEFAULT_FERMI_GIORNI,
    publicUrl: env.DADAGUARD_PUBLIC_URL || null,
  }
}

const tempo = (x) => new Date(x ?? 0).getTime()
// Il nome come lo dice chi ci lavora: senza `<org>-<env>-` (l'ambiente lo dice già il colore) e senza
// `cron-` (lo dice la sezione). È anche la chiave con cui ECS e CodeBuild si incontrano: il servizio
// ECS si chiama `<org>-<env>-dashboard`, il progetto di deploy dà `dashboard`.
export const nomeBreve = (n = '') => stripOrgEnv(String(n)).replace(/^cron-/, '') || n
// Un tag che è un commit è un'immagine NOSTRA, costruita dalla CI; uno che è una versione
// (`v2.195.0`, `18.9.1`, `3.6-python3.12`) è un componente esterno, fissato dall'IaC. Dedotto dal tag,
// senza elenchi di nomi.
export const tagDiCommit = (t) => /^[0-9a-f]{7,40}$/i.test(String(t ?? ''))
const corto = (sha) => (sha && /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : (sha ?? null))
// Due riferimenti allo stesso commit, anche se uno è accorciato a 7 cifre e l'altro a 8.
const stessoCommit = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a))

// Lo stato delle BUILD di un servizio in un ambiente. Tre stati, e la differenza fra il secondo e il
// terzo è quella che il canale di oggi non dice:
//   in_corso  l'ultimo tentativo sta girando
//   fallito   l'ultimo tentativo è fallito DOPO l'ultimo riuscito: gira ancora il commit di prima
//   ok        l'ultimo riuscito è anche l'ultimo tentativo
// Un riavvio a mano non cambia il commit: conta come evento più recente, non come rilascio.
// Puro/testabile.
export function statoBuild(builds = []) {
  const ordinate = [...builds].sort((a, b) => tempo(b.startedAt) - tempo(a.startedAt))
  const ultima = ordinate[0] ?? null
  if (!ultima) return null
  const riuscita = ordinate.find((b) => b.status === 'SUCCEEDED' && b.kind !== 'restart') ?? null
  if (ultima.inProgress || ultima.status === 'IN_PROGRESS') return { stato: 'in_corso', riuscita, ultima }
  if (FALLITI.has(ultima.status) && tempo(ultima.startedAt) >= tempo(riuscita?.startedAt)) return { stato: 'fallito', riuscita, ultima }
  return { stato: 'ok', riuscita, ultima }
}

// Cosa ECS dice di un servizio, dalla stessa lettura che fa la dashboard (nessuna chiamata in più):
// task attivi, rollout in corso, se è giù, e quale immagine gira da quando. Puro.
export function datiEcs(servizio = {}) {
  const runtime = servizio.checks?.runtime ?? null
  const build = servizio.checks?.version?.build ?? null
  return {
    nome: nomeBreve(servizio.name),
    tipo: servizio.type,
    // Solo un SERVIZIO è giù: un cron in rosso ha fallito una corsa, e lo racconta il canale dei cron.
    // Contarlo qui metteva in cima al quadro dei deploy un problema che coi deploy non c'entra.
    giu: servizio.type === 'ecs' && servizio.overall === 'down',
    inRollout: Boolean(runtime?.deploying),
    task: runtime?.desiredCount != null ? `${runtime.runningCount ?? 0}/${runtime.desiredCount}` : null,
    tag: build?.tag ?? null,
    repo: build?.repo ?? null,
    da: build?.deployedAt ?? null,
    chi: build?.by ?? null,
  }
}

// Una riga per applicazione, unendo ECS e CodeBuild per nome. Puro.
function rigaApp(nome, ecs, builds, { persone, chiave }) {
  const b = statoBuild(builds)
  const riuscita = b?.riuscita ?? null
  // Cosa gira: l'immagine in ECS, che per le build della CI è taggata col commit. Senza ECS, l'ultima
  // build riuscita.
  const commit = corto(ecs?.tag) ?? riuscita?.commit ?? null
  // La build che ha prodotto ciò che gira, se si trova: da lì vengono autore e link al commit. Se il
  // commit in ECS non è quello di nessuna build (revisione promossa a mano, riavvio con config nuova),
  // l'autore è chi ha registrato la revisione, che ECS sa.
  const sorgente = builds.find((x) => x.status === 'SUCCEEDED' && stessoCommit(x.commit, commit)) ?? (ecs ? null : riuscita)
  let stato = 'ok'
  if (ecs?.giu) stato = 'giu'
  else if (b?.stato === 'in_corso' || ecs?.inRollout) stato = 'in_corso'
  else if (b?.stato === 'fallito') stato = 'fallito'
  const tentativo = stato === 'in_corso' || stato === 'fallito' ? (b?.ultima ?? null) : null
  return {
    servizio: nome,
    chiave,
    stato,
    commit,
    repo: sorgente?.repo ?? riuscita?.repo ?? null,
    quando: ecs?.da ?? riuscita?.startedAt ?? null,
    chi: canonicalActor(sorgente?.author ?? ecs?.chi ?? null, persone),
    task: ecs?.task ?? null,
    nuovo: tentativo?.commit ?? null,
    fase: stato === 'fallito' ? (tentativo?.failPhase ?? null) : (tentativo?.phase ?? null),
    tentativoDa: tentativo?.startedAt ?? null,
    log: stato === 'fallito' ? (tentativo?.logsUrl ?? null) : null,
    riavvioFallito: stato === 'fallito' && tentativo?.kind === 'restart',
    esterno: !builds.length && Boolean(ecs?.tag) && !tagDiCommit(ecs.tag),
  }
}

// Il quadro di UN ambiente. Entrano il payload per-account di `/api/deploys` e i servizi di
// `/api/status`: è lo stesso dato delle due pagine, quindi zero chiamate AWS in più. Puro/testabile.
//
// Tre gruppi:
//   app        un servizio ECS o un progetto di deploy: una riga ciascuno
//   immagini   servizi e cron che girano la STESSA immagine senza una build loro (un automatismo
//              registra le revisioni): una riga per immagine, perché nel canale di oggi sono cinque
//              messaggi alla volta, più volte al giorno, per un solo fatto
//   infra      l'ultimo apply dell'infrastruttura
export function quadroAmbiente(ambiente, { deploys = {}, servizi = [], persone = null } = {}) {
  const chiavi = Object.keys(deploys).filter((k) => ambienteDi(k) === ambiente && !deploys[k]?.error)
  const chiave = chiavi[0] ?? Object.keys(deploys).find((k) => ambienteDi(k) === ambiente) ?? null

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

  const ecs = servizi
    .filter((s) => ambienteDi(s.account?.key ?? '') === ambiente && (s.type === 'ecs' || s.type === 'ecs-scheduled'))
    .map(datiEcs)

  // Le immagini condivise: stesso repo su due o più servizi, e NESSUNO di loro ha una build propria.
  // Dedotto dal dato, senza elenchi: un repo nuovo condiviso entra da sé.
  const perRepo = new Map()
  for (const e of ecs) if (e.repo) perRepo.set(e.repo, [...(perRepo.get(e.repo) ?? []), e])
  const immagini = []
  const inImmagine = new Set()
  for (const [repo, lista] of perRepo) {
    if (lista.length < 2 || lista.some((e) => perServizio.has(e.nome))) continue
    lista.forEach((e) => inImmagine.add(e.nome))
    // Il tag più recente è «quello che gira»; chi ne ha un altro è rimasto indietro e si dice per nome.
    const recente = lista.reduce((a, e) => (tempo(e.da) > tempo(a.da) ? e : a), lista[0])
    immagini.push({
      repo,
      tag: corto(recente.tag),
      servizi: lista.filter((e) => e.tipo === 'ecs').map((e) => e.nome).sort(),
      cron: lista.filter((e) => e.tipo === 'ecs-scheduled').map((e) => e.nome).sort(),
      indietro: lista.filter((e) => e.tag !== recente.tag).map((e) => ({ nome: e.nome, tag: corto(e.tag) })),
      quando: recente.da,
      chi: recente.chi ? stripOrgEnv(recente.chi) : null,
      giu: lista.filter((e) => e.giu).map((e) => e.nome),
      inRollout: lista.some((e) => e.inRollout),
      esterno: !tagDiCommit(recente.tag),
    })
  }

  const ecsServizi = new Map(ecs.filter((e) => e.tipo === 'ecs' && !inImmagine.has(e.nome)).map((e) => [e.nome, e]))
  const nomi = [...new Set([...ecsServizi.keys(), ...perServizio.keys()])]
  const app = nomi.map((n) => rigaApp(n, ecsServizi.get(n) ?? null, perServizio.get(n) ?? [], { persone, chiave }))

  const i = statoBuild(iac)
  const infra = i && {
    stato: i.stato,
    commit: (i.stato === 'ok' ? i.riuscita : i.ultima)?.commit ?? null,
    repo: i.ultima?.repo ?? null,
    quando: i.ultima?.startedAt ?? null,
    chi: canonicalActor(i.ultima?.author ?? null, persone),
    log: i.stato === 'fallito' ? (i.ultima?.logsUrl ?? null) : null,
    fase: i.stato === 'fallito' ? (i.ultima?.failPhase ?? null) : null,
  }

  return { ambiente, chiave, app, immagini: immagini.sort((a, b) => a.repo.localeCompare(b.repo)), infra }
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

const SEP = '  ·  '
// Il commit apre la sua pagina su GitHub quando il repository è noto.
const sha = (c, repo) => (c ? (repo ? `<${repo}/commit/${c}|\`${c}\`>` : `\`${c}\``) : '`?`')

// Il nome del servizio porta alla sua pagina Deploy su Dadaguard, già filtrata su servizio e
// ambiente: è lo stesso link che usano le notifiche del canale.
function nomeLink(r, url) {
  if (!url || !r.chiave) return `*${r.servizio}*`
  return `*<${url}/deploy?service=${encodeURIComponent(r.servizio)}&account=${encodeURIComponent(r.chiave)}|${r.servizio}>*`
}

// Una riga per applicazione. I pezzi sono sempre nello stesso ordine, così l'occhio li trova senza
// leggere: stato, nome, COSA GIRA, task, da quanto e chi, poi la nota su staging. Puro/testabile.
export function rigaServizio(r, { ora = Date.now(), url = null } = {}) {
  const nome = nomeLink(r, url)
  const gira = sha(r.commit, r.repo)
  const task = r.task ? `${SEP}${r.task} task` : ''
  if (r.stato === 'giu') return `🚨  ${nome}  *giù*${task}${SEP}gira ${gira}`
  if (r.stato === 'in_corso') {
    const verso = r.nuovo && !stessoCommit(r.nuovo, r.commit) ? ` → ${sha(r.nuovo, r.repo)}` : ''
    const fase = r.fase ? ` (${r.fase})` : ''
    return `⏳  ${nome}  ${gira}${verso}${SEP}in corso da ${eta(r.tentativoDa ?? r.quando, ora)}${fase}${task}`
  }
  if (r.stato === 'fallito') {
    const esito = r.log ? `<${r.log}|fallito>` : 'fallito'
    const cosa = r.riavvioFallito ? `riavvio ${esito}` : `${sha(r.nuovo, r.repo)} ${esito}${r.fase ? ` al ${r.fase}` : ''}`
    // Un rosso da solo fa credere il servizio giù: si dice cosa sta ancora girando.
    const resta = r.commit ? `${SEP}gira ancora ${gira}` : `${SEP}nessun rilascio riuscito visto`
    return `🔴  ${nome}  ${cosa} ${eta(r.tentativoDa, ora)} fa${resta}${task}`
  }
  const chi = r.chi ? `, ${r.chi}` : ''
  const staging = r.staging ? `${SEP}staging su \`${r.staging}\`` : ''
  return `✅  ${nome}  ${gira}${task}${SEP}${eta(r.quando, ora)} fa${chi}${staging}`
}

// Una riga per immagine condivisa, con i nomi di chi la gira sotto in corsivo. Puro/testabile.
export function rigaImmagine(g, { ora = Date.now() } = {}) {
  const emoji = g.giu.length ? '🚨' : g.inRollout ? '⏳' : g.indietro.length ? '⚠️' : '🔄'
  const quanti = [g.servizi.length && `${g.servizi.length} serviz${g.servizi.length === 1 ? 'io' : 'i'}`, g.cron.length && `${g.cron.length} cron`]
    .filter(Boolean)
    .join(' e ')
  const chi = g.chi ? `, ${g.chi}` : ''
  const giu = g.giu.length ? `${SEP}*giù*: ${g.giu.join(', ')}` : ''
  const indietro = g.indietro.length ? `${SEP}ancora su un'altra: ${g.indietro.map((x) => `${x.nome} \`${x.tag ?? '?'}\``).join(', ')}` : ''
  return `${emoji}  *${g.repo}*  \`${g.tag ?? '?'}\` su ${quanti}${SEP}${eta(g.quando, ora)} fa${chi}${giu}${indietro}\n_${[...g.servizi, ...g.cron].join(', ')}_`
}

// La riga dell'infrastruttura. Puro/testabile.
export function rigaInfra(i, { ora = Date.now() } = {}) {
  const c = sha(i.commit, i.repo)
  const chi = i.chi ? `, ${i.chi}` : ''
  if (i.stato === 'in_corso') return `⏳  *IaC*  apply in corso da ${eta(i.quando, ora)}${SEP}${c}${chi}`
  if (i.stato === 'fallito') {
    const esito = i.log ? `<${i.log}|fallito>` : 'fallito'
    return `🔴  *IaC*  apply ${esito}${i.fase ? ` al ${i.fase}` : ''} ${eta(i.quando, ora)} fa${SEP}${c}${chi}`
  }
  return `✅  *IaC*  ultimo apply riuscito ${eta(i.quando, ora)} fa${SEP}${c}${chi}`
}

// Il testo di ripiego (notifiche, anteprima, lettori di schermo) E il marcatore con cui il messaggio
// si ritrova se Slack non restituisce i metadati: per questo comincia sempre con le stesse parole.
export function intestazione(ambiente) {
  return `Quadro deploy [${AMBIENTI[ambiente]?.tag ?? ambiente.toUpperCase()}]`
}

// Titolo e righe in blocchi da al più 2900 caratteri: Slack ne accetta 3000 per blocco di testo e
// rifiuterebbe l'intero messaggio, non solo la riga in più.
function aSezioni(titolo, righe) {
  const out = []
  let corrente = `*${titolo}*`
  for (const r of righe) {
    if (corrente.length + r.length + 1 > 2900) {
      out.push(corrente)
      corrente = ''
    }
    corrente = corrente ? `${corrente}\n${r}` : r
  }
  out.push(corrente)
  return out.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } }))
}

const ORDINE = { giu: 0, fallito: 1, in_corso: 2, ok: 3 }

// Il messaggio Slack di un ambiente. Puro/testabile.
//
// Le scelte di leggibilità, tutte per chi lo apre dal telefono in mezzo ad altro:
//   - l'ambiente si riconosce dal COLORE prima che dalle parole (barra e quadrato nel titolo)
//   - in testa la sintesi: se dice «tutto riuscito», il resto non serve leggerlo
//   - i problemi salgono in cima alla lista, poi i rilasci più recenti
//   - quello che è fermo e sano da giorni si riassume in una riga in fondo: in un quadro, una riga
//     che non cambia mai è rumore
export function messaggioQuadro(q, { ora = Date.now(), url = null, fermiGiorni = DEFAULT_FERMI_GIORNI } = {}) {
  const { ambiente, chiave, app = [], immagini = [], infra = null } = q
  const meta = AMBIENTI[ambiente] ?? { titolo: ambiente.toUpperCase(), tag: ambiente.toUpperCase(), colore: '#868686' }
  const sogliaFermi = ora - fermiGiorni * 86_400_000

  const ordinate = [...app].sort((a, b) => ORDINE[a.stato] - ORDINE[b.stato] || tempo(b.quando) - tempo(a.quando))
  const vecchio = (x) => x && tempo(x) < sogliaFermi
  const fermo = (r) => r.stato === 'ok' && !r.staging && vecchio(r.quando)
  const immagineFerma = (g) => !g.giu.length && !g.inRollout && !g.indietro.length && vecchio(g.quando)
  const nostre = ordinate.filter((r) => !r.esterno)
  const vive = nostre.filter((r) => !fermo(r))
  const immaginiVive = immagini.filter((g) => !g.esterno && !immagineFerma(g))
  const ferme = [
    ...nostre.filter(fermo).map((r) => `${r.servizio} \`${r.commit ?? '?'}\``),
    ...immagini.filter((g) => !g.esterno && immagineFerma(g)).map((g) => `${g.repo} \`${g.tag ?? '?'}\``),
  ]
  // I componenti esterni (versioni fissate dall'IaC: proxy, agenti, orchestratori) cambiano poco e non
  // sono rilasci di nessuno: una riga piccola, dal più recente, col segno solo se c'è da guardare.
  const esterni = [
    ...ordinate.filter((r) => r.esterno).map((r) => ({ nome: r.servizio, tag: r.commit, n: 1, quando: r.quando, giu: r.stato === 'giu', rollout: r.stato === 'in_corso' })),
    ...immagini.filter((g) => g.esterno).map((g) => ({ nome: g.repo, tag: g.tag, n: g.servizi.length + g.cron.length, quando: g.quando, giu: g.giu.length > 0, rollout: g.inRollout })),
  ].sort((x, y) => tempo(y.quando) - tempo(x.quando))

  const problemi =
    app.filter((r) => r.stato === 'giu' || r.stato === 'fallito').length +
    immagini.filter((g) => g.giu.length).length +
    (infra?.stato === 'fallito' ? 1 : 0)
  const inCorso = app.filter((r) => r.stato === 'in_corso').length + immagini.filter((g) => g.inRollout).length + (infra?.stato === 'in_corso' ? 1 : 0)
  const diversi = app.filter((r) => r.staging).length
  const pezzi = [
    problemi && `🔴 ${problemi} da guardare`,
    inCorso && `⏳ ${inCorso} in corso`,
    diversi && `${diversi} su un commit diverso da staging`,
  ].filter(Boolean)
  const sintesi = pezzi.length ? pezzi : ['✅ tutto riuscito, niente in corso']
  const orario = new Date(ora).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })

  const blocchi = [
    { type: 'header', text: { type: 'plain_text', text: meta.titolo, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: [...sintesi, `aggiornato alle ${orario}`].join(SEP) }] },
    { type: 'divider' },
  ]
  if (vive.length) blocchi.push(...aSezioni('Applicazioni', vive.map((r) => rigaServizio(r, { ora, url }))))
  if (immaginiVive.length) blocchi.push(...aSezioni('Immagini condivise', immaginiVive.map((g) => rigaImmagine(g, { ora }))))
  if (infra) blocchi.push(...aSezioni('Infrastruttura', [rigaInfra(infra, { ora })]))
  if (!vive.length && !immaginiVive.length && !infra && !ferme.length && !esterni.length)
    blocchi.push({ type: 'section', text: { type: 'mrkdwn', text: '_nessun deploy trovato in questo ambiente_' } })
  const piccolo = (testo) => blocchi.push({ type: 'context', elements: [{ type: 'mrkdwn', text: testo.slice(0, 2900) }] })
  if (esterni.length) {
    const voce = (e) => `${e.giu ? '🚨 ' : e.rollout ? '⏳ ' : ''}${e.nome} \`${e.tag ?? '?'}\`${e.n > 1 ? ` ×${e.n}` : ''} ${eta(e.quando, ora)}`
    piccolo(`*Componenti esterni*, versione fissata dall'IaC: ${esterni.map(voce).join(SEP)}`)
  }
  if (ferme.length) piccolo(`*Fermi e sani* da più di ${fermiGiorni} giorni: ${ferme.join(', ')}`)
  // I FILTRI: un messaggio Slack non ne ha, quindi i pulsanti aprono la pagina Deploy di Dadaguard
  // già filtrata. Sono link e basta: non serve un endpoint pubblico che riceva i clic.
  if (url && chiave) {
    blocchi.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: `Deploy ${meta.tag} su Dadaguard` }, url: `${url}/deploy?account=${encodeURIComponent(chiave)}` },
        { type: 'button', text: { type: 'plain_text', text: 'Staging e produzione insieme' }, url: `${url}/deploy` },
      ],
    })
  }

  return {
    text: `${intestazione(ambiente)}: ${sintesi.join(' · ')}`,
    // Gli allegati sono l'unico modo di avere la barra colorata: i blocchi stanno dentro.
    attachments: [{ color: meta.colore, blocks: blocchi }],
    metadata: { event_type: EVENTO, event_payload: { ambiente } },
  }
}

// Il link che apre il messaggio nel Block Kit Builder di Slack: l'anteprima di come apparirà, senza
// mandare niente a nessuno. Puro.
export function anteprimaUrl(msg) {
  return `https://app.slack.com/block-kit-builder/#${encodeURIComponent(JSON.stringify({ attachments: msg.attachments }))}`
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
    const msg = messaggioQuadro(q[ambiente], { ora, url: cfg.publicUrl, fermiGiorni: cfg.fermiGiorni })
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
